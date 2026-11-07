# Local API Server (fork feature)

PocketPal in this fork can serve its loaded **local** model on the LAN
as an OpenAI-compatible HTTP API. This is the feature upstream tracks
as issue [#259](https://github.com/a-ghorbani/pocketpal-ai/issues/259);
upstream PocketPal has no server of its own.

> **Not verified on a real device / emulator.** The code below was
> type-checked, linted and unit-tested in this sandbox only. Run it on
> a phone before trusting it.

## How to use it

1. Load a local model in PocketPal (Models → Load).
2. Settings → API Settings → **Local API Server** → turn the switch on.
3. Note the address (e.g. `http://192.168.1.42:8080`) and the API key
   (Copy API Key). The key is generated on first start and kept in the
   system Keychain; Regenerate Key replaces it immediately.
4. From any machine on the same Wi-Fi network:

```sh
# Liveness (no auth needed)
curl http://192.168.1.42:8080/health
# {"status":"ok"}

# Models (Bearer auth)
curl http://192.168.1.42:8080/v1/models \
  -H "Authorization: Bearer <API_KEY>"
# {"object":"list","data":[{"id":"...","object":"model","owned_by":"pocketpal"}]}

# Chat, non-streaming
curl http://192.168.1.42:8080/v1/chat/completions \
  -H "Authorization: Bearer <API_KEY>" \
  -H "Content-Type: application/json" \
  -d '{"model":"<id from /v1/models>","messages":[{"role":"user","content":"Say hi"}],"temperature":0.7,"max_tokens":64}'

# Chat, streaming (SSE)
curl -N http://192.168.1.42:8080/v1/chat/completions \
  -H "Authorization: Bearer <API_KEY>" \
  -H "Content-Type: application/json" \
  -d '{"model":"<id>","messages":[{"role":"user","content":"Say hi"}],"stream":true}'
```

With the OpenAI Python client:

```python
from openai import OpenAI
client = OpenAI(base_url="http://192.168.1.42:8080/v1", api_key="<API_KEY>")
reply = client.chat.completions.create(
    model="<id from /v1/models>",
    messages=[{"role": "user", "content": "Say hi"}],
)
print(reply.choices[0].message.content)
```

## Defaults and limits (v1)

- **Foreground-only.** The server lives in the app process. Switch
  apps, lock the phone, or let the OS suspend PocketPal and the
  server stops. No background service, no autostart.
- **LAN-only, no TLS.** Binds `0.0.0.0:<port>` (default `8080`).
  Anyone on the same network who has the Bearer token can use it;
  anyone without it gets `401`. Treat the token like a password and
  regenerate it if it leaks. Do not port-forward it to the internet.
- **One request at a time.** The phone has a single inference
  context, shared with the chat UI. A second request while one is
  running gets `409 {"error": {"code": "server_busy"}}` — retry later.
  The server never queues behind the UI.
- **One request per connection.** Responses carry
  `Connection: close`; clients must open a new connection per
  request (curl and the OpenAI SDKs do this already).
- **Local models only.** Remote models (LM Studio / Ollama / OpenAI
  configured in PocketPal) are not served. With no local model loaded,
  `/v1/models` returns an empty list and chat returns
  `503 model_not_loaded`.
- **Chat only.** `GET /health`, `GET /v1/models`,
  `POST /v1/chat/completions` (streaming SSE and non-streaming).
  No `/v1/completions`, no embeddings, no tool/function calling
  (requesting `tools` returns `400`), no vision parts (message
  `content` must be a string).
- **Request mapping.** `temperature`, `top_p`, `top_k`, `seed`,
  `stop`, `max_tokens` / `max_completion_tokens` (→ `n_predict`),
  `presence_penalty` (→ `penalty_present`),
  `frequency_penalty` (→ `penalty_freq`) override the app's stored
  completion settings; everything else uses those settings.
  `usage` reports `prompt_tokens` / `completion_tokens` from the
  engine when known and is omitted when unknown — never invented.
- **Body limits.** `Content-Length` bodies only, max 1 MiB.
  `Transfer-Encoding: chunked` is rejected with `501`.

## How it is built

- Transport: `react-native-tcp-socket` 6.4.3 (`createServer`,
  UTF-8 sockets). No native code of ours; the same JS server runs on
  Android and iOS.
- `src/api/localServer/http.ts` — pure HTTP/1.1 parsing and response
  writing (unit-tested, no RN imports).
- `src/api/localServer/router.ts` — OpenAI-compatible routing,
  auth and request mapping (unit-tested with a fake engine).
- `src/api/localServer/server.ts` — thin TcpSocket adapter; aborts
  the in-flight completion when the client disconnects.
- `src/store/LocalApiServerStore.ts` — MobX store. Port is persisted
  in AsyncStorage; the API key lives in the Keychain. Generation goes
  through `ModelStore.tryAcquireGeneration()` so the server and the
  chat UI can never run two generations at once.
- Settings UI lives in the API Settings card of the Settings screen;
  the port is shown read-only in v1.
- The Plus catalog (`src/services/plus/catalog.ts`) still lists
  `localApiServer` as unshipped, as upstream does — the Settings
  switch above is the control surface in this fork, and the Plus
  screen's "coming soon" label for it is stale here.

## Deliberately left for v2

- Android foreground service / iOS background modes (keep-alive).
- Editable port, TLS, `/v1/completions`, tool calling, request
  queueing instead of `409`, per-client rate limiting.
