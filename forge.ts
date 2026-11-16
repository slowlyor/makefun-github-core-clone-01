// The transport-neutral request/response pair every handler speaks. Both transports —
// Node's http server (createApp) and the hand-rolled raw socket server (rawserver.ts) —
// drive the same route() with these, so a handler never knows which one answered it.
// Only the surface the handlers actually use is here: setHeader, writeHead, end and
// headersSent. A ForgeResponse buffers nothing itself; the raw sink assembles one Buffer
// per response, the http adapter hands the real ServerResponse through (it satisfies
// this interface structurally).

export interface ForgeHeaders {
  [name: string]: string | undefined;
}

export interface ForgeRequest {
  method: string;
  /** The raw request target (path and query, exactly as sent). */
  url: string;
  /** Header values by lowercased name. */
  headers: ForgeHeaders;
  /** The complete request body (empty for GET/HEAD). */
  body: Buffer;
}

export interface ForgeResponse {
  headersSent: boolean;
  setHeader(name: string, value: string): void;
  writeHead(status: number, headers: Record<string, string>): void;
  end(body?: Buffer | string): void;
}

/** Reason phrases for the statuses the forge answers with. */
export const REASONS: Record<number, string> = {
  200: 'OK',
  201: 'Created',
  202: 'Accepted',
  204: 'No Content',
  400: 'Bad Request',
  401: 'Unauthorized',
  404: 'Not Found',
  405: 'Method Not Allowed',
  409: 'Conflict',
  422: 'Unprocessable Entity',
  500: 'Internal Server Error',
};
