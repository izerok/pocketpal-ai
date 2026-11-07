import {handleLocalApiRequest, LocalApiBusyError} from '../router';
import type {LocalApiDeps, ResponseWriter} from '../router';
import type {HttpRequest} from '../http';
import type {
  ApiCompletionParams,
  CompletionResult,
  CompletionStreamData,
} from '../../../utils/completionTypes';

class CollectWriter implements ResponseWriter {
  status: number | null = null;
  headers: Record<string, string> = {};
  chunks: string[] = [];
  ended = false;

  writeHead(status: number, headers: Record<string, string>) {
    this.status = status;
    this.headers = headers;
  }

  write(chunk: string) {
    this.chunks.push(chunk);
  }

  end(chunk?: string) {
    if (chunk !== undefined) {
      this.chunks.push(chunk);
    }
    this.ended = true;
  }

  /** Full response text for non-streaming responses. */
  get text(): string {
    return this.chunks.join('');
  }

  get body(): unknown {
    const raw = this.text.split('\r\n\r\n')[1] ?? '';
    return JSON.parse(raw);
  }

  get responseStatus(): number {
    if (this.status !== null) {
      return this.status;
    }
    const match = /^HTTP\/1\.1 (\d{3})/.exec(this.text);
    return match ? Number(match[1]) : -1;
  }
}

const fakeResult: CompletionResult = {
  text: 'Hello world',
  content: 'Hello world',
  tokens_predicted: 2,
  tokens_evaluated: 5,
};

function makeDeps(overrides: Partial<LocalApiDeps> = {}): LocalApiDeps {
  return {
    apiKey: 'secret',
    baseCompletionSettings: {} as LocalApiDeps['baseCompletionSettings'],
    getActiveModel: () => ({id: 'test-model'}),
    isBusy: () => false,
    runCompletion: async (
      _params: ApiCompletionParams,
      onToken: (data: CompletionStreamData) => void,
    ) => {
      onToken({content: 'Hello'});
      onToken({content: ' world'});
      return fakeResult;
    },
    ...overrides,
  };
}

function makeRequest(
  method: string,
  path: string,
  options: {headers?: Record<string, string>; body?: string} = {},
): HttpRequest {
  return {
    method,
    path,
    query: {},
    headers: options.headers ?? {},
    body: options.body ?? '',
  };
}

const AUTH = {authorization: 'Bearer secret'};

function chatBody(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    model: 'test-model',
    messages: [{role: 'user', content: 'Hi'}],
    ...overrides,
  });
}

describe('local API router', () => {
  describe('GET /health', () => {
    it('answers without auth', async () => {
      const writer = new CollectWriter();
      const status = await handleLocalApiRequest(
        makeRequest('GET', '/health'),
        makeDeps(),
        writer,
      );
      expect(status).toBe(200);
      expect(writer.body).toEqual({status: 'ok'});
    });
  });

  describe('auth', () => {
    it('rejects /v1/models without a Bearer token', async () => {
      const writer = new CollectWriter();
      const status = await handleLocalApiRequest(
        makeRequest('GET', '/v1/models'),
        makeDeps(),
        writer,
      );
      expect(status).toBe(401);
      expect(writer.body).toEqual({
        error: {
          message: 'Incorrect API key provided',
          type: 'authentication_error',
          code: 'invalid_api_key',
        },
      });
    });

    it('rejects a wrong Bearer token', async () => {
      const writer = new CollectWriter();
      const status = await handleLocalApiRequest(
        makeRequest('GET', '/v1/models', {
          headers: {authorization: 'Bearer nope'},
        }),
        makeDeps(),
        writer,
      );
      expect(status).toBe(401);
    });
  });

  describe('GET /v1/models', () => {
    it('lists the loaded model', async () => {
      const writer = new CollectWriter();
      const status = await handleLocalApiRequest(
        makeRequest('GET', '/v1/models', {headers: AUTH}),
        makeDeps(),
        writer,
      );
      expect(status).toBe(200);
      expect(writer.body).toEqual({
        object: 'list',
        data: [{id: 'test-model', object: 'model', owned_by: 'pocketpal'}],
      });
    });

    it('lists nothing when no model is loaded', async () => {
      const writer = new CollectWriter();
      const status = await handleLocalApiRequest(
        makeRequest('GET', '/v1/models', {headers: AUTH}),
        makeDeps({getActiveModel: () => null}),
        writer,
      );
      expect(status).toBe(200);
      expect(writer.body).toEqual({object: 'list', data: []});
    });
  });

  describe('POST /v1/chat/completions', () => {
    it('returns a non-streaming completion with usage', async () => {
      const writer = new CollectWriter();
      const seenParams: ApiCompletionParams[] = [];
      const status = await handleLocalApiRequest(
        makeRequest('POST', '/v1/chat/completions', {
          headers: {...AUTH, 'content-type': 'application/json'},
          body: chatBody({temperature: 0.5, max_tokens: 10}),
        }),
        makeDeps({
          runCompletion: async (params, onToken) => {
            seenParams.push(params);
            onToken({content: 'Hello'});
            return fakeResult;
          },
        }),
        writer,
      );
      expect(status).toBe(200);
      expect(writer.body).toEqual({
        id: expect.stringMatching(/^chatcmpl-/),
        object: 'chat.completion',
        created: expect.any(Number),
        model: 'test-model',
        choices: [
          {
            index: 0,
            message: {role: 'assistant', content: 'Hello world'},
            finish_reason: 'stop',
          },
        ],
        usage: {prompt_tokens: 5, completion_tokens: 2, total_tokens: 7},
      });
      expect(seenParams[0].temperature).toBe(0.5);
      expect(seenParams[0].n_predict).toBe(10);
      expect(seenParams[0].messages).toEqual([{role: 'user', content: 'Hi'}]);
    });

    it('streams SSE chunks and ends with [DONE]', async () => {
      const writer = new CollectWriter();
      const status = await handleLocalApiRequest(
        makeRequest('POST', '/v1/chat/completions', {
          headers: AUTH,
          body: chatBody({stream: true}),
        }),
        makeDeps(),
        writer,
      );
      expect(status).toBe(200);
      expect(writer.status).toBe(200);
      expect(writer.headers['Content-Type']).toBe('text/event-stream');
      const text = writer.text;
      expect(text).toContain('data: {"id":"chatcmpl-');
      expect(text).toContain('"delta":{"content":"Hello"}');
      expect(text).toContain('"delta":{"content":" world"}');
      expect(text).toContain('"finish_reason":"stop"');
      expect(text.trimEnd().endsWith('data: [DONE]')).toBe(true);
    });

    it('rejects invalid JSON with 400', async () => {
      const writer = new CollectWriter();
      const status = await handleLocalApiRequest(
        makeRequest('POST', '/v1/chat/completions', {
          headers: AUTH,
          body: '{not json',
        }),
        makeDeps(),
        writer,
      );
      expect(status).toBe(400);
    });

    it('rejects missing messages with 400', async () => {
      const writer = new CollectWriter();
      const status = await handleLocalApiRequest(
        makeRequest('POST', '/v1/chat/completions', {
          headers: AUTH,
          body: JSON.stringify({model: 'test-model', messages: []}),
        }),
        makeDeps(),
        writer,
      );
      expect(status).toBe(400);
    });

    it('rejects non-string message content with 400', async () => {
      const writer = new CollectWriter();
      const status = await handleLocalApiRequest(
        makeRequest('POST', '/v1/chat/completions', {
          headers: AUTH,
          body: JSON.stringify({
            model: 'test-model',
            messages: [{role: 'user', content: [{type: 'text'}]}],
          }),
        }),
        makeDeps(),
        writer,
      );
      expect(status).toBe(400);
    });

    it('rejects tool requests with 400', async () => {
      const writer = new CollectWriter();
      const status = await handleLocalApiRequest(
        makeRequest('POST', '/v1/chat/completions', {
          headers: AUTH,
          body: chatBody({tools: [{type: 'function'}]}),
        }),
        makeDeps(),
        writer,
      );
      expect(status).toBe(400);
    });

    it('returns 404 for an unknown model id', async () => {
      const writer = new CollectWriter();
      const status = await handleLocalApiRequest(
        makeRequest('POST', '/v1/chat/completions', {
          headers: AUTH,
          body: chatBody({model: 'other-model'}),
        }),
        makeDeps(),
        writer,
      );
      expect(status).toBe(404);
      expect(writer.body).toEqual(
        expect.objectContaining({
          error: expect.objectContaining({code: 'model_not_found'}),
        }),
      );
    });

    it('returns 503 when no model is loaded', async () => {
      const writer = new CollectWriter();
      const status = await handleLocalApiRequest(
        makeRequest('POST', '/v1/chat/completions', {
          headers: AUTH,
          body: chatBody(),
        }),
        makeDeps({getActiveModel: () => null}),
        writer,
      );
      expect(status).toBe(503);
      expect(writer.body).toEqual(
        expect.objectContaining({
          error: expect.objectContaining({code: 'model_not_loaded'}),
        }),
      );
    });

    it('returns 409 when the engine is busy', async () => {
      const writer = new CollectWriter();
      const status = await handleLocalApiRequest(
        makeRequest('POST', '/v1/chat/completions', {
          headers: AUTH,
          body: chatBody(),
        }),
        makeDeps({isBusy: () => true}),
        writer,
      );
      expect(status).toBe(409);
      expect(writer.body).toEqual(
        expect.objectContaining({
          error: expect.objectContaining({code: 'server_busy'}),
        }),
      );
    });

    it('returns 409 when the lease is lost between check and run', async () => {
      const writer = new CollectWriter();
      const status = await handleLocalApiRequest(
        makeRequest('POST', '/v1/chat/completions', {
          headers: AUTH,
          body: chatBody(),
        }),
        makeDeps({
          runCompletion: async () => {
            throw new LocalApiBusyError();
          },
        }),
        writer,
      );
      expect(status).toBe(409);
    });

    it('returns 500 when the completion throws', async () => {
      const writer = new CollectWriter();
      const status = await handleLocalApiRequest(
        makeRequest('POST', '/v1/chat/completions', {
          headers: AUTH,
          body: chatBody(),
        }),
        makeDeps({
          runCompletion: async () => {
            throw new Error('boom');
          },
        }),
        writer,
      );
      expect(status).toBe(500);
    });

    it('returns 404 for unknown routes', async () => {
      const writer = new CollectWriter();
      const status = await handleLocalApiRequest(
        makeRequest('GET', '/v1/embeddings', {headers: AUTH}),
        makeDeps(),
        writer,
      );
      expect(status).toBe(404);
    });
  });
});
