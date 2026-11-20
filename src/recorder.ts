/**
 * One tracked model call, provider-neutral. Integrations feed it normalised
 * usage and response identity; it builds the event the backend expects.
 *
 * Usage convention (the backend's): `input` is the whole prompt EXCLUDING
 * cache writes, `cached` is the part of `input` read from cache, `cacheWrite`
 * is billed separately at the cache-write rate.
 */
import { CAPABILITY_KEY, fingerprint } from "./capabilities.js";
import { snapshot, type CallContext } from "./context.js";
import { getTracker } from "./tracker.js";

export const USAGE_FROM_RESPONSE = "response";
export const USAGE_ESTIMATED = "estimated";
export const USAGE_MISSING = "missing";

const MAX_ID_LEN = 255;

export interface Usage {
  input: number;
  output: number;
  cached?: number;
  cacheWrite?: number;
}

export function count(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.floor(v) : 0;
}

export function hasNumber(...vals: unknown[]): boolean {
  return vals.some((v) => typeof v === "number" && Number.isFinite(v));
}

function shortStr(v: unknown): string | undefined {
  return typeof v === "string" && v ? v.slice(0, MAX_ID_LEN) : undefined;
}

/** Host of a base URL, unless it is one of the provider's own hosts. Host only, never the path. */
export function gatewayHostOf(baseURL: unknown, firstParty: (host: string) => boolean): string | undefined {
  try {
    if (typeof baseURL !== "string" || !baseURL) return undefined;
    const host = new URL(baseURL).hostname.toLowerCase();
    return host && !firstParty(host) ? host : undefined;
  } catch {
    return undefined;
  }
}

/** Error class, HTTP status and error code only: never the message text, which can echo content. */
export function errorSummary(err: any): string {
  const name = (err && err.constructor && err.constructor.name) || (typeof err?.name === "string" ? err.name : "Error");
  const parts = [name];
  const status = err?.status ?? err?.statusCode ?? err?.response?.status;
  if (typeof status === "number") parts.push(String(status));
  // OpenAI: error.code / error.type. Anthropic: error.error.type (the body is
  // {"type":"error","error":{"type":"overloaded_error",...}}).
  const body = err?.error;
  const code = [err?.code, body?.code, body?.error?.code, body?.error?.type, body?.type, err?.type].find(
    (c) => typeof c === "string" && c && c !== "error",
  );
  if (typeof code === "string" && code && code !== name) parts.push(code.slice(0, 64));
  return parts.join(" ").slice(0, 255);
}

export interface CallOptions {
  model: unknown;
  streaming?: boolean;
  gatewayHost?: string;
  params?: unknown;
  /** Context to attribute to; default: the context active now. */
  ctx?: CallContext;
}

export class Call {
  private done = false;
  private usage?: Usage;
  private usageSource: string = USAGE_FROM_RESPONSE;
  private responseModel?: string;
  private responseId?: string;
  private extra: Record<string, unknown> = {};
  private pendingError?: unknown;
  private readonly started = Date.now();
  readonly model: string;
  readonly streaming: boolean;
  readonly gateway?: string;
  readonly ctx: CallContext;
  readonly caps?: Record<string, unknown>;

  constructor(o: CallOptions) {
    this.model = typeof o.model === "string" && o.model ? o.model : "unknown";
    this.streaming = !!o.streaming;
    this.gateway = o.gatewayHost;
    this.ctx = o.ctx ?? snapshot();
    this.caps = fingerprint(o.params);
  }

  get finished(): boolean {
    return this.done;
  }

  setStreaming(): void {
    (this as { streaming: boolean }).streaming = true;
  }

  identity(model: unknown, id: unknown): void {
    this.responseModel ??= shortStr(model);
    this.responseId ??= shortStr(id);
  }

  /**
   * Replace usage (providers that report cumulative totals). `source` is
   * "estimated" only when the counts came from a client-side estimate the
   * framework made, never from the endpoint.
   */
  setUsage(u: Usage | undefined, source: string = USAGE_FROM_RESPONSE): void {
    if (u) {
      this.usage = u;
      this.usageSource = source;
    }
  }

  /** Merge usage (providers that split usage across stream events). */
  mergeUsage(u: Partial<Usage>): void {
    const cur = this.usage ?? { input: 0, output: 0 };
    this.usage = {
      input: u.input ?? cur.input,
      output: u.output ?? cur.output,
      cached: u.cached ?? cur.cached,
      cacheWrite: u.cacheWrite ?? cur.cacheWrite,
    };
  }

  meta(key: string, value: unknown): void {
    this.extra[key] = value;
  }

  /** The call failed even though its stream ends normally (error parts). */
  markFailed(err: unknown): void {
    this.pendingError ??= err ?? new Error("stream error");
  }

  finish(err?: unknown): void {
    if (this.done) return;
    if (err === undefined) err = this.pendingError;
    this.done = true;
    try {
      const t = getTracker();
      if (!t) return;
      const u = this.usage;
      const input = u ? count(u.input) : 0;
      const output = u ? count(u.output) : 0;
      const observed: Record<string, unknown> = {
        ...this.extra,
        usage_source: u ? this.usageSource : USAGE_MISSING,
      };
      if (this.responseModel) observed.response_model = this.responseModel;
      if (this.responseId) observed.response_id = this.responseId;
      if (this.gateway) observed.gateway_host = this.gateway;
      const metadata: Record<string, unknown> = { ...t.opts.globalMetadata, ...(this.ctx.metadata ?? {}), ...observed };
      // Reserved namespace, written last so caller keys never collide with it.
      if (this.caps) metadata[CAPABILITY_KEY] = this.caps;
      const event: Record<string, unknown> = {
        agent_name: (this.ctx.agent ?? t.opts.defaultAgentName).slice(0, 255),
        model: this.model.slice(0, 255),
        input_tokens: input,
        output_tokens: output,
        total_tokens: input + output,
        // Priced by the server from the model and token counts.
        cost: 0,
        latency_ms: Math.max(0, Date.now() - this.started),
        timestamp: new Date().toISOString(),
        success: err === undefined,
        error: err === undefined ? null : errorSummary(err),
        metadata,
        ...this.ctx.traceFields,
      };
      if (this.streaming) event.streaming = true;
      const cached = Math.min(count(u?.cached), input);
      if (cached) event.cached_tokens = cached;
      const written = count(u?.cacheWrite);
      if (written) event.cache_write_tokens = written;
      t.record(event);
    } catch {
      /* tracking must never break the caller */
    }
  }
}

/**
 * Wrap an async iterator so every chunk is observed and the call is finished
 * exactly once: at the end, on error, or when the consumer stops early.
 */
export function observeIterator<T>(inner: AsyncIterator<T>, call: Call, observe: (chunk: T) => void): AsyncGenerator<T> {
  return (async function* () {
    let failed = false;
    let error: unknown;
    try {
      while (true) {
        const r = await inner.next();
        if (r.done) break;
        try {
          observe(r.value);
        } catch {
          /* observation must never break the stream */
        }
        yield r.value;
      }
    } catch (e) {
      failed = true;
      error = e;
      throw e;
    } finally {
      // Abandoned streams are recorded with whatever usage was seen.
      try {
        await inner.return?.();
      } catch {
        /* closing an aborted stream may throw */
      }
      call.finish(failed ? error : undefined);
    }
  })();
}
