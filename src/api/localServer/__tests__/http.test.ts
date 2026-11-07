import {
  createHttpParser,
  jsonResponse,
  errorResponse,
  utf8ByteLength,
  MAX_BODY_BYTES,
} from '../http';

describe('http parser', () => {
  it('parses a simple GET request with no body', () => {
    const parser = createHttpParser();
    const outcomes = parser.feed(
      'GET /health HTTP/1.1\r\nHost: 192.168.1.42:8080\r\nAccept: */*\r\n\r\n',
    );
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]).toEqual({
      kind: 'request',
      request: {
        method: 'GET',
        path: '/health',
        query: {},
        headers: {host: '192.168.1.42:8080', accept: '*/*'},
        body: '',
      },
    });
  });

  it('assembles a request split across chunks', () => {
    const parser = createHttpParser();
    expect(
      parser.feed('POST /v1/chat/completions HTTP/1.1\r\nContent-L'),
    ).toEqual([]);
    expect(parser.feed('ength: 13\r\n\r\n{"model":"x"}')).toEqual([
      {
        kind: 'request',
        request: expect.objectContaining({
          method: 'POST',
          path: '/v1/chat/completions',
          body: '{"model":"x"}',
        }),
      },
    ]);
  });

  it('parses the query string', () => {
    const parser = createHttpParser();
    const outcomes = parser.feed('GET /v1/models?foo=bar&x=1 HTTP/1.1\r\n\r\n');
    expect(outcomes[0]).toEqual(
      expect.objectContaining({
        kind: 'request',
        request: expect.objectContaining({
          path: '/v1/models',
          query: {foo: 'bar', x: '1'},
        }),
      }),
    );
  });

  it('lower-cases header names', () => {
    const parser = createHttpParser();
    const outcomes = parser.feed(
      'POST /v1/chat/completions HTTP/1.1\r\nAuthorization: Bearer secret\r\nContent-Length: 2\r\n\r\n{}',
    );
    expect(outcomes[0]).toEqual(
      expect.objectContaining({
        kind: 'request',
        request: expect.objectContaining({
          headers: {authorization: 'Bearer secret', 'content-length': '2'},
        }),
      }),
    );
  });

  it('rejects chunked transfer encoding with 501', () => {
    const parser = createHttpParser();
    expect(
      parser.feed(
        'POST /x HTTP/1.1\r\nTransfer-Encoding: chunked\r\n\r\n0\r\n\r\n',
      ),
    ).toEqual([
      {
        kind: 'error',
        status: 501,
        message: expect.stringContaining('Chunked'),
      },
    ]);
  });

  it('rejects bodies over the 1 MiB cap with 413', () => {
    const parser = createHttpParser();
    expect(
      parser.feed(
        `POST /x HTTP/1.1\r\nContent-Length: ${MAX_BODY_BYTES + 1}\r\n\r\n`,
      ),
    ).toEqual([
      {kind: 'error', status: 413, message: 'Request body too large'},
    ]);
  });

  it('rejects a malformed request line with 400', () => {
    const parser = createHttpParser();
    expect(parser.feed('NOT-A-REQUEST\r\n\r\n')).toEqual([
      {kind: 'error', status: 400, message: 'Malformed request line'},
    ]);
  });

  it('returns incomplete while the body is still arriving', () => {
    const parser = createHttpParser();
    expect(
      parser.feed('POST /x HTTP/1.1\r\nContent-Length: 5\r\n\r\nhel'),
    ).toEqual([]);
  });
});

describe('http response helpers', () => {
  it('counts UTF-8 bytes, not characters, for Content-Length', () => {
    expect(utf8ByteLength('héllo')).toBe(6);
    expect(utf8ByteLength('{"a":"é"}')).toBe(10);
  });

  it('builds a JSON response with matching Content-Length', () => {
    const response = jsonResponse(200, {status: 'ok'});
    expect(response.startsWith('HTTP/1.1 200 OK\r\n')).toBe(true);
    expect(response).toContain('Content-Type: application/json');
    expect(response).toContain('Connection: close');
    const body = response.split('\r\n\r\n')[1];
    expect(JSON.parse(body)).toEqual({status: 'ok'});
    expect(response).toContain(`Content-Length: ${utf8ByteLength(body)}`);
  });

  it('builds the OpenAI-shaped error envelope', () => {
    const response = errorResponse(
      401,
      'Incorrect API key provided',
      'authentication_error',
      'invalid_api_key',
    );
    expect(response.startsWith('HTTP/1.1 401 Unauthorized\r\n')).toBe(true);
    expect(JSON.parse(response.split('\r\n\r\n')[1])).toEqual({
      error: {
        message: 'Incorrect API key provided',
        type: 'authentication_error',
        code: 'invalid_api_key',
      },
    });
  });
});
