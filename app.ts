// The HTTP assembly: one server, four surfaces. Routing and the wire discipline that spans
// surfaces live here — /healthz answers without a credential (the environment's boot check),
// every other route requires the bearer token the trial hands the process, and every answer
// carries an X-GitHub-Request-Id.

import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { ForgeHeaders, ForgeRequest, ForgeResponse } from './forge.ts';
import { Store } from './store.ts';
import { handleRest, sendError, type RestRequest } from './rest.ts';
import { handleGraphQL } from './graphql.ts';
import { handleMcp } from './mcp.ts';
import { handleInfoRefs, handleReceivePack, handleUploadPack } from './githttp.ts';

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      // A request body almost always arrives in one chunk (a 1 KiB push pack, a small
      // JSON body): return it directly instead of allocating and copying via concat.
      if (chunks.length === 1) resolve(chunks[0]!);
      else resolve(Buffer.concat(chunks));
    });
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

/** The expected Authorization header value, built once: the token is fixed for the process
 *  lifetime, so rebuilding `Bearer ${token}` (a template allocation) per request is waste. */
let expectedAuth: string | null = null;

function isAuthorized(req: ForgeRequest): boolean {
  if (expectedAuth !== null) return req.headers.authorization === expectedAuth;
  const expected = process.env.MAKEFUN_SHOP_TOKEN ?? '';
  const header = req.headers.authorization ?? '';
  if (expected !== '') {
    expectedAuth = `Bearer ${expected}`;
    return header === expectedAuth;
  }
  return header.startsWith('Bearer ');
}

/** The routing core, transport-neutral: both the node:http adapter and the raw socket
 *  server build a ForgeRequest (body already read) and hand it here with a ForgeResponse.
 *  Kept async only because receive-pack is async; every handler runs synchronously. */
export async function route(store: Store, req: ForgeRequest, res: ForgeResponse): Promise<void> {
  res.setHeader('x-github-request-id', nextRequestId());
  // `new URL(...)` parses (and validates) far more than routing needs: split the raw target
  // on '?' ourselves and build the query table only on the branches that read it.
  const rawUrl = req.url;
  const queryIndex = rawUrl.indexOf('?');
  const path = queryIndex === -1 ? rawUrl : rawUrl.slice(0, queryIndex);
  const queryString = queryIndex === -1 ? '' : rawUrl.slice(queryIndex + 1);
  const method = req.method;
  const body = req.body;

  if (path === '/healthz') {
    const health = Buffer.from(JSON.stringify({ ok: true }), 'utf8');
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'content-length': health.length });
    res.end(health);
    return;
  }

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

/** Build the forge's HTTP server on Node's http stack (not yet listening — main.ts owns
 *  the lifecycle). Kept as the fallback transport: it adapts each IncomingMessage into a
 *  ForgeRequest (body already read) and hands the real ServerResponse through, which
 *  satisfies ForgeResponse structurally. */
export function createApp(store: Store = new Store()): Server {
  const server = createServer((req, res) => {
    void (async () => {
      try {
        const method = req.method ?? 'GET';
        const body = method === 'GET' || method === 'HEAD' ? Buffer.alloc(0) : await readBody(req);
        const headers: ForgeHeaders = {};
        for (const [name, value] of Object.entries(req.headers)) {
          headers[name] = Array.isArray(value) ? value.join(', ') : value;
        }
        const forgeReq: ForgeRequest = { method, url: req.url ?? '/', headers, body };
        await route(store, forgeReq, res as unknown as ForgeResponse);
      } catch (error: unknown) {
        console.error('request failed:', error);
        if (!res.headersSent) sendError(res as unknown as ForgeResponse, 500, 'Internal Server Error');
        else res.end();
      }
    })();
  });
  server.headersTimeout = 60_000;
  server.requestTimeout = 0;
  // The read workload holds one keep-alive connection for 2,000 requests; keep sockets warm
  // well past Node's 5 s default so a pause mid-run never costs a reconnect.
  server.keepAliveTimeout = 75_000;
  return server;
}
