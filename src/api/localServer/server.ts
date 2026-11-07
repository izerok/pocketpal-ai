/**
 * Thin `react-native-tcp-socket` adapter for the Local API Server.
 *
 * This module owns the socket only: accept, read UTF-8 text, feed the
 * pure HTTP parser, dispatch one request per connection to the injected
 * handler, and close the socket when the response is done. Routing,
 * auth and completion live in `router.ts` and are tested without this
 * module (it is mocked in Jest).
 */
import TcpSocket from 'react-native-tcp-socket';

type Socket = TcpSocket.Socket;

import {createHttpParser, buildResponseHead, errorResponse} from './http';
import type {HttpRequest} from './http';
import type {ResponseWriter} from './router';

export interface LocalApiConnectionHandler {
  (
    req: HttpRequest,
    writer: ResponseWriter,
    signal: AbortSignal,
  ): Promise<number>;
}

export interface StartLocalApiServerOptions {
  port: number;
  host?: string;
  onRequest: LocalApiConnectionHandler;
}

export interface LocalApiServerHandle {
  stop(): Promise<void>;
  address(): {port: number; address: string} | null;
}

const DEFAULT_HOST = '0.0.0.0';

/**
 * Start listening. Resolves once the socket is bound ('listening') and
 * rejects if the server errors before that (e.g. the port is taken).
 */
export function startLocalApiServer(
  options: StartLocalApiServerOptions,
): Promise<LocalApiServerHandle> {
  const host = options.host ?? DEFAULT_HOST;
  const sockets = new Set<Socket>();

  return new Promise((resolve, reject) => {
    let settled = false;
    const server = TcpSocket.createServer((socket: Socket) => {
      sockets.add(socket);
      socket.setEncoding('utf8');
      const parser = createHttpParser();
      const abortController = new AbortController();
      let handling = false;
      let ended = false;

      const writer: ResponseWriter = {
        writeHead(status, headers) {
          if (ended) {
            return;
          }
          socket.write(
            buildResponseHead(status, {
              ...headers,
              Connection: 'close',
            }),
          );
        },
        write(chunk) {
          if (!ended) {
            socket.write(chunk);
          }
        },
        end(chunk) {
          if (ended) {
            return;
          }
          ended = true;
          if (chunk !== undefined) {
            socket.end(chunk);
          } else {
            socket.end();
          }
        },
      };

      const closeSocket = () => {
        sockets.delete(socket);
        abortController.abort();
        try {
          socket.destroy();
        } catch {
          // Already gone; nothing to clean up.
        }
      };

      socket.on('data', (data: string | Buffer) => {
        const text = typeof data === 'string' ? data : data.toString('utf8');
        if (handling) {
          // One request per connection: extra bytes are ignored.
          return;
        }
        let outcomes;
        try {
          outcomes = parser.feed(text);
        } catch {
          writer.end(
            errorResponse(
              400,
              'Malformed request',
              'invalid_request_error',
              'bad_request',
            ),
          );
          return;
        }
        for (const outcome of outcomes) {
          if (outcome.kind === 'incomplete') {
            continue;
          }
          if (outcome.kind === 'error') {
            writer.end(
              errorResponse(
                outcome.status,
                outcome.message,
                'invalid_request_error',
                'bad_request',
              ),
            );
            return;
          }
          handling = true;
          options
            .onRequest(outcome.request, writer, abortController.signal)
            .catch(() => {
              if (!ended) {
                try {
                  writer.end(
                    errorResponse(
                      500,
                      'Internal server error',
                      'server_error',
                      'internal_error',
                    ),
                  );
                } catch {
                  // The socket is already gone.
                }
              }
            })
            .finally(() => {
              // The response always ends the connection (v1 contract).
              closeSocket();
            });
          return;
        }
      });

      socket.on('error', () => {
        closeSocket();
      });
      socket.on('close', () => {
        sockets.delete(socket);
        abortController.abort();
      });
    });

    server.on('error', (error: Error) => {
      if (!settled) {
        settled = true;
        reject(error);
      }
    });
    server.on('listening', () => {
      if (!settled) {
        settled = true;
        resolve({
          address: () => {
            const info = server.address();
            return info ? {port: info.port, address: info.address} : null;
          },
          stop: () =>
            new Promise<void>(resolveStop => {
              for (const socket of [...sockets]) {
                try {
                  socket.destroy();
                } catch {
                  // Already gone.
                }
              }
              sockets.clear();
              let done = false;
              // Never hang stop() on a stuck native close.
              const timer = setTimeout(finish, 2000);
              function finish() {
                if (!done) {
                  done = true;
                  clearTimeout(timer);
                  resolveStop();
                }
              }
              if (!server.listening) {
                finish();
                return;
              }
              server.close(() => finish());
            }),
        });
      }
    });

    server.listen({port: options.port, host});
  });
}
