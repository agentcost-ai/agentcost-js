/**
 * The official `openai` package (4.x - 7.x), including AzureOpenAI and any
 * OpenAI-compatible base URL (gateways, proxies, self-hosted endpoints).
 *
 * Tracked: chat.completions.create, responses.create, completions.create
 * (legacy), embeddings.create, and everything built on them (parse(),
 * stream(), runTools(), beta.* on v4). Streamed chat and legacy completions
 * get `stream_options.include_usage` unless the caller set stream_options;
 * if the endpoint refuses it, the call is resent once as written.
 */
import { Call, gatewayHostOf, hasNumber, count, type Usage } from "../recorder.js";
import { PATCHED, wrapMethod, type Hooks } from "../stainless.js";

const PARAM_REJECTION =
  /\b(unsupported|unrecogni[sz]ed|unknown|unexpected|extra|not (?:allowed|permitted|supported))\b[^.\n]{0,40}?\b(fields?|param(?:eter)?s?|arguments?|keys?|propert(?:y|ies))\b/i;

/** OpenAI chat/legacy/Responses/embeddings usage, or undefined. */
export function readOpenAIUsage(u: any): Usage | undefined {
  if (!u || typeof u !== "object") return undefined;
  const inputRaw = u.prompt_tokens ?? u.input_tokens;
  const outputRaw = u.completion_tokens ?? u.output_tokens;
  if (!hasNumber(inputRaw, outputRaw, u.total_tokens)) return undefined;
  const input = count(inputRaw);
  const details = u.prompt_tokens_details ?? u.input_tokens_details;
  return { input, output: count(outputRaw), cached: Math.min(count(details?.cached_tokens), input) };
}

export function rejectsStreamOptions(err: any): boolean {
  if (!err) return false;
  const message = String(err?.message ?? "");
  const param = String(err?.param ?? err?.error?.param ?? "");
  if (param.includes("stream_options")) return true;
  if (message.includes("stream_options") || message.includes("include_usage")) return true;
  const status = err?.status;
  return (status === 400 || status === 422) && PARAM_REJECTION.test(message);
}

export function openAIGatewayHost(client: any): string | undefined {
  return gatewayHostOf(client?.baseURL, (h) => h === "api.openai.com");
}

type Kind = "chat" | "completions" | "responses" | "embeddings";

function hooks(kind: Kind, client: any): Hooks {
  return {
    begin(params) {
      const streaming = !!params?.stream;
      const call = new Call({ model: params?.model, streaming, gatewayHost: openAIGatewayHost(client), params });
      let send = params;
      let fallbackAllowed = false;
      if ((kind === "chat" || kind === "completions") && streaming && params.stream_options == null) {
        send = { ...params, stream_options: { include_usage: true } };
        fallbackAllowed = true;
      }
      return { call, send, fallbackAllowed };
    },
    value(call, v) {
      if (!v || typeof v !== "object") return;
      call.identity(v.model, v.id);
      call.setUsage(readOpenAIUsage(v.usage));
    },
    chunk(call, c) {
      if (!c || typeof c !== "object") return;
      if (typeof c.type === "string" && c.type.startsWith("response.")) {
        // Responses API events: identity and usage live on the nested response.
        if (c.response) {
          call.identity(c.response.model, c.response.id);
          call.setUsage(readOpenAIUsage(c.response.usage));
        }
        return;
      }
      call.identity(c.model, c.id);
      call.setUsage(readOpenAIUsage(c.usage));
    },
    refusedInjection: rejectsStreamOptions,
  };
}

/**
 * Track every model call made through this client. Returns the same client.
 * Calling it twice is a no-op; only this instance is affected.
 */
export function instrumentOpenAI<T>(client: T): T {
  const c = client as any;
  if (!c || c[PATCHED]) return client;
  wrapMethod(c.chat?.completions, "create", hooks("chat", c));
  wrapMethod(c.responses, "create", hooks("responses", c));
  wrapMethod(c.completions, "create", hooks("completions", c));
  wrapMethod(c.embeddings, "create", hooks("embeddings", c));
  Object.defineProperty(c, PATCHED, { value: true, enumerable: false });
  return client;
}
