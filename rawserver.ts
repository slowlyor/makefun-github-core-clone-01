// The raw socket transport: a hand-rolled HTTP/1.1 server over node:net that drives the same
// route() as the node:http adapter. Why: measured on this machine, Node's http stack costs
// ~190 us of server CPU per GET and ~280 us per POST (request parsing, the Readable stream
// machinery for the body, writeHead/end), while the handlers themselves cost ~4-17 us
// (GET/POST issue) — the workloads are sequential round trips, so that stack tax is paid
// once per operation. The same requests through this parser + one sock.write measured
// ~80 us (GET) / ~110 us (POST) of server CPU, saving ~120-170 us per operation.
//
// The suite is the only client and its request shapes are bounded: undici fetch (REST,
// GraphQL, MCP) and its own git client (smart HTTP), all Content-Length bodies, keep-alive,
// no pipelining in the timed workloads (the 50 concurrent clones use separate sockets).
// The parser still handles the general cases it may meet: chunked bodies, Expect:
// 100-continue, Connection: close, HEAD (headers only, body suppressed), and pipelined
// requests dispatched strictly in order.

import { createServer, type Server, type Socket } from 'node:net';
import { route } from './app.ts';
import { REASONS, type ForgeRequest, type ForgeResponse } from './forge.ts';
import { Store } from './store.ts';

/** Bodies larger than this are refused, not buffered. */
const MAX_BODY = 16 * 1024 * 1024;

const CONTINUE_100 = Buffer.from('HTTP/1.1 100 Continue\r\n\r\n', 'ascii');

/** The response sink one request writes into: it collects status/headers/body and emits
 *  exactly one sock.write of head + body when end() is called. */
class RawResponse implements ForgeResponse {
  headersSent = false;
  flushed = true;
  private status = 200;
  private setHeaders = new Map<string, string>();
  private headHeaders: Record<string, string> | null = null;
  private readonly sock: Socket;
  private readonly method: string;
  private readonly closeAfter: boolean;

  constructor(sock: Socket, method: string, closeAfter: boolean) {
    this.sock = sock;
    this.method = method;
    this.closeAfter = closeAfter;
  }

  setHeader(name: string, value: string): void {
    this.setHeaders.set(name.toLowerCase(), value);
  }

  writeHead(status: number, headers: Record<string, string>): void {
    this.status = status;
    this.headHeaders = headers;
  }

  end(body?: Buffer | string): void {
    this.headersSent = true;
    const bodyBuf =
      body === undefined ? Buffer.alloc(0) : typeof body === 'string' ? Buffer.from(body, 'utf8') : body;
    // Build the head by string concatenation, not by merging Maps: the only setHeader
    // entry is x-github-request-id and the writeHead headers never overlap it, so the
    // merged-Map dance (two allocations + iteration + a join) is pure overhead per
    // response. The emitted bytes are identical: setHeader entries first (their stored
    // names are already lowercased), then the writeHead headers lowercased.
    let head = `HTTP/1.1 ${this.status} ${REASONS[this.status] ?? ''}\r\n`;
    this.setHeaders.forEach((value, name) => {
      head += `${name}: ${value}\r\n`;
    });
    if (this.headHeaders !== null) {
      for (const name of Object.keys(this.headHeaders)) head += `${name.toLowerCase()}: ${this.headHeaders[name]}\r\n`;
    }
    head += '\r\n';
    const headBuf = Buffer.from(head, 'ascii');
    // HEAD answers headers only, with the content-length the handler set.
    const out = this.method === 'HEAD' ? headBuf : bodyBuf.length === 0 ? headBuf : Buffer.concat([headBuf, bodyBuf]);
    this.flushed = this.sock.write(out);
    if (this.closeAfter) this.sock.end();
  }
}

interface ParsedRequest {
  method: string;
  target: string;
  headers: Record<string, string | undefined>;
  body: Buffer;
  closeAfter: boolean;
  /** Bytes consumed from the connection buffer. */
  consumed: number;
}

interface ConnState {
  buf: Buffer;
  busy: boolean;
  waitDrain: boolean;
  destroyed: boolean;
  /** Whether a 100 Continue was already sent for the request now being read. */
  sentContinue: boolean;
  /** The last request head parsed on this connection, with its exact bytes: the timed
   *  workloads repeat byte-identical heads thousands of times (same method, target and
   *  headers on one keep-alive connection), so re-running the line scan and header
   *  object build per request is pure overhead. The cached headers object is never
   *  mutated by any handler (they only read authorization/host/git-protocol), so
   *  sharing it across requests on this connection is safe. */
  headCache: { current: { head: Buffer; info: HeadInfo } | null };
}

/** Everything parseRequest needs from a request head: method, target, headers, whether
 *  the body is chunked, and the validated content-length (-1 when the header is absent,
 *  which the body step treats as an empty body). */
interface HeadInfo {
  method: string;
  target: string;
  headers: Record<string, string | undefined>;
  closeAfter: boolean;
  chunked: boolean;
  contentLength: number;
}

/** Parse one request head (request line + header block), or an error status when the
 *  head itself is malformed. Split out of parseRequest so the per-connection cache can
 *  reuse it for byte-identical heads. */
function parseHead(buf: Buffer, headEnd: number): { info: HeadInfo } | { error: number } {
  const headText = buf.subarray(0, headEnd).toString('ascii');
  const firstCrLf = headText.indexOf('\r\n');
  const requestLine = firstCrLf === -1 ? headText : headText.slice(0, firstCrLf);
  const sp1 = requestLine.indexOf(' ');
  const sp2 = sp1 === -1 ? -1 : requestLine.indexOf(' ', sp1 + 1);
  if (sp1 === -1 || sp2 === -1) return { error: 400 };
  const method = requestLine.slice(0, sp1);
  const target = requestLine.slice(sp1 + 1, sp2);
  if (method === '' || target === '') return { error: 400 };
  const headers: Record<string, string | undefined> = {};
  let lineStart = firstCrLf === -1 ? headText.length : firstCrLf + 2;
  while (lineStart < headText.length) {
    const lineEnd = headText.indexOf('\r\n', lineStart);
    const line = lineEnd === -1 ? headText.slice(lineStart) : headText.slice(lineStart, lineEnd);
    const colon = line.indexOf(':');
    if (colon > 0) headers[line.slice(0, colon).trim().toLowerCase()] = line.slice(colon + 1).trim();
    if (lineEnd === -1) break;
    lineStart = lineEnd + 2;
  }
  const connection = headers.connection?.toLowerCase() ?? '';
  const transferEncoding = headers['transfer-encoding'];
  const chunked = transferEncoding !== undefined && transferEncoding.toLowerCase().includes('chunked');
  // A chunked request's content-length (if one is even sent) is ignored, exactly as
  // before: only validate it on the non-chunked path.
  const lengthRaw = headers['content-length'];
  const length = chunked || lengthRaw === undefined ? -1 : Number(lengthRaw);
  if (!chunked && lengthRaw !== undefined && (!Number.isInteger(length) || length < 0)) return { error: 400 };
  if (length > MAX_BODY) return { error: 413 };
  return {
    info: { method, target, headers, closeAfter: connection === 'close', chunked, contentLength: length },
  };
}

/** Parse one complete request from `buf`, or null when more bytes are needed. A negative
 *  content-length or an over-cap body is a protocol error the caller answers 400/413 for.
 *  `cache` is the connection's one-entry head cache (see ConnState.headCache): on a hit
 *  the head scan is skipped entirely and the body is sliced from `buf` directly. */
function parseRequest(
  buf: Buffer,
  cache: { current: { head: Buffer; info: HeadInfo } | null },
): { request: ParsedRequest } | { needMore: true } | { error: number } {
  const headEnd = buf.indexOf('\r\n\r\n');
  if (headEnd === -1) {
    // A header block larger than 64 KiB without its terminator is not a request we serve.
    if (buf.length > 65_536) return { error: 400 };
    return { needMore: true };
  }
  const bodyStart = headEnd + 4;
  let info: HeadInfo;
  const cached = cache.current;
  if (cached !== null && cached.head.length === headEnd && cached.head.equals(buf.subarray(0, headEnd))) {
    info = cached.info;
  } else {
    const parsedHead = parseHead(buf, headEnd);
    if ('error' in parsedHead) return { error: parsedHead.error };
    info = parsedHead.info;
    cache.current = { head: Buffer.from(buf.subarray(0, headEnd)), info };
  }
  const { method, target, headers } = info;
  if (info.chunked) {
    // Chunked body: hex size lines, data, CRLF, a zero size chunk, then trailers to blank.
    const chunks: Buffer[] = [];
    let pos = bodyStart;
    let total = 0;
    for (;;) {
      const lineEnd = buf.indexOf('\r\n', pos);
      if (lineEnd === -1) return { needMore: true };
      const sizeText = buf.subarray(pos, lineEnd).toString('ascii').split(';', 1)[0]!.trim();
      const size = parseInt(sizeText, 16);
      if (!Number.isFinite(size) || size < 0) return { error: 400 };
      if (size === 0) {
        // Trailers are lines until an empty line (usually none: the next two bytes).
        let tpos = lineEnd + 2;
        for (;;) {
          const trailerEnd = buf.indexOf('\r\n', tpos);
          if (trailerEnd === -1) return { needMore: true };
          if (trailerEnd === tpos) {
            return { request: finishChunked(method, target, headers, chunks, trailerEnd + 2) };
          }
          tpos = trailerEnd + 2;
        }
      }
      const dataStart = lineEnd + 2;
      const dataEnd = dataStart + size;
      if (buf.length < dataEnd + 2) return { needMore: true };
      if (buf[dataEnd] !== 0x0d || buf[dataEnd + 1] !== 0x0a) return { error: 400 };
      total += size;
      if (total > MAX_BODY) return { error: 413 };
      chunks.push(buf.subarray(dataStart, dataEnd));
      pos = dataEnd + 2;
    }
  }
  const length = info.contentLength === -1 ? 0 : info.contentLength;
  if (buf.length < bodyStart + length) return { needMore: true };
  const body = length === 0 ? Buffer.alloc(0) : buf.subarray(bodyStart, bodyStart + length);
  return { request: finish(method, target, headers, body, bodyStart + length) };
}

function finishChunked(
  method: string,
  target: string,
  headers: Record<string, string | undefined>,
  chunks: Buffer[],
  consumed: number,
): ParsedRequest {
  return finish(method, target, headers, chunks.length === 1 ? chunks[0]! : Buffer.concat(chunks), consumed);
}

function finish(
  method: string,
  target: string,
  headers: Record<string, string | undefined>,
  body: Buffer,
  consumed: number,
): ParsedRequest {
  const connection = headers.connection?.toLowerCase() ?? '';
  return { method, target, headers, body, closeAfter: connection === 'close', consumed };
}

/** Build the forge's raw socket server (not yet listening — main.ts owns the lifecycle). */
export function createRawServer(store: Store = new Store()): Server {
  const server = createServer((sock: Socket) => {
    sock.setNoDelay(true);
    const state: ConnState = {
      buf: Buffer.alloc(0),
      busy: false,
      waitDrain: false,
      destroyed: false,
      sentContinue: false,
      headCache: { current: null },
    };
    sock.on('error', () => {
      state.destroyed = true;
      sock.destroy();
    });
    sock.on('close', () => {
      state.destroyed = true;
    });
    sock.on('drain', () => {
      state.waitDrain = false;
      void pump();
    });

    // A plain (non-async) function: route() is synchronous for every handler except
    // receive-pack, so dispatch returns void on the common path and pump keeps looping
    // without a microtask hop per request; only the receive-pack promise is awaited.
    function dispatch(request: ParsedRequest): void | Promise<void> {
      const forgeReq: ForgeRequest = {
        method: request.method,
        url: request.target,
        headers: request.headers,
        body: request.body,
      };
      const sink = new RawResponse(sock, request.method, request.closeAfter);
      const send500 = (): void => {
        if (!sink.headersSent) {
          sink.writeHead(500, { 'content-type': 'application/json; charset=utf-8' });
          sink.end(Buffer.from(JSON.stringify({ message: 'Internal Server Error' }), 'utf8'));
        }
      };
      const noteDrain = (): void => {
        if (!sink.flushed) state.waitDrain = true;
      };
      let pending: void | Promise<void>;
      try {
        pending = route(store, forgeReq, sink);
      } catch (error: unknown) {
        console.error('request failed:', error);
        send500();
        noteDrain();
        return;
      }
      if (pending === undefined) {
        noteDrain();
        return;
      }
      return pending.then(
        () => noteDrain(),
        (error: unknown) => {
          console.error('request failed:', error);
          send500();
          noteDrain();
        },
      );
    }

    async function pump(): Promise<void> {
      if (state.busy || state.destroyed || state.waitDrain) return;
      for (;;) {
        if (state.buf.length === 0 || state.destroyed || state.waitDrain) return;
        const parsed = parseRequest(state.buf, state.headCache);
        if ('needMore' in parsed) {
          // Expect: 100-continue is answered once, when the headers are in but the body
          // has not arrived yet; the client then sends the body.
          if (!state.sentContinue) {
            const headEnd = state.buf.indexOf('\r\n\r\n');
            if (headEnd !== -1 && state.buf.subarray(0, headEnd).toString('ascii').toLowerCase().includes('expect: 100-continue')) {
              sock.write(CONTINUE_100);
              state.sentContinue = true;
            }
          }
          return;
        }
        if ('error' in parsed) {
          const status = parsed.error;
          const body = Buffer.from(JSON.stringify({ message: status === 413 ? 'Payload Too Large' : 'Bad Request' }), 'utf8');
          sock.write(
            Buffer.concat([
              Buffer.from(`HTTP/1.1 ${status} ${REASONS[status] ?? ''}\r\ncontent-type: application/json; charset=utf-8\r\ncontent-length: ${body.length}\r\n\r\n`, 'ascii'),
              body,
            ]),
          );
          sock.destroy();
          state.destroyed = true;
          return;
        }
        const request = parsed.request;
        state.buf = state.buf.subarray(request.consumed);
        state.sentContinue = false;
        state.busy = true;
        // dispatch() is synchronous except for receive-pack: only await when it
        // actually returns a promise, so the common path never yields mid-request.
        const pending = dispatch(request);
        if (pending !== undefined) await pending;
        state.busy = false;
        if (state.destroyed || state.waitDrain) return;
      }
    }

    sock.on('data', (chunk: Buffer) => {
      if (state.destroyed) return;
      state.buf = state.buf.length === 0 ? chunk : Buffer.concat([state.buf, chunk]);
      void pump();
    });
  });
  return server;
}
