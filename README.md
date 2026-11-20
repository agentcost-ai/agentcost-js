# AgentCost SDK for TypeScript / JavaScript

Usage and cost tracking for LLM calls, sent to [AgentCost](https://agentcost.tech).
One line per client; your calls, responses and errors are unchanged.

| Integration | Function | Tested versions |
|---|---|---|
| OpenAI (`openai`), incl. Azure OpenAI and any OpenAI-compatible base URL (gateways, proxies, self-hosted endpoints) | `instrumentOpenAI(client)` | 4.104, 5.23, 6.49, 7.62 |
| Anthropic (`@anthropic-ai/sdk`), incl. Bedrock / Vertex clients | `instrumentAnthropic(client)` | 0.40, 0.137, 1.11 |
| Google Gen AI (`@google/genai`), Gemini API and Vertex AI | `instrumentGoogleGenAI(client)` | 1.0, 1.52, 3.6 |
| LangChain.js / LangGraph (`@langchain/core`), any chat model | `agentcostCallbacks()` | 0.3, 1.4 |
| Vercel AI SDK (`ai`), any provider | `agentcostMiddleware()`, `agentcostEmbeddingMiddleware()` | 5.0, 6.0, 7.0 (embeddings: 6+) |

- **Runtimes:** Node.js 18+ (tested locally on 20; CI covers 18, 20, 22, 24).
  Written to also run on Bun, Deno and edge runtimes that provide
  `node:async_hooks` (Vercel Functions, Cloudflare Workers with `nodejs_compat`),
  but those are not tested yet. Server-side only: your API keys must never reach
  a browser.
- **Module formats:** ESM (`import`) and CommonJS (`require`), with types. If an
  app loads both, they share one tracker.
- **No runtime dependencies.** Provider SDKs are optional peer dependencies; the
  package never imports them.

## Install

```sh
npm install @agentcost/sdk
```

## Quick start

```ts
import OpenAI from "openai";
import * as agentcost from "@agentcost/sdk";

// AGENTCOST_API_KEY and AGENTCOST_PROJECT_ID are read from the environment.
agentcost.init();

const client = agentcost.instrumentOpenAI(
  new OpenAI(), // or new OpenAI({ baseURL: "https://your-gateway.example/v1", apiKey })
);

await client.chat.completions.create({ model: "gpt-4o", messages: [{ role: "user", content: "Hi" }] });
```

Events are sent in the background in batches. A long-running process needs
nothing else. Short-lived processes and serverless functions should flush:

```ts
await agentcost.flush();             // or: ctx.waitUntil(agentcost.flush())
await agentcost.shutdown();          // flush and stop, at process end
```

## Attribution: agents, jobs, steps

```ts
await agentcost.agent("researcher", () =>
  agentcost.workflow("nightly-report", async (traceId) => {   // one run of a job = one trace
    await agentcost.step("draft", () => client.chat.completions.create({ ... }));
    await agentcost.tool("web_search", () => search(...));      // calls made by a tool
    agentcost.outcome(true, "published");                        // how the run ended
  }),
);

await agentcost.metadata({ customer_id: "c_42" }, () => client.chat.completions.create({ ... }));
```

- Each function takes a callback and returns its result, sync or async.
- Context uses `AsyncLocalStorage`: concurrent requests never share attribution,
  and a stream is attributed to where it was created, even if read later.
- A nested `workflow()` joins the outer run. `workflow(name, fn, { traceId })`
  joins a run started elsewhere; `AGENTCOST_TRACE_ID` / `AGENTCOST_WORKFLOW` in
  the environment do the same for every call in the process.
- In AgentCost: agent → `agent_name`, job → `workflow`, run → `trace_id`, step →
  `step_name`, tool → `tool_name`.

## Integrations

Using a gateway or proxy? See [Tracking calls through a gateway](docs/gateways.md).

### OpenAI and OpenAI-compatible gateways

```ts
const client = agentcost.instrumentOpenAI(new OpenAI({ baseURL: "https://your-gateway.example/v1", apiKey }));
// also: new AzureOpenAI({...})
```

Tracked: `chat.completions.create`, `responses.create`, `completions.create`
(legacy) and `embeddings.create` — awaited, streamed (`for await`, `tee()`,
`toReadableStream()`), `withResponse()`, and the SDK helpers built on them
(`parse()`, `stream()`, `runTools()`, `beta.*` on v4).

For streamed chat and legacy completions without `stream_options`, the package
adds `stream_options: { include_usage: true }` so the endpoint reports usage. If
the endpoint refuses it (an error naming `stream_options`/`include_usage`, or a
400/422 rejecting an unsupported or unknown field), the call is resent once,
exactly as you wrote it, and the event carries
`metadata.stream_options_rejected: true`. Rate-limit, auth, server and validation
errors are never resent. Your own `stream_options` are never changed.

### Anthropic

```ts
import Anthropic from "@anthropic-ai/sdk";
const anthropic = agentcost.instrumentAnthropic(new Anthropic());
```

Tracked: `messages.create` and `beta.messages.create`, streamed or not, and the
helpers built on them (tested: `messages.stream()`; `parse()` and tool runners
call the same method but are not covered by tests yet). Cache reads
are counted as cached input; cache writes are reported separately and priced at
the cache-write rate.

### Google Gen AI

```ts
import { GoogleGenAI } from "@google/genai";
const ai = agentcost.instrumentGoogleGenAI(new GoogleGenAI({ apiKey }));
```

Tracked: `models.generateContent`, `models.generateContentStream`, and the chat
helpers built on them. Thinking tokens are counted as output (Gemini bills them
as output). With automatic function calling, one `generateContent()` can make
several billed requests but only the last one's usage is returned; the number
of requests is recorded in `metadata.afc_turns`.

### LangChain.js / LangGraph

```ts
import { ChatOpenAI } from "@langchain/openai";
const model = new ChatOpenAI({ model: "gpt-4o", callbacks: [agentcost.agentcostCallbacks()] });
// or per call: await model.invoke(input, { callbacks: [agentcost.agentcostCallbacks()] })
```

Works with any LangChain chat model or LLM. Usage comes from LangChain's
standard `usage_metadata` or the model's reported token usage; if LangChain only
has its own estimate, the event says `usage_source: "estimated"`. Don't also
instrument the provider client LangChain uses internally, or calls are counted
twice.

### Vercel AI SDK

```ts
import { wrapLanguageModel, wrapEmbeddingModel, generateText, streamText } from "ai";
import { openai } from "@ai-sdk/openai";

const model = wrapLanguageModel({ model: openai("gpt-4o"), middleware: agentcost.agentcostMiddleware() });
await generateText({ model, prompt: "Hi" });

const embedder = wrapEmbeddingModel({ model: openai.embedding("text-embedding-3-small"), middleware: agentcost.agentcostEmbeddingMiddleware() });
```

Works with any AI SDK provider. Each model request is one event, so a
`generateText()` with several tool steps records one event per step.

## What is recorded

Per call: requested `model` (the priced field), input / output / cached /
cache-write tokens, latency, success, agent and trace fields, a UUID `event_id`,
and in `metadata`:

| key | meaning |
|---|---|
| `usage_source` | `response`: counts came from the endpoint. `missing`: none arrived; the zeros are placeholders, not zero usage. `estimated`: a framework's own estimate (LangChain only). |
| `response_model` | model the endpoint said it served |
| `response_id` | the endpoint's id for the call, for reconciling with a provider or gateway console |
| `gateway_host` | base URL host when it is not the provider's own (host only, never the path) |
| `stream_options_rejected` | OpenAI only, see above |
| `afc_turns` | Gemini only, see above |
| `_ac_caps` | what the call needed: `vision`, `tools`, `tool_count`, `structured_output` (booleans and counts only) |

Your `metadata()` and `globalMetadata` keys are included; keys the SDK observed
win over yours of the same name. Failed calls are recorded too, with the error
class, HTTP status and error code.

**Never recorded:** prompts, completions, tool definitions or arguments, images,
API keys, or error message text (it can echo your content). Cost is calculated
by the AgentCost server from the model and token counts.

## Delivery

- Batches of up to 100 events, every `flushIntervalMs` (default 5 s) or when
  `batchSize` (default 10) events are queued.
- Network errors, timeouts, 408, 429 and 5xx keep the batch for the next flush,
  with the same `event_id`s, so the server reports a resent batch as duplicates
  instead of storing it twice. Up to `maxRetainedBatches` (default 100) are kept.
- Other 4xx responses (bad key, wrong project) drop the batch, with a warning.
- Tracking never throws into your code and never delays your calls.

## Options

```ts
agentcost.init({
  apiKey,            // default: AGENTCOST_API_KEY
  projectId,         // default: AGENTCOST_PROJECT_ID
  baseUrl,           // default: AGENTCOST_API_URL or https://api.agentcost.tech
  enabled: true,     // false: keep the instrumentation, record nothing
  batchSize: 10,
  flushIntervalMs: 5000,
  defaultAgentName: "default",
  globalMetadata: { env: "prod" },
  localMode: false,  // keep events in memory (getLocalEvents()), send nothing
  timeoutMs: 10000,
  maxRetainedBatches: 100,
  fetch,             // custom fetch (proxy, tests)
  onError: (msg) => log.warn(msg), // delivery problems; never contains content
});
```

## Not tracked

- OpenAI images, audio, moderation, realtime (WebSocket) and the Assistants API.
- Google Gen AI embeddings, image/video generation and the Live API.
- `asResponse()` on OpenAI/Anthropic returns the raw HTTP response, so its usage
  cannot be read; the call is recorded with `usage_source: "missing"`.
- The `stream_options` fallback does not apply inside `responses.stream()`
  (Responses streams do not need it).

## Status

Preview (0.x): the API may still change before 1.0. See the [CHANGELOG](CHANGELOG.md).

## Development

```sh
npm install
npm test     # builds ESM + CJS, runs the suite against fake endpoints
```

CI (`.github/workflows/ci.yml`) runs Node 18, 20, 22 and 24, and older major
versions of every provider SDK.
