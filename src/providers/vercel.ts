/**
 * Vercel AI SDK (`ai` 5.x - 7.x) middleware, for any provider the AI SDK
 * supports (OpenAI, Anthropic, Google, Bedrock, Mistral, the AI Gateway,
 * OpenAI-compatible endpoints).
 *
 *   import { wrapLanguageModel, generateText, streamText } from "ai";
 *   const model = wrapLanguageModel({ model: openai("gpt-5.6-sol"), middleware: agentcostMiddleware() });
 *
 *   import { wrapEmbeddingModel } from "ai";
 *   const embedder = wrapEmbeddingModel({ model: openai.embedding("..."), middleware: agentcostEmbeddingMiddleware() });
 *
 * Each model request is one event: a generateText() with tool steps makes
 * one request per step, and each is recorded.
 */
import { Call, count, gatewayHostOf, hasNumber, observeIterator, type Usage } from "../recorder.js";

function firstPartyHost(h: string): boolean {
  return h === "api.openai.com" || h === "api.anthropic.com" || h === "googleapis.com" || h.endsWith(".googleapis.com");
}

/**
 * Language model usage, spec v2 (flat numbers) or v3/v4 (nested:
 * inputTokens.total = noCache + cacheRead + cacheWrite).
 */
export function readAISDKUsage(u: any): Usage | undefined {
  if (!u || typeof u !== "object") return undefined;
  const inT = u.inputTokens;
  const outT = u.outputTokens;
  if (inT && typeof inT === "object") {
    if (!hasNumber(inT.total, inT.noCache, outT?.total)) return undefined;
    const read = count(inT.cacheRead);
    const written = count(inT.cacheWrite);
    const total = hasNumber(inT.total) ? count(inT.total) : count(inT.noCache) + read + written;
    const output = hasNumber(outT?.total) ? count(outT.total) : count(outT?.text) + count(outT?.reasoning);
    return { input: Math.max(0, total - written), output, cached: read, cacheWrite: written };
  }
  if (!hasNumber(inT, outT, u.totalTokens)) return undefined;
  return { input: count(inT), output: count(outT), cached: count(u.cachedInputTokens) };
}

function gatewayOf(model: any): string | undefined {
  try {
    const cfg = model?.config;
    let url: unknown = cfg?.baseURL ?? cfg?.baseUrl;
    if (!url && typeof cfg?.url === "function") url = cfg.url({ path: "", modelId: model.modelId });
    return gatewayHostOf(url, firstPartyHost);
  } catch {
    return undefined;
  }
}

function callFor(model: any, params: any, streaming: boolean): Call {
  return new Call({
    model: model?.modelId,
    streaming,
    gatewayHost: gatewayOf(model),
    params: {
      messages: params?.prompt,
      tools: params?.tools,
      toolChoice: params?.tools?.length ? params?.toolChoice : undefined,
      responseFormat: params?.responseFormat?.type === "json" ? params.responseFormat : undefined,
    },
  });
}

function observeResult(call: Call, r: any): void {
  if (!r || typeof r !== "object") return;
  call.identity(r.response?.modelId, r.response?.id);
  call.setUsage(readAISDKUsage(r.usage));
}

function observePart(call: Call, part: any): void {
  if (!part || typeof part !== "object") return;
  if (part.type === "response-metadata") call.identity(part.modelId, part.id);
  else if (part.type === "finish") call.setUsage(readAISDKUsage(part.usage));
}

/** Wrap a ReadableStream so its parts are observed and the call finished once (end, error or cancel). */
function observeStream(stream: ReadableStream<any>, call: Call): ReadableStream<any> {
  const reader = stream.getReader();
  const iterator: AsyncIterator<any> = {
    next: () => reader.read() as Promise<IteratorResult<any>>,
    return: async () => {
      await reader.cancel().catch(() => undefined);
      return { done: true, value: undefined };
    },
  };
  const observed = observeIterator(iterator, call, (part) => {
    observePart(call, part);
    if (part?.type === "error") call.markFailed(part.error);
  });
  return new ReadableStream<any>({
    async pull(controller) {
      try {
        const r = await observed.next();
        if (r.done) controller.close();
        else controller.enqueue(r.value);
      } catch (e) {
        controller.error(e);
      }
    },
    async cancel() {
      await observed.return(undefined);
    },
  });
}

/** Language model middleware. Works with wrapLanguageModel() in ai 5.x - 7.x. */
export function agentcostMiddleware(): any {
  return {
    specificationVersion: "v3",
    async wrapGenerate({ doGenerate, params, model }: any) {
      let call: Call | undefined;
      try {
        call = callFor(model, params, false);
      } catch {
        /* untracked */
      }
      let result: any;
      try {
        result = await doGenerate();
      } catch (e) {
        call?.finish(e);
        throw e;
      }
      if (call) {
        try {
          observeResult(call, result);
        } catch {
          /* observation must never break the call */
        }
        call.finish();
      }
      return result;
    },
    async wrapStream({ doStream, params, model }: any) {
      let call: Call | undefined;
      try {
        call = callFor(model, params, true);
      } catch {
        /* untracked */
      }
      let result: any;
      try {
        result = await doStream();
      } catch (e) {
        call?.finish(e);
        throw e;
      }
      if (!call || !result?.stream || typeof result.stream.getReader !== "function") {
        call?.finish();
        return result;
      }
      return { ...result, stream: observeStream(result.stream, call) };
    },
  };
}

/** Embedding model middleware. Works with wrapEmbeddingModel() in ai 5.x - 7.x. */
export function agentcostEmbeddingMiddleware(): any {
  return {
    specificationVersion: "v3",
    async wrapEmbed({ doEmbed, model }: any) {
      let call: Call | undefined;
      try {
        call = new Call({ model: model?.modelId, gatewayHost: gatewayOf(model) });
      } catch {
        /* untracked */
      }
      let result: any;
      try {
        result = await doEmbed();
      } catch (e) {
        call?.finish(e);
        throw e;
      }
      if (call) {
        const tokens = result?.usage?.tokens;
        if (hasNumber(tokens)) call.setUsage({ input: count(tokens), output: 0 });
        call.identity(result?.response?.modelId, result?.response?.id);
        call.finish();
      }
      return result;
    },
  };
}
