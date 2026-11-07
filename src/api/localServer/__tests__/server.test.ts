import {startLocalApiServer} from '../server';
import {jsonResponse} from '../http';
import {handleLocalApiRequest} from '../router';
import TcpSocket from 'react-native-tcp-socket';

/** Structural view of the Jest fake (see __mocks__/external). */
interface FakeSocket {
  encoding?: string;
  written: string[];
  ended: boolean;
  emit(event: string, data: string): void;
}

interface FakeServer {
  connectionHandler: (socket: FakeSocket) => void;
  listenOptions: unknown;
  listening: boolean;
}

const tcpMock = TcpSocket as unknown as {
  createServer: jest.Mock;
  __servers: FakeServer[];
  __FakeSocket: new () => FakeSocket;
};

describe('local API server adapter', () => {
  beforeEach(() => {
    tcpMock.__servers.length = 0;
    tcpMock.createServer.mockClear();
  });

  it('listens, answers one request per connection, then closes it', async () => {
    const handle = await startLocalApiServer({
      port: 8080,
      onRequest: async (req, writer) => {
        writer.end(jsonResponse(200, {ok: true, path: req.path}));
        return 200;
      },
    });
    expect(handle.address()).toEqual({
      port: 8080,
      address: '0.0.0.0',
    });

    const server = tcpMock.__servers[0];
    expect(server).toBeDefined();
    expect(server.listenOptions).toEqual({port: 8080, host: '0.0.0.0'});

    const socket = new tcpMock.__FakeSocket();
    server.connectionHandler(socket);
    expect(socket.encoding).toBe('utf8');
    socket.emit(
      'data',
      'GET /health HTTP/1.1\r\nHost: 192.168.1.42:8080\r\n\r\n',
    );
    // Let the async handler settle.
    await new Promise(resolve => setTimeout(resolve, 0));
    const text = socket.written.join('');
    expect(text).toContain('HTTP/1.1 200 OK');
    expect(text).toContain('"ok":true');
    expect(socket.ended).toBe(true);

    await handle.stop();
    expect(server.listening).toBe(false);
  });

  it('answers a 500 when the handler throws', async () => {
    const handle = await startLocalApiServer({
      port: 8080,
      onRequest: async () => {
        throw new Error('boom');
      },
    });
    const socket = new tcpMock.__FakeSocket();
    tcpMock.__servers[0].connectionHandler(socket);
    socket.emit('data', 'GET /health HTTP/1.1\r\n\r\n');
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(socket.written.join('')).toContain('HTTP/1.1 500');
    await handle.stop();
  });

  it('serves a streaming chat completion end to end over raw HTTP', async () => {
    const handle = await startLocalApiServer({
      port: 8080,
      onRequest: (req, writer, signal) =>
        handleLocalApiRequest(
          req,
          {
            apiKey: 'secret',
            baseCompletionSettings: {} as Parameters<
              typeof handleLocalApiRequest
            >[1]['baseCompletionSettings'],
            getActiveModel: () => ({id: 'test-model'}),
            isBusy: () => false,
            runCompletion: async (_params, onToken) => {
              onToken({content: 'Hi'});
              return {
                text: 'Hi',
                content: 'Hi',
                tokens_predicted: 1,
                tokens_evaluated: 2,
              };
            },
          },
          writer,
          signal,
        ),
    });
    const socket = new tcpMock.__FakeSocket();
    tcpMock.__servers[0].connectionHandler(socket);
    const body = JSON.stringify({
      model: 'test-model',
      messages: [{role: 'user', content: 'Hi'}],
      stream: true,
    });
    socket.emit(
      'data',
      `POST /v1/chat/completions HTTP/1.1\r\nHost: x\r\nAuthorization: Bearer secret\r\nContent-Type: application/json\r\nContent-Length: ${body.length}\r\n\r\n${body}`,
    );
    await new Promise(resolve => setTimeout(resolve, 0));
    const text = socket.written.join('');
    expect(text).toContain('HTTP/1.1 200 OK');
    expect(text).toContain('Content-Type: text/event-stream');
    expect(text).toContain('"delta":{"content":"Hi"}');
    expect(text.trimEnd().endsWith('data: [DONE]')).toBe(true);
    await handle.stop();
  });

  it('rejects when the server errors before listening', async () => {
    // Make the next created server fail instead of listening.
    const createServer = tcpMock.createServer;
    const original = createServer.getMockImplementation();
    createServer.mockImplementationOnce((handler: unknown) => {
      const server = (original as (...args: unknown[]) => unknown)(handler);
      const fake = server as {
        listen: (...args: unknown[]) => unknown;
        emit: (event: string, ...args: unknown[]) => void;
      };
      fake.listen = () => {
        fake.emit('error', new Error('EADDRINUSE'));
        return fake;
      };
      return server;
    });
    await expect(
      startLocalApiServer({
        port: 8080,
        onRequest: async () => 200,
      }),
    ).rejects.toThrow('EADDRINUSE');
    createServer.mockImplementation(original);
  });
});
