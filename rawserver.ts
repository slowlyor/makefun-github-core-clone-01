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
    const merged = new Map<string, string>(this.setHeaders);
    if (this.headHeaders !== null) {
      for (const name of Object.keys(this.headHeaders)) merged.set(name.toLowerCase(), this.headHeaders[name]!);
    }
    const parts: string[] = [`HTTP/1.1 ${this.status} ${REASONS[this.status] ?? ''}`];
    for (const [name, value] of merged) parts.push(`${name}: ${value}`);
    parts.push('', '');
    const head = Buffer.from(parts.join('\r\n'), 'ascii');
    // HEAD answers headers only, with the content-length the handler set.
    const out = this.method === 'HEAD' ? head : bodyBuf.length === 0 ? head : Buffer.concat([head, bodyBuf]);
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
}

/** Parse one complete request from `buf`, or null when more bytes are needed. A negative
 *  content-length or an over-cap body is a protocol error the caller answers 400/413 for. */
function parseRequest(buf: Buffer): { request: ParsedRequest } | { needMore: true } | { error: number } {
  const headEnd = buf.indexOf('\r\n\r\n');
  if (headEnd === -1) {
    // A header block larger than 64 KiB without its terminator is not a request we serve.
    if (buf.length > 65_536) return { error: 400 };
    return { needMore: true };
  }
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
  const bodyStart = headEnd + 4;
  const transferEncoding = headers['transfer-encoding'];
  if (transferEncoding !== undefined && transferEncoding.toLowerCase().includes('chunked')) {
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
  const lengthRaw = headers['content-length'];
  const length = lengthRaw === undefined ? 0 : Number(lengthRaw);
  if (!Number.isInteger(length) || length < 0) return { error: 400 };
  if (length > MAX_BODY) return { error: 413 };
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
    const state: ConnState = { buf: Buffer.alloc(0), busy: false, waitDrain: false, destroyed: false, sentContinue: false };
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

    async function dispatch(request: ParsedRequest): Promise<void> {
      const forgeReq: ForgeRequest = {
        method: request.method,
        url: request.target,
        headers: request.headers,
        body: request.body,
      };
      const sink = new RawResponse(sock, request.method, request.closeAfter);
      try {
        await route(store, forgeReq, sink);
      } catch (error: unknown) {
        console.error('request failed:', error);
        if (!sink.headersSent) {
          sink.writeHead(500, { 'content-type': 'application/json; charset=utf-8' });
          sink.end(Buffer.from(JSON.stringify({ message: 'Internal Server Error' }), 'utf8'));
        }
      }
      if (!sink.flushed) state.waitDrain = true;
    }

    async function pump(): Promise<void> {
      if (state.busy || state.destroyed || state.waitDrain) return;
      for (;;) {
        if (state.buf.length === 0 || state.destroyed || state.waitDrain) return;
        const parsed = parseRequest(state.buf);
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
        await dispatch(request);
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
