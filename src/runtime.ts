/**
 * Runtime helpers that keep the package usable outside plain Node: Bun, Deno,
 * edge runtimes with AsyncLocalStorage, and apps that load both the ESM and
 * CommonJS builds (state is shared through globalThis, so both builds see one
 * tracker and one context).
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { randomBytes } from "node:crypto";

const STATE = Symbol.for("agentcost.sdk.state.v1");

interface SharedState {
  storage: AsyncLocalStorage<any>;
  tracker?: unknown;
  outcomeSink?: (record: any) => void;
}

export function shared(): SharedState {
  const g = globalThis as any;
  if (!g[STATE]) {
    g[STATE] = { storage: new AsyncLocalStorage<any>() } satisfies SharedState;
  }
  return g[STATE] as SharedState;
}

export function env(name: string): string | undefined {
  try {
    const p = (globalThis as any).process;
    const v = p?.env?.[name];
    return typeof v === "string" && v ? v : undefined;
  } catch {
    return undefined;
  }
}

function hex(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += b.toString(16).padStart(2, "0");
  return s;
}

/** 32 hex chars from a cryptographically random source. */
export function randomHex32(): string {
  const c = (globalThis as any).crypto;
  if (c?.randomUUID) return c.randomUUID().replace(/-/g, "");
  if (c?.getRandomValues) return hex(c.getRandomValues(new Uint8Array(16)));
  // Node 18 exposes no global webcrypto by default.
  return hex(randomBytes(16));
}

export function onProcessExit(fn: () => void): () => void {
  const p = (globalThis as any).process;
  if (!p || typeof p.once !== "function") return () => undefined;
  p.once("beforeExit", fn);
  return () => p.removeListener?.("beforeExit", fn);
}
