/**
 * Attribution context: agent, metadata and workflow (trace) structure.
 *
 * AsyncLocalStorage-based, so concurrent requests keep their own context with
 * nothing threaded through call signatures. Semantics match the Python SDK:
 * a workflow is one run (one trace_id), nested workflows join the outer run,
 * step() outside a workflow is inert, tool() outside a workflow still names
 * the tool.
 */
import { env, randomHex32, shared } from "./runtime.js";

export const MAX_TRACE_ID = 64;
const TRACE_ID_ENV = "AGENTCOST_TRACE_ID";
const WORKFLOW_ENV = "AGENTCOST_WORKFLOW";

interface Trace {
  traceId: string;
  workflow: string;
  nextIndex: number;
  outcome?: { success: boolean; label?: string };
}

interface Span {
  spanId: string;
  name: string;
  stepIndex: number;
  depth: number;
  toolName?: string;
}

interface Ctx {
  agent?: string;
  metadata?: Record<string, unknown>;
  trace?: Trace;
  span?: Span;
}

export function newId(): string {
  return randomHex32().slice(0, 16);
}

function current(): Ctx {
  return (shared().storage.getStore() as Ctx | undefined) ?? {};
}

function runWith<T>(next: Ctx, fn: () => T): T {
  return shared().storage.run(next, fn);
}

/** Attribute every call made inside `fn` to the named agent. */
export function agent<T>(name: string, fn: () => T): T {
  return runWith({ ...current(), agent: name }, fn);
}

/** Attach metadata to every call made inside `fn`. Nested calls merge. */
export function metadata<T>(meta: Record<string, unknown>, fn: () => T): T {
  const ctx = current();
  return runWith({ ...ctx, metadata: { ...(ctx.metadata ?? {}), ...meta } }, fn);
}

type OutcomeSink = (record: OutcomeRecord) => void;
export function setOutcomeSink(sink: OutcomeSink | undefined): void {
  shared().outcomeSink = sink;
}

export interface OutcomeRecord {
  trace_id: string;
  workflow: string;
  success: boolean;
  label?: string;
}

/**
 * One run of a job. Every call inside shares one trace_id. A nested
 * workflow joins the enclosing run. Pass `traceId` to join a run minted
 * elsewhere; otherwise AGENTCOST_TRACE_ID from the environment, else a new id.
 */
export function workflow<T>(
  name: string,
  fn: (traceId: string) => T,
  options: { traceId?: string } = {},
): T {
  const ctx = current();
  if (ctx.trace) return fn(ctx.trace.traceId);
  const inherited = (env(TRACE_ID_ENV) ?? "").trim();
  const traceId = (options.traceId || inherited || newId()).slice(0, MAX_TRACE_ID);
  const trace: Trace = { traceId, workflow: name.slice(0, 255), nextIndex: 0 };
  const close = () => {
    const sink = shared().outcomeSink;
    if (trace.outcome && sink) {
      sink({
        trace_id: trace.traceId,
        workflow: trace.workflow,
        success: trace.outcome.success,
        ...(trace.outcome.label ? { label: trace.outcome.label } : {}),
      });
    }
  };
  let result: T;
  try {
    result = runWith({ ...ctx, trace, span: undefined }, () => fn(traceId));
  } catch (e) {
    close();
    throw e;
  }
  if (isThenable(result)) {
    return (result as unknown as Promise<unknown>).finally(close) as unknown as T;
  }
  close();
  return result;
}

/** One step of the enclosing workflow. Outside a workflow it records nothing. */
export function step<T>(name: string, fn: () => T): T {
  const ctx = current();
  if (!ctx.trace) return fn();
  const parent = ctx.span;
  const span: Span = {
    spanId: newId(),
    name: name.slice(0, 255),
    stepIndex: ctx.trace.nextIndex++,
    depth: parent ? parent.depth + 1 : 0,
  };
  return runWith({ ...ctx, span }, fn);
}

/** A tool call. Inside a workflow it is a step; outside, calls carry tool_name only. */
export function tool<T>(name: string, fn: () => T): T {
  const ctx = current();
  const parent = ctx.span;
  const span: Span = {
    spanId: newId(),
    name: name.slice(0, 255),
    stepIndex: ctx.trace ? ctx.trace.nextIndex++ : 0,
    depth: parent ? parent.depth + 1 : 0,
    toolName: name.slice(0, 255),
  };
  return runWith({ ...ctx, span }, fn);
}

/** Declare how the enclosing run ended. Returns false outside a workflow. */
export function outcome(success: boolean, label?: string): boolean {
  const trace = current().trace;
  if (!trace) return false;
  trace.outcome = { success, label: label?.slice(0, 255) };
  return true;
}

export function currentTraceId(): string | undefined {
  return current().trace?.traceId;
}

export interface CallContext {
  agent?: string;
  metadata?: Record<string, unknown>;
  traceFields: Record<string, unknown>;
}

/**
 * Snapshot of attribution for a call starting now. Taken when the call is
 * made, so a stream consumed later is still attributed to where it started.
 */
export function snapshot(): CallContext {
  const ctx = current();
  const fields: Record<string, unknown> = {};
  if (ctx.trace) {
    fields.trace_id = ctx.trace.traceId;
    fields.workflow = ctx.trace.workflow;
    fields.span_id = newId();
    if (ctx.span) {
      fields.parent_span_id = ctx.span.spanId;
      fields.step_name = ctx.span.name;
      fields.step_index = ctx.span.stepIndex;
      fields.depth = ctx.span.depth + 1;
      if (ctx.span.toolName) fields.tool_name = ctx.span.toolName;
    } else {
      fields.depth = 0;
      fields.step_index = ctx.trace.nextIndex++;
    }
  } else {
    const inherited = (env(TRACE_ID_ENV) ?? "").trim();
    if (inherited) fields.trace_id = inherited.slice(0, MAX_TRACE_ID);
    const wf = (env(WORKFLOW_ENV) ?? "").trim();
    if (wf) fields.workflow = wf.slice(0, 255);
    if (ctx.span?.toolName) fields.tool_name = ctx.span.toolName;
  }
  return { agent: ctx.agent, metadata: ctx.metadata, traceFields: fields };
}

function isThenable(v: unknown): boolean {
  return !!v && typeof (v as { then?: unknown }).then === "function";
}
