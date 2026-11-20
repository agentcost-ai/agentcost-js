/**
 * `@anthropic-ai/sdk` (and the Bedrock / Vertex clients built on it).
 *
 * Tracked: messages.create and beta.messages.create, streamed or not, and the
 * helpers built on them (messages.stream(), parse(), toolRunner()).
 *
 * Anthropic reports cache reads and writes alongside `input_tokens` (which is
 * only the uncached remainder). Normalised to the backend convention, like the
 * Python SDK: input = uncached + cache reads, cached = cache reads, cache
 * writes reported separately.
 */
import { Call, count, gatewayHostOf, hasNumber, type Usage } from "../recorder.js";
import { PATCHED, wrapMethod, type Hooks } from "../stainless.js";

export function readAnthropicUsage(u: any): Usage | undefined {
  if (!u || typeof u !== "object") return undefined;
  if (!hasNumber(u.input_tokens, u.output_tokens)) return undefined;
  const read = count(u.cache_read_input_tokens);
  return {
    input: count(u.input_tokens) + read,
    output: count(u.output_tokens),
    cached: read,
    cacheWrite: count(u.cache_creation_input_tokens),
  };
}

export function anthropicGatewayHost(client: any): string | undefined {
  return gatewayHostOf(client?.baseURL, (h) => h === "api.anthropic.com");
}

function hooks(client: any): Hooks {
  return {
    begin(params) {
      const call = new Call({ model: params?.model, streaming: !!params?.stream, gatewayHost: anthropicGatewayHost(client), params });
      return { call, send: params, fallbackAllowed: false };
    },
    value(call, v) {
      if (!v || typeof v !== "object") return;
      call.identity(v.model, v.id);
      call.setUsage(readAnthropicUsage(v.usage));
    },
    chunk(call, e) {
      if (!e || typeof e !== "object") return;
      if (e.type === "message_start" && e.message) {
        call.identity(e.message.model, e.message.id);
        call.setUsage(readAnthropicUsage(e.message.usage));
      } else if (e.type === "message_delta" && e.usage) {
        // Cumulative counts. Output always; input and cache fields only when
        // the API includes them on the delta.
        const u = e.usage;
        const patch: Partial<Usage> = { output: count(u.output_tokens) };
        if (hasNumber(u.input_tokens)) {
          const read = count(u.cache_read_input_tokens);
          patch.input = count(u.input_tokens) + read;
          if (hasNumber(u.cache_read_input_tokens)) patch.cached = read;
        }
        if (hasNumber(u.cache_creation_input_tokens)) patch.cacheWrite = count(u.cache_creation_input_tokens);
        call.mergeUsage(patch);
      }
    },
  };
}

/** Track every Messages call made through this client. Returns the same client. */
export function instrumentAnthropic<T>(client: T): T {
  const c = client as any;
  if (!c || c[PATCHED]) return client;
  wrapMethod(c.messages, "create", hooks(c));
  wrapMethod(c.beta?.messages, "create", hooks(c));
  Object.defineProperty(c, PATCHED, { value: true, enumerable: false });
  return client;
}
