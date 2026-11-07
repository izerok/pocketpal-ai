/**
 * Minimal HTTP/1.1 request parsing and response writing for the Local API
 * Server. Pure TypeScript with no React Native imports, so it is testable
 * in plain Jest/Node.
 *
 * Design constraints (v1):
 * - One request per connection; the response always carries
 *   `Connection: close` and the socket is closed after the response.
 * - Bodies are carried by `Content-Length` only. `Transfer-Encoding:
 *   chunked` is rejected with 501 (documented in docs/local-api-server.md).
 * - Bodies are capped at 1 MiB; anything larger is rejected with 413.
 * - No global `Buffer` is used: React Native does not guarantee one, and
 *   request/response bodies here are UTF-8 text (JSON / SSE).
 */

/** UTF-8 byte length of a string without Buffer. */
export function utf8ByteLength(value: string): number {
  return unescape(encodeURIComponent(value)).length;
}

export interface HttpRequest {
  method: string;
  /** Path without the query string, e.g. `/v1/chat/completions`. */
  path: string;
  query: Record<string, string>;
  /** Header names lower-cased. */
  headers: Record<string, string>;
  /** Raw request body (UTF-8 text). */
  body: string;
}

export const MAX_BODY_BYTES = 1024 * 1024;

export type HttpParseOutcome =
  | {kind: 'request'; request: HttpRequest}
  | {kind: 'incomplete'}
  | {kind: 'error'; status: number; message: string};

const HEADER_END = '\r\n\r\n';

/**
 * Incremental parser: feed TCP chunks as they arrive; each call returns
 * every complete request found in the buffered bytes so far. A request
 * whose headers or body have not fully arrived yet yields `incomplete`
 * and is kept in the buffer for the next chunk.
 */
export function createHttpParser(): {
  feed(chunk: string): HttpParseOutcome[];
} {
  let buffer = '';

  return {
    feed(chunk: string): HttpParseOutcome[] {
      buffer += chunk;
      const outcomes: HttpParseOutcome[] = [];

      for (;;) {
        const headerEnd = buffer.indexOf(HEADER_END);
        if (headerEnd === -1) {
          // Guard against an unbounded header block with no terminator.
          if (buffer.length > 64 * 1024) {
            outcomes.push({
              kind: 'error',
              status: 431,
              message: 'Request headers too large',
            });
            buffer = '';
          }
          return outcomes;
        }

        const head = buffer.slice(0, headerEnd);
        const lines = head.split('\r\n');
        const requestLine = lines[0] ?? '';
        const [method, rawTarget, version] = requestLine.split(' ');
        if (!method || !rawTarget || !version?.startsWith('HTTP/')) {
          outcomes.push({
            kind: 'error',
            status: 400,
            message: 'Malformed request line',
          });
          buffer = '';
          return outcomes;
        }

        const headers: Record<string, string> = {};
        for (const line of lines.slice(1)) {
          const colon = line.indexOf(':');
          if (colon === -1) {
            outcomes.push({
              kind: 'error',
              status: 400,
              message: 'Malformed header line',
            });
            buffer = '';
            return outcomes;
          }
          headers[line.slice(0, colon).trim().toLowerCase()] = line
            .slice(colon + 1)
            .trim();
        }

        if (headers['transfer-encoding']) {
          outcomes.push({
            kind: 'error',
            status: 501,
            message:
              'Chunked transfer encoding is not supported; send a Content-Length body',
          });
          buffer = '';
          return outcomes;
        }

        const contentLength = headers['content-length']
          ? Number(headers['content-length'])
          : 0;
        if (
          !Number.isInteger(contentLength) ||
          contentLength < 0 ||
          contentLength > MAX_BODY_BYTES
        ) {
          outcomes.push({
            kind: 'error',
            status: contentLength > MAX_BODY_BYTES ? 413 : 400,
            message:
              contentLength > MAX_BODY_BYTES
                ? 'Request body too large'
                : 'Invalid Content-Length',
          });
          buffer = '';
          return outcomes;
        }

        const bodyStart = headerEnd + HEADER_END.length;
        if (buffer.length < bodyStart + contentLength) {
          return outcomes;
        }

        const body = buffer.slice(bodyStart, bodyStart + contentLength);
        buffer = buffer.slice(bodyStart + contentLength);

        const [pathPart, queryPart] = rawTarget.split('?', 2);
        const query: Record<string, string> = {};
        if (queryPart) {
          for (const pair of queryPart.split('&')) {
            const [key, value = ''] = pair.split('=', 2);
            try {
              query[decodeURIComponent(key)] = decodeURIComponent(value);
            } catch {
              // Keep the raw pair when it is not valid percent-encoding.
              query[key] = value;
            }
          }
        }

        let path = pathPart;
        try {
          path = decodeURIComponent(pathPart);
        } catch {
          // Keep the raw path when it is not valid percent-encoding.
        }

        outcomes.push({
          kind: 'request',
          request: {method, path, query, headers, body},
        });
      }
    },
  };
}

const REASON_PHRASES: Record<number, string> = {
  200: 'OK',
  400: 'Bad Request',
  401: 'Unauthorized',
  404: 'Not Found',
  405: 'Method Not Allowed',
  409: 'Conflict',
  413: 'Content Too Large',
  431: 'Request Header Fields Too Large',
  501: 'Not Implemented',
  503: 'Service Unavailable',
};

export function reasonPhrase(status: number): string {
  return REASON_PHRASES[status] ?? 'Error';
}

/** Serialise a status line + headers block (no body). */
export function buildResponseHead(
  status: number,
  headers: Record<string, string>,
): string {
  const lines = [`HTTP/1.1 ${status} ${reasonPhrase(status)}`];
  for (const [name, value] of Object.entries(headers)) {
    lines.push(`${name}: ${value}`);
  }
  lines.push('', '');
  return lines.join('\r\n');
}

/** Build a complete (non-streaming) response: head + body. */
export function buildResponse(
  status: number,
  headers: Record<string, string>,
  body: string,
): string {
  return (
    buildResponseHead(status, {
      ...headers,
      'Content-Length': String(utf8ByteLength(body)),
      Connection: 'close',
    }) + body
  );
}

export function jsonResponse(status: number, payload: unknown): string {
  return buildResponse(
    status,
    {'Content-Type': 'application/json'},
    JSON.stringify(payload),
  );
}

/** The OpenAI-shaped error envelope used for every error response. */
export function errorResponse(
  status: number,
  message: string,
  type: string,
  code: string,
): string {
  return jsonResponse(status, {error: {message, type, code}});
}
