import OpenAI from "openai";

export const GATEWAY = "https://gateway.example/v1";
export const MODEL = "gpt-5.6-sol";
export const SERVED = "gpt-5.6-sol-2026-09-01";
export const SECRET_PROMPT = "PROMPT-SENTINEL-do-not-ship";
export const SECRET_REPLY = "REPLY-SENTINEL-do-not-ship";
export const GATEWAY_KEY = "gateway-test-key-SENTINEL";

export type Handler = (body: any, url: string) => Response | Promise<Response>;

export function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

export function apiError(status: number, message: string, extra: Record<string, unknown> = {}): Response {
  return json(status, { error: { message, type: "invalid_request_error", code: null, ...extra } });
}

export function sse(events: unknown[], done = true): Response {
  const text = events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("") + (done ? "data: [DONE]\n\n" : "");
  return new Response(text, { status: 200, headers: { "content-type": "text/event-stream" } });
}

/** Pass null to omit usage entirely. */
export function chatCompletion(usage: unknown = { prompt_tokens: 12, completion_tokens: 3, total_tokens: 15 }) {
  return {
    id: "chatcmpl-123",
    object: "chat.completion",
    created: 1,
    model: SERVED,
    choices: [{ index: 0, message: { role: "assistant", content: SECRET_REPLY }, finish_reason: "stop" }],
    ...(usage === null ? {} : { usage }),
  };
}

export function chatChunks(withUsage: boolean) {
  const base = { id: "chatcmpl-456", object: "chat.completion.chunk", created: 1, model: SERVED };
  const chunks: unknown[] = [
    { ...base, choices: [{ index: 0, delta: { role: "assistant", content: SECRET_REPLY }, finish_reason: null }] },
    { ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
  ];
  if (withUsage) chunks.push({ ...base, choices: [], usage: { prompt_tokens: 20, completion_tokens: 4, total_tokens: 24, prompt_tokens_details: { cached_tokens: 16 } } });
  return chunks;
}

export function responseObject() {
  return {
    id: "resp_789",
    object: "response",
    created_at: 1,
    status: "completed",
    model: SERVED,
    output: [{ type: "message", id: "msg_1", status: "completed", role: "assistant", content: [{ type: "output_text", text: SECRET_REPLY, annotations: [] }] }],
    usage: { input_tokens: 30, output_tokens: 5, total_tokens: 35, input_tokens_details: { cached_tokens: 10 }, output_tokens_details: { reasoning_tokens: 0 } },
  };
}

export function responseEvents() {
  const r = responseObject();
  const created = { ...r, status: "in_progress", output: [], usage: null };
  const item = r.output[0];
  const part = { type: "output_text", text: "", annotations: [] };
  const ids = { item_id: "msg_1", output_index: 0, content_index: 0 };
  return [
    { type: "response.created", response: created },
    { type: "response.in_progress", response: created },
    { type: "response.output_item.added", output_index: 0, item: { ...item, status: "in_progress", content: [] } },
    { type: "response.content_part.added", ...ids, part },
    { type: "response.output_text.delta", ...ids, delta: SECRET_REPLY, logprobs: [] },
    { type: "response.output_text.done", ...ids, text: SECRET_REPLY, logprobs: [] },
    { type: "response.content_part.done", ...ids, part: { ...part, text: SECRET_REPLY } },
    { type: "response.output_item.done", output_index: 0, item },
    { type: "response.completed", response: r },
  ].map((e, i) => ({ ...e, sequence_number: i }));
}

/** A programmable OpenAI-compatible endpoint. */
export class Endpoint {
  requests: { url: string; body: any }[] = [];
  private queue: Handler[] = [];

  push(...handlers: Handler[]): this {
    this.queue.push(...handlers);
    return this;
  }

  fetch = async (input: any, init?: any): Promise<Response> => {
    const url = typeof input === "string" ? input : input.url;
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    this.requests.push({ url, body });
    const h = this.queue.shift();
    if (!h) throw new Error(`unexpected request to ${url}`);
    return h(body, url);
  };

  client(baseURL = GATEWAY): OpenAI {
    return new OpenAI({ apiKey: GATEWAY_KEY, baseURL, maxRetries: 0, fetch: this.fetch as any });
  }
}

/** A fake AgentCost backend capturing every batch. */
export class Backend {
  batches: any[] = [];
  statuses: number[] = [];

  constructor(private readonly plan: number[] = []) {}

  fetch = async (_input: any, init?: any): Promise<Response> => {
    const body = JSON.parse(String(init?.body));
    this.batches.push(body);
    const status = this.plan.shift() ?? 200;
    this.statuses.push(status);
    if (status !== 200) return json(status, { detail: "nope" });
    return json(200, { status: "ok", events_received: body.events.length, events_stored: body.events.length, events_rejected: 0 });
  };
}

/** SSE with named events (Anthropic). */
export function sseNamed(events: { type: string }[]): Response {
  const text = events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join("");
  return new Response(text, { status: 200, headers: { "content-type": "text/event-stream" } });
}

export function anthropicMessage() {
  return {
    id: "msg_1",
    type: "message",
    role: "assistant",
    model: "claude-served-1",
    content: [{ type: "text", text: SECRET_REPLY }],
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: { input_tokens: 10, output_tokens: 4, cache_read_input_tokens: 100, cache_creation_input_tokens: 20 },
  };
}

export function anthropicEvents() {
  const m = anthropicMessage();
  return [
    { type: "message_start", message: { ...m, content: [], stop_reason: null, usage: { ...m.usage, output_tokens: 1 } } },
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: SECRET_REPLY } },
    { type: "content_block_stop", index: 0 },
    { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 4 } },
    { type: "message_stop" },
  ];
}

export function geminiResponse(usage: unknown = { promptTokenCount: 50, candidatesTokenCount: 6, thoughtsTokenCount: 20, cachedContentTokenCount: 30, totalTokenCount: 76 }) {
  return {
    candidates: [{ content: { role: "model", parts: [{ text: SECRET_REPLY }] }, finishReason: "STOP", index: 0 }],
    ...(usage === null ? {} : { usageMetadata: usage }),
    modelVersion: "gemini-served-001",
    responseId: "gr_1",
  };
}

export function embeddingList() {
  return { object: "list", data: [{ object: "embedding", index: 0, embedding: [0.1, 0.2] }], model: "text-embedding-3-small", usage: { prompt_tokens: 5, total_tokens: 5 } };
}

export function legacyCompletion() {
  return { id: "cmpl-1", object: "text_completion", created: 1, model: SERVED, choices: [{ index: 0, text: SECRET_REPLY, finish_reason: "stop", logprobs: null }], usage: { prompt_tokens: 8, completion_tokens: 2, total_tokens: 10 } };
}
