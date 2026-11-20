/**
 * `@google/genai` (Gemini API and Vertex AI).
 *
 * Tracked: models.generateContent and models.generateContentStream, and
 * everything built on them (chats.sendMessage / sendMessageStream).
 *
 * Output counts include thinking tokens (`thoughtsTokenCount`), which Gemini
 * bills at the output rate but reports outside `candidatesTokenCount`; input
 * includes `toolUsePromptTokenCount`. With automatic function calling, one
 * generateContent() may make several billed requests but only the last one's
 * usage is returned; the number of requests is recorded in
 * `metadata.afc_turns` so the shortfall is visible.
 */
import { Call, count, gatewayHostOf, hasNumber, observeIterator, type Usage } from "../recorder.js";
import { PATCHED } from "../stainless.js";

export function readGeminiUsage(u: any): Usage | undefined {
  if (!u || typeof u !== "object") return undefined;
  const prompt = u.promptTokenCount ?? u.prompt_token_count;
  const candidates = u.candidatesTokenCount ?? u.candidates_token_count;
  if (!hasNumber(prompt, candidates, u.totalTokenCount)) return undefined;
  const input = count(prompt) + count(u.toolUsePromptTokenCount ?? u.tool_use_prompt_token_count);
  return {
    input,
    output: count(candidates) + count(u.thoughtsTokenCount ?? u.thoughts_token_count),
    cached: Math.min(count(u.cachedContentTokenCount ?? u.cached_content_token_count), input),
  };
}

function afcTurns(response: any): number {
  const history = response?.automaticFunctionCallingHistory;
  if (!Array.isArray(history)) return 1;
  let replies = 0;
  for (const content of history) {
    const parts = content?.parts;
    if (Array.isArray(parts) && parts.some((p: any) => p?.functionResponse != null)) replies++;
  }
  return replies + 1;
}

function observe(call: Call, r: any): void {
  if (!r || typeof r !== "object") return;
  call.identity(r.modelVersion, r.responseId);
  call.setUsage(readGeminiUsage(r.usageMetadata));
}

function baseUrl(client: any): string | undefined {
  try {
    return client?.apiClient?.getBaseUrl?.();
  } catch {
    return undefined;
  }
}

/** Track every generateContent call made through this client. Returns the same client. */
export function instrumentGoogleGenAI<T>(client: T): T {
  const c = client as any;
  const models = c?.models;
  if (!models || c[PATCHED]) return client;
  const gateway = () => gatewayHostOf(baseUrl(c), (h) => h === "googleapis.com" || h.endsWith(".googleapis.com"));

  const gen = models.generateContent;
  if (typeof gen === "function") {
    const bound = gen.bind(models);
    models.generateContent = async (params: any, ...rest: any[]) => {
      let call: Call | undefined;
      try {
        call = new Call({ model: params?.model, gatewayHost: gateway(), params });
      } catch {
        /* untracked */
      }
      let res: any;
      try {
        res = await bound(params, ...rest);
      } catch (e) {
        call?.finish(e);
        throw e;
      }
      if (call) {
        try {
          observe(call, res);
          const turns = afcTurns(res);
          if (turns > 1) call.meta("afc_turns", turns);
        } catch {
          /* observation must never break the call */
        }
        call.finish();
      }
      return res;
    };
  }

  const stream = models.generateContentStream;
  if (typeof stream === "function") {
    const bound = stream.bind(models);
    models.generateContentStream = async (params: any, ...rest: any[]) => {
      let call: Call | undefined;
      try {
        call = new Call({ model: params?.model, streaming: true, gatewayHost: gateway(), params });
      } catch {
        /* untracked */
      }
      let gen: any;
      try {
        gen = await bound(params, ...rest);
      } catch (e) {
        call?.finish(e);
        throw e;
      }
      if (!call || !gen || typeof gen[Symbol.asyncIterator] !== "function") return gen;
      const tracked = call;
      return observeIterator(gen[Symbol.asyncIterator](), tracked, (chunk) => observe(tracked, chunk));
    };
  }

  Object.defineProperty(c, PATCHED, { value: true, enumerable: false });
  return client;
}
