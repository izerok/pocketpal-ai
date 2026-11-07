/**
 * OpenAI-compatible routing for the Local API Server.
 *
 * Pure except for the injected completion dependency: no React Native,
 * no store and no socket imports here, so the routing, validation and
 * wire shapes are unit-testable with a fake `runCompletion`.
 *
 * Served surface (v1):
 * - GET  /health               (no auth — liveness only, returns no data)
 * - GET  /v1/models            (Bearer auth)
 * - POST /v1/chat/completions  (Bearer auth, stream or non-stream)
 *
 * Deliberately NOT in v1: /v1/completions, /v1/embeddings, tools /
 * function calling, vision inputs. A request that asks for tools gets
 * a 400 instead of a silent downgrade.
 */
import {errorResponse, jsonResponse} from './http';
import type {HttpRequest} from './http';
import type {
  ApiCompletionParams,
  CompletionResult,
  CompletionStreamData,
  CompletionParams,
} from '../../utils/completionTypes';

/** Thrown by `runCompletion` when the generation slot is already held. */
export class LocalApiBusyError extends Error {
  constructor() {
    super('Another generation is already running');
    this.name = 'LocalApiBusyError';
  }
}

export interface LocalApiModelInfo {
  id: string;
}

export interface LocalApiDeps {
  /** The Bearer token clients must present. Always required. */
  apiKey: string;
  /** The app's stored completion settings; request values override them. */
  baseCompletionSettings: CompletionParams;
  getActiveModel: () => LocalApiModelInfo | null;
  isBusy: () => boolean;
  runCompletion: (
    params: ApiCompletionParams,
    onToken: (data: CompletionStreamData) => void,
  ) => Promise<CompletionResult>;
}

/** The streaming half of the server boundary. */
export interface ResponseWriter {
  writeHead(status: number, headers: Record<string, string>): void;
  write(chunk: string): void;
  end(chunk?: string): void;
}

let completionCounter = 0;

function nextCompletionId(): string {
  completionCounter += 1;
  return `chatcmpl-${Date.now().toString(36)}-${completionCounter}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value)
    ? value
    : undefined;
}

function parseJsonBody(req: HttpRequest): unknown {
  if (!req.body) {
    return undefined;
  }
  return JSON.parse(req.body);
}

function checkAuth(req: HttpRequest, apiKey: string): boolean {
  const header = req.headers.authorization ?? '';
  const match = /^Bearer\s+(.+)$/.exec(header);
  return match !== null && match[1] === apiKey;
}

type ChatMessage = {role: string; content: string};

const CHAT_ROLES = new Set(['system', 'user', 'assistant', 'tool']);

function validateMessages(value: unknown): ChatMessage[] | string {
  if (!Array.isArray(value) || value.length === 0) {
    return 'messages must be a non-empty array';
  }
  for (const item of value) {
    if (!isRecord(item)) {
      return 'each message must be an object';
    }
    if (typeof item.role !== 'string' || !CHAT_ROLES.has(item.role)) {
      return 'each message needs a role of system, user, assistant or tool';
    }
    if (typeof item.content !== 'string') {
      return 'message content must be a string in v1 (no vision parts)';
    }
  }
  return value as ChatMessage[];
}

function mapRequestToParams(
  body: Record<string, unknown>,
  base: CompletionParams,
  messages: ChatMessage[],
): ApiCompletionParams {
  const params: Record<string, unknown> = {
    ...base,
    messages,
    reasoning_format: 'auto',
  };
  // Delete app-only keys the base may carry; the engine must never see them.
  delete params.version;
  delete params.include_thinking_in_context;

  const temperature = finiteNumber(body.temperature);
  if (temperature !== undefined) {
    params.temperature = temperature;
  }
  const topP = finiteNumber(body.top_p);
  if (topP !== undefined) {
    params.top_p = topP;
  }
  const topK = finiteNumber(body.top_k);
  if (topK !== undefined) {
    params.top_k = topK;
  }
  const seed = finiteNumber(body.seed);
  if (seed !== undefined) {
    params.seed = seed;
  }
  const maxTokens =
    finiteNumber(body.max_tokens) ?? finiteNumber(body.max_completion_tokens);
  if (maxTokens !== undefined) {
    params.n_predict = Math.max(1, Math.floor(maxTokens));
  }
  const presencePenalty = finiteNumber(body.presence_penalty);
  if (presencePenalty !== undefined) {
    params.penalty_present = presencePenalty;
  }
  const frequencyPenalty = finiteNumber(body.frequency_penalty);
  if (frequencyPenalty !== undefined) {
    params.penalty_freq = frequencyPenalty;
  }
  if (body.stop !== undefined) {
    params.stop =
      typeof body.stop === 'string'
        ? [body.stop]
        : Array.isArray(body.stop) &&
            body.stop.every(item => typeof item === 'string')
          ? (body.stop as string[])
          : params.stop;
  }
  return params as ApiCompletionParams;
}

function usageFrom(
  result: CompletionResult,
):
  | {prompt_tokens: number; completion_tokens: number; total_tokens: number}
  | undefined {
  const prompt = result.tokens_evaluated;
  const completion = result.tokens_predicted;
  if (prompt === undefined && completion === undefined) {
    return undefined;
  }
  const promptTokens = prompt ?? 0;
  const completionTokens = completion ?? 0;
  return {
    prompt_tokens: promptTokens,
    completion_tokens: completionTokens,
    total_tokens: promptTokens + completionTokens,
  };
}

function finishReasonOf(result: CompletionResult): string {
  if (result.stopped_limit) {
    return 'length';
  }
  return 'stop';
}

/**
 * Handle one request. Returns the HTTP status that was written, so the
 * caller can count failures. For streaming completions the 200 head is
 * written before generation starts, so a mid-stream failure cannot be
 * re-reported as an HTTP error — the socket is simply closed.
 */
export async function handleLocalApiRequest(
  req: HttpRequest,
  deps: LocalApiDeps,
  writer: ResponseWriter,
  signal?: AbortSignal,
): Promise<number> {
  const {method, path} = req;

  if (method === 'GET' && path === '/health') {
    writer.end(jsonResponse(200, {status: 'ok'}));
    return 200;
  }

  // Every /v1 route requires the Bearer token.
  if (path.startsWith('/v1/') && !checkAuth(req, deps.apiKey)) {
    writer.end(
      errorResponse(
        401,
        'Incorrect API key provided',
        'authentication_error',
        'invalid_api_key',
      ),
    );
    return 401;
  }

  if (method === 'GET' && path === '/v1/models') {
    const model = deps.getActiveModel();
    writer.end(
      jsonResponse(200, {
        object: 'list',
        data: model
          ? [{id: model.id, object: 'model', owned_by: 'pocketpal'}]
          : [],
      }),
    );
    return 200;
  }

  if (method === 'POST' && path === '/v1/chat/completions') {
    let body: unknown;
    try {
      body = parseJsonBody(req);
    } catch {
      writer.end(
        errorResponse(
          400,
          'Request body is not valid JSON',
          'invalid_request_error',
          'invalid_json',
        ),
      );
      return 400;
    }
    if (!isRecord(body)) {
      writer.end(
        errorResponse(
          400,
          'Request body must be a JSON object',
          'invalid_request_error',
          'invalid_request',
        ),
      );
      return 400;
    }
    if (body.tools !== undefined) {
      writer.end(
        errorResponse(
          400,
          'Tool calling is not supported by the local API server in v1',
          'invalid_request_error',
          'unsupported_tools',
        ),
      );
      return 400;
    }

    const messagesOrError = validateMessages(body.messages);
    if (typeof messagesOrError === 'string') {
      writer.end(
        errorResponse(
          400,
          messagesOrError,
          'invalid_request_error',
          'invalid_messages',
        ),
      );
      return 400;
    }

    const model = deps.getActiveModel();
    if (!model) {
      writer.end(
        errorResponse(
          503,
          'No local model is loaded. Load a model in PocketPal first.',
          'server_error',
          'model_not_loaded',
        ),
      );
      return 503;
    }
    if (
      typeof body.model === 'string' &&
      body.model.length > 0 &&
      body.model !== model.id
    ) {
      writer.end(
        errorResponse(
          404,
          `The model '${body.model}' does not exist`,
          'invalid_request_error',
          'model_not_found',
        ),
      );
      return 404;
    }
    if (deps.isBusy()) {
      writer.end(
        errorResponse(
          409,
          'Another generation is already running. The local server handles one request at a time; retry when it finishes.',
          'server_error',
          'server_busy',
        ),
      );
      return 409;
    }

    const params = mapRequestToParams(
      body,
      deps.baseCompletionSettings,
      messagesOrError,
    );
    const completionId = nextCompletionId();
    const created = Math.floor(Date.now() / 1000);
    const stream = body.stream === true;

    if (!stream) {
      let result: CompletionResult;
      try {
        result = await deps.runCompletion(params, () => {});
      } catch (error) {
        if (error instanceof LocalApiBusyError) {
          writer.end(
            errorResponse(
              409,
              'Another generation is already running. The local server handles one request at a time; retry when it finishes.',
              'server_error',
              'server_busy',
            ),
          );
          return 409;
        }
        writer.end(
          errorResponse(
            500,
            error instanceof Error ? error.message : 'Completion failed',
            'server_error',
            'completion_failed',
          ),
        );
        return 500;
      }
      if (signal?.aborted) {
        return 200;
      }
      const content = result.content ?? result.text ?? '';
      const message: Record<string, unknown> = {
        role: 'assistant',
        content,
      };
      if (result.reasoning_content) {
        message.reasoning_content = result.reasoning_content;
      }
      const response: Record<string, unknown> = {
        id: completionId,
        object: 'chat.completion',
        created,
        model: model.id,
        choices: [
          {
            index: 0,
            message,
            finish_reason: finishReasonOf(result),
          },
        ],
      };
      const usage = usageFrom(result);
      if (usage) {
        response.usage = usage;
      }
      writer.end(jsonResponse(200, response));
      return 200;
    }

    // Streaming (SSE) path.
    writer.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'close',
    });
    const sendChunk = (
      delta: Record<string, unknown>,
      finish: string | null,
    ) => {
      const payload = JSON.stringify({
        id: completionId,
        object: 'chat.completion.chunk',
        created,
        model: model.id,
        choices: [{index: 0, delta, finish_reason: finish}],
      });
      writer.write(`data: ${payload}\n\n`);
    };

    let result: CompletionResult;
    try {
      result = await deps.runCompletion(params, data => {
        if (signal?.aborted) {
          return;
        }
        const delta: Record<string, unknown> = {};
        if (data.content) {
          delta.content = data.content;
        }
        if (data.reasoning_content) {
          delta.reasoning_content = data.reasoning_content;
        }
        if (Object.keys(delta).length > 0) {
          sendChunk(delta, null);
        }
      });
    } catch {
      // The 200 head is already on the wire; there is no error body to
      // send, so end the stream. A LocalApiBusyError here means the slot
      // was taken between the check above and the run starting.
      writer.end();
      return 200;
    }
    if (!signal?.aborted) {
      sendChunk({}, finishReasonOf(result));
      writer.end('data: [DONE]\n\n');
    } else {
      writer.end();
    }
    return 200;
  }

  if (path.startsWith('/v1/')) {
    writer.end(
      errorResponse(
        404,
        `Unknown route: ${method} ${path}`,
        'invalid_request_error',
        'unknown_route',
      ),
    );
    return 404;
  }

  writer.end(
    errorResponse(
      404,
      `Unknown route: ${method} ${path}`,
      'invalid_request_error',
      'unknown_route',
    ),
  );
  return 404;
}
