import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import Anthropic from "@anthropic-ai/sdk";
import { GoogleGenAI } from "@google/genai";
import { ChatOpenAI } from "@langchain/openai";
import OpenAI, { AzureOpenAI } from "openai";
import { createOpenAI } from "@ai-sdk/openai";
import * as aiSdk from "ai";
import * as ac from "../src/index.js";
import {
  Endpoint, GATEWAY, MODEL, SERVED, SECRET_PROMPT, SECRET_REPLY, GATEWAY_KEY,
  anthropicEvents, anthropicMessage, apiError, chatChunks, chatCompletion, embeddingList,
  geminiResponse, json, legacyCompletion, responseObject, sse, sseNamed,
} from "./helpers.js";

const MSG = [{ role: "user" as const, content: SECRET_PROMPT }];
const { generateText, streamText, wrapLanguageModel } = aiSdk;
// wrapEmbeddingModel exists from ai 6.
const wrapEmbeddingModel = (aiSdk as any).wrapEmbeddingModel as typeof import("ai").wrapEmbeddingModel | undefined;

function events(): any[] {
  return ac.getLocalEvents().filter((e: any) => e.record_type !== "outcome");
}
function only(): any {
  const ev = events();
  assert.equal(ev.length, 1, `expected one event, got ${ev.length}`);
  return ev[0];
}
async function drain(iter: AsyncIterable<unknown>) {
  for await (const _ of iter) void _;
}
function noLeak() {
  const wire = JSON.stringify(ac.getLocalEvents());
  for (const s of [SECRET_PROMPT, SECRET_REPLY, GATEWAY_KEY]) assert.ok(!wire.includes(s), `leaked ${s}`);
}

beforeEach(() => ac.init({ localMode: true }));
afterEach(() => ac.shutdown());

describe("openai: more endpoints and options", () => {
  test("embeddings", async () => {
    const ep = new Endpoint().push(() => json(200, embeddingList()));
    const c = ac.instrumentOpenAI(ep.client());
    await c.embeddings.create({ model: "text-embedding-3-small", input: SECRET_PROMPT });
    const e = only();
    assert.deepEqual([e.model, e.input_tokens, e.output_tokens, e.metadata.usage_source], ["text-embedding-3-small", 5, 0, "response"]);
    noLeak();
  });

  test("legacy completions, plain and streamed (with include_usage)", async () => {
    const chunk = { ...legacyCompletion(), usage: null, choices: [{ index: 0, text: SECRET_REPLY, finish_reason: null, logprobs: null }] };
    const last = { ...legacyCompletion(), choices: [] };
    const ep = new Endpoint().push(() => json(200, legacyCompletion()), () => sse([chunk, last]));
    const c = ac.instrumentOpenAI(ep.client());
    await c.completions.create({ model: "gpt-3.5-turbo-instruct", prompt: SECRET_PROMPT });
    await drain(await c.completions.create({ model: "gpt-3.5-turbo-instruct", prompt: SECRET_PROMPT, stream: true }));
    assert.deepEqual(ep.requests[1].body.stream_options, { include_usage: true });
    const [a, b] = events();
    assert.deepEqual([a.input_tokens, a.output_tokens, b.input_tokens, b.streaming], [8, 2, 8, true]);
    noLeak();
  });

  test("AzureOpenAI: gateway host is the Azure resource host", async () => {
    const ep = new Endpoint().push(() => json(200, chatCompletion()));
    const c = ac.instrumentOpenAI(new AzureOpenAI({ apiKey: GATEWAY_KEY, endpoint: "https://myres.openai.azure.com", apiVersion: "2024-10-21", deployment: "dep", fetch: ep.fetch as any, maxRetries: 0 }));
    await c.chat.completions.create({ model: MODEL, messages: MSG });
    assert.equal(only().metadata.gateway_host, "myres.openai.azure.com");
  });

  test("capability fingerprint: booleans and counts only", async () => {
    const ep = new Endpoint().push(() => json(200, chatCompletion()), () => json(200, chatCompletion()));
    const c = ac.instrumentOpenAI(ep.client());
    await c.chat.completions.create({
      model: MODEL,
      messages: [{ role: "user", content: [{ type: "text", text: SECRET_PROMPT }, { type: "image_url", image_url: { url: "data:image/png;base64,SECRETIMG" } }] }],
      tools: [{ type: "function", function: { name: "secret_tool_name", parameters: {} } }],
      response_format: { type: "json_object" },
    });
    await c.chat.completions.create({ model: MODEL, messages: MSG });
    const [withCaps, plain] = events();
    assert.deepEqual(withCaps.metadata._ac_caps, { vision: true, tools: true, tool_count: 1, structured_output: true });
    assert.equal("_ac_caps" in plain.metadata, false, "omitted when nothing notable was used");
    const wire = JSON.stringify(withCaps);
    assert.ok(!wire.includes("SECRETIMG") && !wire.includes("secret_tool_name"));
  });

  test("asResponse(): recorded, honestly marked missing", async () => {
    const ep = new Endpoint().push(() => json(200, chatCompletion()));
    const c = ac.instrumentOpenAI(ep.client());
    const raw = await c.chat.completions.create({ model: MODEL, messages: MSG }).asResponse();
    assert.equal(raw.status, 200);
    await new Promise((r) => setTimeout(r, 5));
    assert.equal(only().metadata.usage_source, "missing");
  });

  test("withResponse() on a stream does not end the call early", async () => {
    const ep = new Endpoint().push(() => sse(chatChunks(true)));
    const c = ac.instrumentOpenAI(ep.client());
    const { data } = await c.chat.completions.create({ model: MODEL, messages: MSG, stream: true }).withResponse();
    await new Promise((r) => setTimeout(r, 5));
    assert.equal(events().length, 0, "not recorded before the stream is read");
    await drain(data);
    assert.equal(only().metadata.usage_source, "response");
  });

  test("enabled: false records nothing; globalMetadata is attached", async () => {
    ac.init({ localMode: true, enabled: false });
    const ep = new Endpoint().push(() => json(200, chatCompletion()), () => json(200, chatCompletion()));
    await ac.instrumentOpenAI(ep.client()).chat.completions.create({ model: MODEL, messages: MSG });
    assert.equal(events().length, 0);
    ac.init({ localMode: true, globalMetadata: { env: "test", customer: "global" } });
    await ac.metadata({ customer: "call" }, () => ac.instrumentOpenAI(ep.client()).chat.completions.create({ model: MODEL, messages: MSG }));
    const e = only();
    assert.equal(e.metadata.env, "test");
    assert.equal(e.metadata.customer, "call", "call metadata beats global metadata");
  });

  test("runTools() helper records each request", async () => {
    const toolCall = {
      ...chatCompletion(),
      choices: [{ index: 0, finish_reason: "tool_calls", message: { role: "assistant", content: null, tool_calls: [{ id: "t1", type: "function", function: { name: "lookup", arguments: "{}" } }] } }],
    };
    const ep = new Endpoint().push(() => json(200, toolCall), () => json(200, chatCompletion()));
    const c = ac.instrumentOpenAI(ep.client()) as any;
    const res = c.chat.completions.runTools ? c.chat.completions : c.beta.chat.completions;
    const runner = res.runTools({
      model: MODEL,
      messages: MSG,
      tools: [{ type: "function", function: { name: "lookup", parameters: { type: "object", properties: {} }, function: () => "ok" } }],
    });
    await runner.finalContent();
    assert.equal(events().length, 2);
    assert.ok(events().every((e) => e.metadata._ac_caps?.tools === true));
  });
});

describe("anthropic", () => {
  const client = (ep: Endpoint, baseURL = "https://gateway.example") =>
    ac.instrumentAnthropic(new Anthropic({ apiKey: GATEWAY_KEY, baseURL, fetch: ep.fetch as any, maxRetries: 0 }));

  test("messages.create: cache reads folded into input, writes separate", async () => {
    const ep = new Endpoint().push(() => json(200, anthropicMessage()));
    await client(ep).messages.create({ model: "claude-x", max_tokens: 16, messages: MSG });
    const e = only();
    assert.equal(e.model, "claude-x");
    assert.deepEqual([e.input_tokens, e.output_tokens, e.cached_tokens, e.cache_write_tokens], [110, 4, 100, 20]);
    assert.equal(e.metadata.response_model, "claude-served-1");
    assert.equal(e.metadata.response_id, "msg_1");
    assert.equal(e.metadata.gateway_host, "gateway.example");
    assert.equal(e.metadata.usage_source, "response");
    noLeak();
  });

  test("api.anthropic.com is not a gateway", async () => {
    const ep = new Endpoint().push(() => json(200, anthropicMessage()));
    await client(ep, "https://api.anthropic.com").messages.create({ model: "claude-x", max_tokens: 16, messages: MSG });
    assert.equal("gateway_host" in only().metadata, false);
  });

  test("stream: true", async () => {
    const ep = new Endpoint().push(() => sseNamed(anthropicEvents()));
    const s = await client(ep).messages.create({ model: "claude-x", max_tokens: 16, messages: MSG, stream: true });
    await drain(s);
    const e = only();
    assert.equal(e.streaming, true);
    assert.deepEqual([e.input_tokens, e.output_tokens, e.cached_tokens, e.cache_write_tokens], [110, 4, 100, 20]);
    assert.equal(e.metadata.response_id, "msg_1");
  });

  test("messages.stream() helper", async () => {
    const ep = new Endpoint().push(() => sseNamed(anthropicEvents()));
    const final = await client(ep).messages.stream({ model: "claude-x", max_tokens: 16, messages: MSG }).finalMessage();
    assert.equal(final.id, "msg_1");
    assert.deepEqual([only().input_tokens, only().output_tokens], [110, 4]);
  });

  test("beta.messages.create", async () => {
    const ep = new Endpoint().push(() => json(200, anthropicMessage()));
    await client(ep).beta.messages.create({ model: "claude-x", max_tokens: 16, messages: MSG });
    assert.equal(only().input_tokens, 110);
  });

  test("gateway error bodies: the nested code is used", async () => {
    const ep = new Endpoint().push(() => json(503, { error: { code: "model_not_found", message: SECRET_PROMPT, type: "gateway_error" } }));
    await assert.rejects(client(ep).messages.create({ model: "claude-x", max_tokens: 16, messages: MSG }));
    assert.match(only().error, /^\w+ 503 model_not_found$/);
    noLeak();
  });

  test("errors are recorded without message text; tools fingerprinted", async () => {
    const ep = new Endpoint().push(() => json(529, { type: "error", error: { type: "overloaded_error", message: SECRET_PROMPT } }));
    await assert.rejects(client(ep).messages.create({
      model: "claude-x", max_tokens: 16, messages: MSG,
      tools: [{ name: "t", input_schema: { type: "object" } }],
    }));
    const e = only();
    assert.equal(e.success, false);
    assert.match(e.error, /529/);
    assert.match(e.error, /overloaded_error/);
    assert.equal(e.metadata._ac_caps.tool_count, 1);
    noLeak();
  });
});

describe("google gen ai", () => {
  const realFetch = globalThis.fetch;
  let ep: Endpoint;
  beforeEach(() => {
    ep = new Endpoint();
    globalThis.fetch = ep.fetch as any;
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
  });
  const client = (baseUrl?: string) =>
    ac.instrumentGoogleGenAI(new GoogleGenAI({ apiKey: GATEWAY_KEY, ...(baseUrl ? { httpOptions: { baseUrl } } : {}) }));

  test("generateContent: thinking counted as output, cache as subset", async () => {
    ep.push(() => json(200, geminiResponse()));
    const r: any = await client().models.generateContent({ model: "gemini-x", contents: SECRET_PROMPT });
    const e = only();
    assert.deepEqual([e.model, e.input_tokens, e.output_tokens, e.cached_tokens], ["gemini-x", 50, 26, 30]);
    assert.equal(e.metadata.response_model, "gemini-served-001");
    // Older @google/genai versions drop responseId from the response object.
    assert.equal(e.metadata.response_id, r.responseId);
    assert.equal("gateway_host" in e.metadata, false, "googleapis.com is first-party");
    noLeak();
  });

  test("custom base URL is a gateway; missing usage is missing", async () => {
    ep.push(() => json(200, geminiResponse(null)));
    await client("https://gw.example").models.generateContent({ model: "gemini-x", contents: SECRET_PROMPT });
    const e = only();
    assert.equal(e.metadata.gateway_host, "gw.example");
    assert.equal(e.metadata.usage_source, "missing");
  });

  test("generateContentStream", async () => {
    const partial = geminiResponse({ promptTokenCount: 50, candidatesTokenCount: 1, totalTokenCount: 51 });
    ep.push(() => sse([partial, geminiResponse()], false));
    const stream = await client().models.generateContentStream({ model: "gemini-x", contents: SECRET_PROMPT });
    await drain(stream);
    const e = only();
    assert.equal(e.streaming, true);
    assert.deepEqual([e.input_tokens, e.output_tokens], [50, 26]);
  });

  test("chats.sendMessage goes through the tracked method", async () => {
    ep.push(() => json(200, geminiResponse()));
    const chat = client().chats.create({ model: "gemini-x" });
    await ac.agent("gem-agent", () => chat.sendMessage({ message: SECRET_PROMPT }));
    assert.equal(only().agent_name, "gem-agent");
  });

  test("config.tools and responseSchema are fingerprinted", async () => {
    ep.push(() => json(200, geminiResponse()));
    await client().models.generateContent({
      model: "gemini-x",
      contents: [{ role: "user", parts: [{ text: SECRET_PROMPT }, { inlineData: { mimeType: "image/png", data: "SECRETIMG" } }] }],
      config: { tools: [{ functionDeclarations: [{ name: "f" }] }], responseMimeType: "application/json" },
    });
    assert.deepEqual(only().metadata._ac_caps, { vision: true, tools: true, tool_count: 1, structured_output: true });
    assert.ok(!JSON.stringify(only()).includes("SECRETIMG"));
  });

  test("errors are recorded", async () => {
    ep.push(() => json(429, { error: { code: 429, message: SECRET_PROMPT, status: "RESOURCE_EXHAUSTED" } }));
    await assert.rejects(client().models.generateContent({ model: "gemini-x", contents: SECRET_PROMPT }));
    const e = only();
    assert.equal(e.success, false);
    noLeak();
  });
});

describe("langchain", () => {
  const model = (ep: Endpoint, extra: Record<string, unknown> = {}) =>
    new ChatOpenAI({ model: MODEL, apiKey: GATEWAY_KEY, maxRetries: 0, configuration: { baseURL: GATEWAY, fetch: ep.fetch as any }, callbacks: [ac.agentcostCallbacks()], ...extra });

  test("invoke: usage, identity, attribution", async () => {
    const ep = new Endpoint().push(() => json(200, chatCompletion()));
    await ac.agent("lc-agent", () => ac.workflow("lc-job", () => model(ep).invoke(SECRET_PROMPT)));
    const e = only();
    assert.equal(e.model, MODEL);
    assert.deepEqual([e.input_tokens, e.output_tokens], [12, 3]);
    assert.equal(e.metadata.usage_source, "response");
    assert.equal(e.metadata.response_model, SERVED);
    assert.equal(e.agent_name, "lc-agent");
    assert.equal(e.workflow, "lc-job");
    noLeak();
  });

  test("stream", async () => {
    const ep = new Endpoint().push(() => sse(chatChunks(true)));
    await drain(await model(ep).stream(SECRET_PROMPT));
    const e = only();
    assert.deepEqual([e.input_tokens, e.output_tokens, e.cached_tokens], [20, 4, 16]);
  });

  test("concurrent calls keep their own attribution", async () => {
    const ep = new Endpoint();
    for (let i = 0; i < 4; i++) ep.push(() => json(200, chatCompletion()));
    const m = model(ep);
    await Promise.all(["a", "b", "c", "d"].map((name) => ac.agent(name, () => m.invoke(SECRET_PROMPT))));
    assert.deepEqual(events().map((e) => e.agent_name).sort(), ["a", "b", "c", "d"]);
  });

  test("errors are recorded", async () => {
    const ep = new Endpoint().push(() => apiError(500, SECRET_PROMPT));
    await assert.rejects(model(ep).invoke(SECRET_PROMPT));
    const e = only();
    assert.equal(e.success, false);
    assert.equal(e.metadata.usage_source, "missing");
    noLeak();
  });

  test("handler unit: estimated usage is labelled estimated", () => {
    const h = ac.agentcostCallbacks();
    h.handleLLMStart({ kwargs: { model: "m" } }, ["p"], "run-1");
    h.handleLLMEnd({ generations: [[{ text: "x" }]], llmOutput: { estimatedTokenUsage: { promptTokens: 9, completionTokens: 1 } } }, "run-1");
    const e = only();
    assert.equal(e.metadata.usage_source, "estimated");
    assert.equal(e.input_tokens, 9);
  });

  test("handler unit: cache writes are not double counted", () => {
    const h = ac.agentcostCallbacks();
    h.handleChatModelStart({}, [[]], "run-2", undefined, { invocation_params: { model: "claude-x" } });
    h.handleLLMEnd({ generations: [[{ text: "x", message: { usage_metadata: { input_tokens: 130, output_tokens: 4, input_token_details: { cache_read: 100, cache_creation: 20 } } } }]] }, "run-2");
    const e = only();
    assert.deepEqual([e.input_tokens, e.cached_tokens, e.cache_write_tokens], [110, 100, 20]);
  });
});

describe("vercel ai sdk", () => {
  const provider = (ep: Endpoint) => createOpenAI({ apiKey: GATEWAY_KEY, baseURL: GATEWAY, fetch: ep.fetch as any });

  test("generateText", async () => {
    const ep = new Endpoint().push(() => json(200, chatCompletion()));
    const model = wrapLanguageModel({ model: provider(ep).chat(MODEL), middleware: ac.agentcostMiddleware() });
    await ac.agent("ai-agent", () => generateText({ model, prompt: SECRET_PROMPT, maxRetries: 0 }));
    const e = only();
    assert.equal(e.model, MODEL);
    assert.deepEqual([e.input_tokens, e.output_tokens], [12, 3]);
    assert.equal(e.metadata.response_id, "chatcmpl-123");
    assert.equal(e.metadata.response_model, SERVED);
    assert.equal(e.metadata.gateway_host, "gateway.example");
    assert.equal(e.agent_name, "ai-agent");
    noLeak();
  });

  test("streamText", async () => {
    const ep = new Endpoint().push(() => sse(chatChunks(true)));
    const model = wrapLanguageModel({ model: provider(ep).chat(MODEL), middleware: ac.agentcostMiddleware() });
    const r = streamText({ model, prompt: SECRET_PROMPT, maxRetries: 0 });
    await drain(r.textStream);
    const e = only();
    assert.equal(e.streaming, true);
    assert.deepEqual([e.input_tokens, e.output_tokens, e.cached_tokens], [20, 4, 16]);
    assert.equal(e.metadata.usage_source, "response");
  });

  test("Responses API model", async () => {
    const ep = new Endpoint().push(() => json(200, responseObject()));
    const model = wrapLanguageModel({ model: provider(ep).responses(MODEL), middleware: ac.agentcostMiddleware() });
    await generateText({ model, prompt: SECRET_PROMPT, maxRetries: 0 });
    const e = only();
    assert.deepEqual([e.input_tokens, e.output_tokens, e.cached_tokens], [30, 5, 10]);
    assert.equal(e.metadata.response_id, "resp_789");
  });

  test("failed request", async () => {
    const ep = new Endpoint().push(() => apiError(503, SECRET_PROMPT));
    const model = wrapLanguageModel({ model: provider(ep).chat(MODEL), middleware: ac.agentcostMiddleware() });
    await assert.rejects(generateText({ model, prompt: SECRET_PROMPT, maxRetries: 0 }));
    const e = only();
    assert.equal(e.success, false);
    noLeak();
  });

  test("embeddings middleware (ai 6+)", { skip: !wrapEmbeddingModel && "wrapEmbeddingModel needs ai 6+" }, async () => {
    const ep = new Endpoint().push(() => json(200, embeddingList()));
    const model = wrapEmbeddingModel!({ model: provider(ep).embedding("text-embedding-3-small"), middleware: ac.agentcostEmbeddingMiddleware() });
    await aiSdk.embed({ model, value: SECRET_PROMPT, maxRetries: 0 });
    const e = only();
    assert.deepEqual([e.model, e.input_tokens, e.output_tokens], ["text-embedding-3-small", 5, 0]);
  });
});

void OpenAI;
