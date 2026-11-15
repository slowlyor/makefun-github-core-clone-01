// The HTTP assembly: one server, four surfaces. Routing and the wire discipline that spans
// surfaces live here — /healthz answers without a credential (the environment's boot check),
// every other route requires the bearer token the trial hands the process, and every answer
// carries an X-GitHub-Request-Id.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { Store } from './store.ts';
import { handleRest, sendError, type RestRequest } from './rest.ts';
import { handleGraphQL } from './graphql.ts';
import { handleMcp } from './mcp.ts';
import { handleInfoRefs, handleReceivePack, handleUploadPack } from './githttp.ts';

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function decodeSegment(segment: string): string {
  // Most segments carry no escapes; decoding them anyway pays a full decodeURIComponent
  // call (and its try/catch) on every request.
  if (!segment.includes('%')) return segment;
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

/** Request ids only have to be non-empty (the protocol checks): a monotonic counter in
 *  hex is unique per process and costs nothing next to randomBytes per request. */
let requestSeq = 0;

function nextRequestId(): string {
  requestSeq += 1;
  return `AF${process.pid.toString(16).toUpperCase()}${requestSeq.toString(16).toUpperCase().padStart(8, '0')}`;
}

function isAuthorized(req: IncomingMessage): boolean {
  const expected = process.env.MAKEFUN_SHOP_TOKEN ?? '';
  const header = req.headers.authorization ?? '';
  if (expected !== '') return header === `Bearer ${expected}`;
  return header.startsWith('Bearer ');
}

async function route(store: Store, req: IncomingMessage, res: ServerResponse): Promise<void> {
  res.setHeader('x-github-request-id', nextRequestId());
  // `new URL(...)` parses (and validates) far more than routing needs: split the raw target
  // on '?' ourselves and build the query table only on the branches that read it.
  const rawUrl = req.url ?? '/';
  const queryIndex = rawUrl.indexOf('?');
  const path = queryIndex === -1 ? rawUrl : rawUrl.slice(0, queryIndex);
  const queryString = queryIndex === -1 ? '' : rawUrl.slice(queryIndex + 1);
  const method = req.method ?? 'GET';

  if (path === '/healthz') {
    const body = Buffer.from(JSON.stringify({ ok: true }), 'utf8');
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'content-length': body.length });
    res.end(body);
    return;
  }

  const body = method === 'GET' || method === 'HEAD' ? Buffer.alloc(0) : await readBody(req);

  if (!isAuthorized(req)) {
    sendError(res, 401, 'Bad credentials');
    return;
  }

  if (path === '/api/graphql') {
    if (method !== 'POST') return sendError(res, 404, 'Not Found');
    handleGraphQL(store, body, res);
    return;
  }

  if (path === '/mcp') {
    if (method !== 'POST') return sendError(res, 405, 'Method Not Allowed');
    handleMcp(store, body, res);
    return;
  }

  if (path === '/api/v3' || path.startsWith('/api/v3/')) {
    const segments = path
      .slice('/api/v3'.length)
      .split('/')
      .filter((segment) => segment !== '')
      .map(decodeSegment);
    const restReq: RestRequest = {
      method,
      segments,
      query: new URLSearchParams(queryString),
      body,
      host: req.headers.host ?? 'localhost',
    };
    handleRest(store, restReq, res);
    return;
  }

  const gitMatch = /^\/([^/]+)\/([^/]+)\.git(?:\/(.*))?$/.exec(path);
  if (gitMatch !== null) {
    const owner = decodeSegment(gitMatch[1]!);
    const name = decodeSegment(gitMatch[2]!);
    const rest = gitMatch[3] ?? '';
    const repo = store.getRepo(owner, name);
    if (repo === null) return sendError(res, 404, 'Not Found');
    if (rest === 'info/refs' && method === 'GET') {
      const service = new URLSearchParams(queryString).get('service') ?? '';
      const protocol = req.headers['git-protocol'] ?? '';
      handleInfoRefs(res, repo, service, protocol.includes('version=2'));
      return;
    }
    if (rest === 'git-upload-pack' && method === 'POST') {
      handleUploadPack(res, repo, body);
      return;
    }
    if (rest === 'git-receive-pack' && method === 'POST') {
      await handleReceivePack(res, repo, body);
      return;
    }
    return sendError(res, 404, 'Not Found');
  }

  return sendError(res, 404, 'Not Found');
}

/** Build the forge's HTTP server (not yet listening — main.ts owns the lifecycle). */
export function createApp(store: Store = new Store()): Server {
  const server = createServer((req, res) => {
    route(store, req, res).catch((error: unknown) => {
      console.error('request failed:', error);
      if (!res.headersSent) sendError(res, 500, 'Internal Server Error');
      else res.end();
    });
  });
  server.headersTimeout = 60_000;
  server.requestTimeout = 0;
  // The read workload holds one keep-alive connection for 2,000 requests; keep sockets warm
  // well past Node's 5 s default so a pause mid-run never costs a reconnect.
  server.keepAliveTimeout = 75_000;
  return server;
}
