/**
 * LangChain.js callback handler (`@langchain/core` 0.2+ / 1.x), for any chat
 * model or LLM: ChatOpenAI, ChatAnthropic, ChatGoogleGenerativeAI, Bedrock,
 * Ollama, and LangGraph agents built on them.
 *
 *   const model = new ChatOpenAI({ ..., callbacks: [agentcostCallbacks()] });
 *   // or per call: model.invoke(input, { callbacks: [agentcostCallbacks()] })
 *
 * A plain object implementing LangChain's handler methods, so this package
 * has no dependency on LangChain. Handlers are awaited inline, so attribution
 * (agent, workflow, metadata) is taken from where the model was called.
 *
 * Usage comes from the message's `usage_metadata` (LangChain's standard
 * field) or the model's `llmOutput.tokenUsage`. When LangChain only provides
 * its own `estimatedTokenUsage`, the event says `usage_source: "estimated"`.
 *
 * Do not also instrument the provider client LangChain uses internally; that
 * would record each call twice.
 */
import { Call, count, gatewayHostOf, hasNumber, USAGE_ESTIMATED, type Usage } from "../recorder.js";

function firstPartyHost(h: string): boolean {
  return h === "api.openai.com" || h === "api.anthropic.com" || h === "googleapis.com" || h.endsWith(".googleapis.com");
}

/** LangChain `usage_metadata` (input_tokens includes cache reads AND cache writes). */
export function readLangChainUsage(u: any): Usage | undefined {
  if (!u || typeof u !== "object" || !hasNumber(u.input_tokens, u.output_tokens)) return undefined;
  const d = u.input_token_details ?? {};
  const written = count(d.cache_creation);
  return {
    input: Math.max(0, count(u.input_tokens) - written),
    output: count(u.output_tokens),
    cached: count(d.cache_read),
    cacheWrite: written,
  };
}

function readTokenUsage(t: any): Usage | undefined {
  if (!t || typeof t !== "object" || !hasNumber(t.promptTokens, t.completionTokens)) return undefined;
  return { input: count(t.promptTokens), output: count(t.completionTokens) };
}

function sumUsage(list: Usage[]): Usage | undefined {
  if (!list.length) return undefined;
  return list.reduce((a, b) => ({
    input: a.input + b.input,
    output: a.output + b.output,
    cached: count(a.cached) + count(b.cached),
    cacheWrite: count(a.cacheWrite) + count(b.cacheWrite),
  }));
}

function modelName(serialized: any, extraParams: any, metadata: any): unknown {
  const ip = extraParams?.invocation_params ?? {};
  const kw = serialized?.kwargs ?? {};
  return ip.model ?? ip.model_name ?? ip.modelName ?? metadata?.ls_model_name ?? kw.model ?? kw.model_name ?? kw.modelName;
}

function baseUrlOf(serialized: any): unknown {
  const kw = serialized?.kwargs ?? {};
  return kw.configuration?.baseURL ?? kw.configuration?.basePath ?? kw.base_url ?? kw.baseURL ?? kw.anthropic_api_url ?? kw.anthropicApiUrl;
}

export interface AgentCostCallbacks {
  readonly name: string;
  readonly awaitHandlers: boolean;
  readonly raiseError: boolean;
  handleChatModelStart(serialized: any, messages: any, runId: string, parentRunId?: string, extraParams?: any, tags?: string[], metadata?: any): void;
  handleLLMStart(serialized: any, prompts: string[], runId: string, parentRunId?: string, extraParams?: any, tags?: string[], metadata?: any): void;
  handleLLMEnd(output: any, runId: string): void;
  handleLLMError(err: any, runId: string): void;
}

/** A LangChain callback handler that records every model call. */
export function agentcostCallbacks(): AgentCostCallbacks {
  const runs = new Map<string, Call>();

  const start = (serialized: any, input: any, runId: string, extraParams: any, metadata: any) => {
    try {
      const ip = extraParams?.invocation_params ?? {};
      const call = new Call({
        model: modelName(serialized, extraParams, metadata),
        streaming: !!(ip.stream ?? ip.streaming),
        gatewayHost: gatewayHostOf(baseUrlOf(serialized), firstPartyHost),
        params: { ...ip, messages: Array.isArray(input) ? input.flat() : undefined },
      });
      runs.set(runId, call);
    } catch {
      /* tracking must never break the caller */
    }
  };

  return {
    name: "agentcost",
    awaitHandlers: true,
    raiseError: false,
    handleChatModelStart(serialized, messages, runId, _parent, extraParams, _tags, metadata) {
      start(serialized, messages, runId, extraParams, metadata);
    },
    handleLLMStart(serialized, _prompts, runId, _parent, extraParams, _tags, metadata) {
      start(serialized, undefined, runId, extraParams, metadata);
    },
    handleLLMEnd(output, runId) {
      const call = runs.get(runId);
      runs.delete(runId);
      if (!call) return;
      try {
        const gens: any[] = (output?.generations ?? []).flat();
        const msg = gens[0]?.message;
        const meta = msg?.response_metadata ?? {};
        call.identity(meta.model_name ?? meta.model ?? meta.modelId ?? meta.model_id, meta.id ?? msg?.id);
        const perMessage = gens.map((g) => readLangChainUsage(g?.message?.usage_metadata)).filter((u): u is Usage => !!u);
        const reported = sumUsage(perMessage) ?? readTokenUsage(output?.llmOutput?.tokenUsage ?? output?.llmOutput?.token_usage);
        if (reported) call.setUsage(reported);
        else call.setUsage(readTokenUsage(output?.llmOutput?.estimatedTokenUsage), USAGE_ESTIMATED);
      } catch {
        /* observation must never break the call */
      }
      call.finish();
    },
    handleLLMError(err, runId) {
      const call = runs.get(runId);
      runs.delete(runId);
      call?.finish(err ?? new Error("LLM error"));
    },
  };
}
