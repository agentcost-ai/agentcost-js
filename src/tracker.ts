/**
 * Event queue and delivery to POST /v1/events/batch.
 *
 * An event gets its `event_id` once, when it is recorded. A batch that fails
 * with a retryable error (network, timeout, 408, 429, 5xx) is kept and resent
 * as the same objects, so the server can recognise a batch it already stored
 * and report it as a duplicate instead of billing it twice.
 */
import { setOutcomeSink, type OutcomeRecord } from "./context.js";
import { env, onProcessExit, randomHex32, shared } from "./runtime.js";
import { SDK_VERSION } from "./version.js";

export interface InitOptions {
  /** AgentCost project API key. Default: AGENTCOST_API_KEY. */
  apiKey?: string;
  /** AgentCost project id (UUID). Default: AGENTCOST_PROJECT_ID. */
  projectId?: string;
  /** Default: AGENTCOST_API_URL, else https://api.agentcost.tech */
  baseUrl?: string;
  /** Turn tracking off without removing instrumentation. Default true. */
  enabled?: boolean;
  /** Events per request (max 100, the backend limit). Default 10. */
  batchSize?: number;
  /** Time-based flush interval. Default 5000 ms. */
  flushIntervalMs?: number;
  /** Keep events in memory instead of sending them (tests, dry runs). */
  localMode?: boolean;
  /** Agent name for calls made outside agent(). Default "default". */
  defaultAgentName?: string;
  /** Metadata added to every event (caller metadata wins on collision). */
  globalMetadata?: Record<string, unknown>;
  /** Failed batches kept for retry before the oldest is dropped. Default 100. */
  maxRetainedBatches?: number;
  /** Per-request timeout. Default 10000 ms. */
  timeoutMs?: number;
  /** Injected fetch (proxies, tests). Default: global fetch. */
  fetch?: typeof fetch;
  /** Called with a short, content-free description when delivery fails. */
  onError?: (message: string) => void;
  debug?: boolean;
}

export type AgentCostEvent = Record<string, unknown> & { event_id: string };

const MAX_BATCH = 100;
const RETRYABLE = (status: number) => status === 408 || status === 429 || status >= 500;

interface ResolvedOptions {
  apiKey: string;
  projectId: string;
  baseUrl: string;
  enabled: boolean;
  batchSize: number;
  flushIntervalMs: number;
  localMode: boolean;
  defaultAgentName: string;
  globalMetadata: Record<string, unknown>;
  maxRetainedBatches: number;
  timeoutMs: number;
  debug: boolean;
}

interface Batch {
  events: AgentCostEvent[];
  outcomes: OutcomeRecord[];
}

export class Tracker {
  readonly opts: ResolvedOptions;
  private readonly fetchImpl: typeof fetch;
  private readonly onError?: (message: string) => void;
  private pending: AgentCostEvent[] = [];
  private pendingOutcomes: OutcomeRecord[] = [];
  private failed: Batch[] = [];
  private local: AgentCostEvent[] = [];
  private timer?: ReturnType<typeof setInterval>;
  private chain: Promise<void> = Promise.resolve();
  private warned = new Set<string>();
  private readonly detachExit: () => void;

  constructor(options: InitOptions) {
    this.opts = {
      apiKey: options.apiKey ?? env("AGENTCOST_API_KEY") ?? "",
      projectId: options.projectId ?? env("AGENTCOST_PROJECT_ID") ?? "",
      baseUrl: (options.baseUrl ?? env("AGENTCOST_API_URL") ?? "https://api.agentcost.tech").replace(/\/+$/, ""),
      enabled: options.enabled ?? true,
      batchSize: Math.max(1, Math.min(Math.floor(options.batchSize ?? 10), MAX_BATCH)),
      flushIntervalMs: Math.max(100, options.flushIntervalMs ?? 5000),
      localMode: options.localMode ?? false,
      defaultAgentName: options.defaultAgentName ?? "default",
      globalMetadata: options.globalMetadata ?? {},
      maxRetainedBatches: Math.max(1, options.maxRetainedBatches ?? 100),
      timeoutMs: Math.max(1, options.timeoutMs ?? 10000),
      debug: options.debug ?? false,
    };
    this.onError = options.onError;
    const f = options.fetch ?? (globalThis as any).fetch;
    this.fetchImpl = typeof f === "function" ? f : (() => Promise.reject(new Error("no fetch available"))) as any;
    if (this.opts.enabled && !this.opts.localMode && (!this.opts.apiKey || !this.opts.projectId)) {
      this.warnOnce("config", "AgentCost: apiKey and projectId are required unless localMode is set; events will not be sent.");
    }
    this.timer = setInterval(() => void this.flush(), this.opts.flushIntervalMs);
    (this.timer as any)?.unref?.();
    this.detachExit = onProcessExit(() => void this.flush());
    setOutcomeSink((r) => this.recordOutcome(r));
  }

  /** Stamp the idempotency key and queue. Never throws into the caller. */
  record(event: Record<string, unknown>): void {
    try {
      if (!this.opts.enabled) return;
      const e = event as AgentCostEvent;
      if (typeof e.event_id !== "string" || !e.event_id) e.event_id = randomHex32();
      if (this.opts.localMode) {
        this.local.push(e);
        return;
      }
      this.pending.push(e);
      if (this.pending.length >= this.opts.batchSize) void this.flush();
    } catch {
      /* tracking must never break the caller */
    }
  }

  recordOutcome(record: OutcomeRecord): void {
    if (!this.opts.enabled) return;
    if (this.opts.localMode) {
      this.local.push({ record_type: "outcome", ...record } as unknown as AgentCostEvent);
      return;
    }
    this.pendingOutcomes.push(record);
  }

  getLocalEvents(): AgentCostEvent[] {
    return this.local.slice();
  }

  /** Send everything queued. Resolves when this flush (and any before it) has finished. Never rejects. */
  flush(): Promise<void> {
    this.chain = this.chain.then(() => this.drain()).catch(() => undefined);
    return this.chain;
  }

  async shutdown(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.detachExit();
    if (shared().outcomeSink) setOutcomeSink(undefined);
    await this.flush();
  }

  private async drain(): Promise<void> {
    if (this.opts.localMode || !this.opts.apiKey || !this.opts.projectId) return;
    while (this.pending.length || this.pendingOutcomes.length) {
      this.failed.push({
        events: this.pending.splice(0, this.opts.batchSize),
        outcomes: this.pendingOutcomes.splice(0, MAX_BATCH),
      });
    }
    if (this.failed.length > this.opts.maxRetainedBatches) {
      const dropped = this.failed.splice(0, this.failed.length - this.opts.maxRetainedBatches);
      this.report("overflow", `AgentCost: dropped ${dropped.length} undelivered batch(es) after repeated delivery failures.`);
    }
    const queue = this.failed;
    this.failed = [];
    for (let i = 0; i < queue.length; i++) {
      const verdict = await this.send(queue[i]);
      if (verdict === "retry") {
        // Keep this batch and everything after it, in order, for the next flush.
        this.failed = queue.slice(i).concat(this.failed);
        return;
      }
    }
  }

  private async send(batch: Batch): Promise<"ok" | "drop" | "retry"> {
    const body: Record<string, unknown> = { project_id: this.opts.projectId, events: batch.events };
    if (batch.outcomes.length) body.outcomes = batch.outcomes;
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), this.opts.timeoutMs);
    try {
      const res = await this.fetchImpl(`${this.opts.baseUrl}/v1/events/batch`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.opts.apiKey}`,
          "content-type": "application/json",
          "x-agentcost-sdk-version": `js-${SDK_VERSION}`,
        },
        body: JSON.stringify(body),
        signal: ctrl.signal,
      });
      if (RETRYABLE(res.status)) {
        this.report(`retry${res.status}`, `AgentCost: backend returned HTTP ${res.status}; the batch will be retried.`);
        return "retry";
      }
      if (!res.ok) {
        // 400/401/403/413/422: resending the same batch cannot succeed.
        this.report(`http${res.status}`, `AgentCost: backend refused a batch with HTTP ${res.status}; it was dropped. Check the API key and project id.`);
        return "drop";
      }
      const data = (await res.json().catch(() => ({}))) as { events_rejected?: number; rejected?: { reason?: string }[] };
      if (data.events_rejected) {
        this.report("rejected", `AgentCost: backend rejected ${data.events_rejected} of ${batch.events.length} events (first reason: ${data.rejected?.[0]?.reason ?? "unknown"}).`);
      }
      if (this.opts.debug) console.debug(`[AgentCost] sent ${batch.events.length} events`);
      return "ok";
    } catch {
      this.report("network", "AgentCost: could not reach the backend; the batch will be retried.");
      return "retry";
    } finally {
      clearTimeout(t);
    }
  }

  private report(key: string, msg: string): void {
    try {
      this.onError?.(msg);
    } catch {
      /* a failing hook must not stop delivery */
    }
    this.warnOnce(key, msg);
  }

  private warnOnce(key: string, msg: string): void {
    if (this.warned.has(key)) return;
    this.warned.add(key);
    console.warn(msg);
  }
}

export function getTracker(): Tracker | undefined {
  return shared().tracker as Tracker | undefined;
}

/** Start tracking. Calling it again replaces the previous configuration (after flushing it). */
export function init(options: InitOptions = {}): void {
  const prev = getTracker();
  if (prev) void prev.shutdown();
  shared().tracker = new Tracker(options);
}

/** Send queued events now. In serverless handlers, await this (or pass it to waitUntil) before returning. */
export function flush(): Promise<void> {
  return getTracker()?.flush() ?? Promise.resolve();
}

/** Flush and stop. */
export async function shutdown(): Promise<void> {
  const t = getTracker();
  shared().tracker = undefined;
  if (t) await t.shutdown();
}

/** Events kept in memory by `localMode`. */
export function getLocalEvents(): AgentCostEvent[] {
  return getTracker()?.getLocalEvents() ?? [];
}
