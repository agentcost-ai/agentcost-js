import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as ac from "../src/index.js";
import {
  Endpoint, Backend, GATEWAY, MODEL, SERVED, SECRET_PROMPT, SECRET_REPLY, GATEWAY_KEY,
  apiError, chatCompletion, chatChunks, json, responseEvents, responseObject, sse,
} from "./helpers.js";

const MSG = [{ role: "user" as const, content: SECRET_PROMPT }];
const PROJECT = "11111111-2222-3333-4444-555555555555";

// Backend EventCreate fields; anything else at top level is silently dropped server-side.
const EVENT_FIELDS = new Set([
  "agent_name", "model", "input_tokens", "output_tokens", "total_tokens", "cached_tokens",
  "cache_write_tokens", "streaming", "cost", "latency_ms", "timestamp", "success", "error",
  "metadata", "input_hash", "event_id", "trace_id", "span_id", "parent_span_id", "workflow",
  "step_name", "step_index", "depth", "tool_name",
]);

function events() {
  return ac.getLocalEvents().filter((e) => (e as any).record_type !== "outcome") as any[];
}
function only() {
  const ev = events();
  assert.equal(ev.length, 1, `expected one event, got ${ev.length}`);
  return ev[0];
}
async function drain(iter: AsyncIterable<unknown>) {
  for await (const _ of iter) void _;
}

describe("local mode", () => {
  beforeEach(() => ac.init({ localMode: true }));
  afterEach(() => ac.shutdown());

  describe("event id", () => {
    test("every call gets a unique 32-char id", async () => {
      const ep = new Endpoint().push(() => json(200, chatCompletion()), () => json(200, chatCompletion()), () => apiError(500, "boom"));
      const c = ac.instrumentOpenAI(ep.client());
      await c.chat.completions.create({ model: MODEL, messages: MSG });
      await c.chat.completions.create({ model: MODEL, messages: MSG });
      await assert.rejects(c.chat.completions.create({ model: MODEL, messages: MSG }));
      const ids = events().map((e) => e.event_id);
      assert.equal(ids.length, 3);
      assert.equal(new Set(ids).size, 3);
      for (const id of ids) assert.match(id, /^[0-9a-f]{32}$/);
    });
  });

  describe("response identity and gateway", () => {
    test("chat: requested model stays primary; served model and id in metadata", async () => {
      const ep = new Endpoint().push(() => json(200, chatCompletion()));
      const c = ac.instrumentOpenAI(ep.client());
      await c.chat.completions.create({ model: MODEL, messages: MSG });
      const e = only();
      assert.equal(e.model, MODEL);
      assert.equal(e.metadata.response_model, SERVED);
      assert.equal(e.metadata.response_id, "chatcmpl-123");
      assert.equal(e.metadata.gateway_host, "gateway.example");
      assert.equal(e.input_tokens, 12);
      assert.equal(e.output_tokens, 3);
      assert.equal(e.total_tokens, 15);
      assert.equal(e.success, true);
    });

    test("gateway host is the host only, never the path", async () => {
      const ep = new Endpoint().push(() => json(200, chatCompletion()));
      const c = ac.instrumentOpenAI(ep.client("https://eu.gateway.example/v1/secret-path"));
      await c.chat.completions.create({ model: MODEL, messages: MSG });
      assert.equal(only().metadata.gateway_host, "eu.gateway.example");
    });

    test("api.openai.com is not recorded as a gateway", async () => {
      const ep = new Endpoint().push(() => json(200, chatCompletion()));
      const c = ac.instrumentOpenAI(ep.client("https://api.openai.com/v1"));
      await c.chat.completions.create({ model: MODEL, messages: MSG });
      assert.equal("gateway_host" in only().metadata, false);
    });

    test("responses API non-stream", async () => {
      const ep = new Endpoint().push(() => json(200, responseObject()));
      const c = ac.instrumentOpenAI(ep.client());
      await c.responses.create({ model: MODEL, input: SECRET_PROMPT });
      const e = only();
      assert.equal(e.metadata.response_id, "resp_789");
      assert.equal(e.metadata.response_model, SERVED);
      assert.deepEqual([e.input_tokens, e.output_tokens, e.cached_tokens], [30, 5, 10]);
      assert.equal(e.metadata.usage_source, "response");
    });

    test("responses API stream", async () => {
      const ep = new Endpoint().push(() => sse(responseEvents(), false));
      const c = ac.instrumentOpenAI(ep.client());
      await drain(await c.responses.create({ model: MODEL, input: SECRET_PROMPT, stream: true }));
      const e = only();
      assert.equal(e.streaming, true);
      assert.equal(e.metadata.response_id, "resp_789");
      assert.deepEqual([e.input_tokens, e.output_tokens, e.cached_tokens], [30, 5, 10]);
      assert.equal(e.metadata.usage_source, "response");
      assert.equal(ep.requests[0].body.stream_options, undefined, "stream_options is chat-only");
    });
  });

  describe("usage_source", () => {
    test("missing usage is labelled missing, not presented as real zero usage", async () => {
      const ep = new Endpoint().push(() => json(200, chatCompletion(null)));
      const c = ac.instrumentOpenAI(ep.client());
      await c.chat.completions.create({ model: MODEL, messages: MSG });
      const e = only();
      assert.equal(e.metadata.usage_source, "missing");
      assert.equal(e.input_tokens, 0);
      assert.equal(e.success, true, "the event is still recorded");
    });

    test("failed call: recorded, missing usage, no message text", async () => {
      const ep = new Endpoint().push(() => apiError(503, `The selected group cannot currently process model ${SECRET_PROMPT}`, { code: "model_unavailable" }));
      const c = ac.instrumentOpenAI(ep.client());
      await assert.rejects(c.chat.completions.create({ model: "no-such-model", messages: MSG }), (e: any) => e.status === 503);
      const e = only();
      assert.equal(e.success, false);
      assert.equal(e.model, "no-such-model");
      assert.equal(e.metadata.usage_source, "missing");
      assert.equal(e.metadata.gateway_host, "gateway.example");
      assert.match(e.error, /503/);
      assert.match(e.error, /model_unavailable/);
      assert.ok(!e.error.includes(SECRET_PROMPT), "error message text is not recorded");
    });

    test("streamed chat with usage: injected include_usage, cached tokens read", async () => {
      const ep = new Endpoint().push(() => sse(chatChunks(true)));
      const c = ac.instrumentOpenAI(ep.client());
      await drain(await c.chat.completions.create({ model: MODEL, messages: MSG, stream: true }));
      assert.deepEqual(ep.requests[0].body.stream_options, { include_usage: true });
      const e = only();
      assert.deepEqual([e.input_tokens, e.output_tokens, e.cached_tokens], [20, 4, 16]);
      assert.equal(e.metadata.usage_source, "response");
      assert.equal(e.metadata.response_model, SERVED);
      assert.equal(e.metadata.response_id, "chatcmpl-456");
    });

    test("streamed chat without usage chunk is missing", async () => {
      const ep = new Endpoint().push(() => sse(chatChunks(false)));
      const c = ac.instrumentOpenAI(ep.client());
      await drain(await c.chat.completions.create({ model: MODEL, messages: MSG, stream: true }));
      assert.equal(only().metadata.usage_source, "missing");
    });

    test("abandoned stream is recorded once", async () => {
      const ep = new Endpoint().push(() => sse(chatChunks(true)));
      const c = ac.instrumentOpenAI(ep.client());
      const s = await c.chat.completions.create({ model: MODEL, messages: MSG, stream: true });
      for await (const _ of s) break;
      const e = only();
      assert.equal(e.success, true);
      assert.equal(e.metadata.usage_source, "missing");
    });

    test("stream error mid-way is recorded as a failure", async () => {
      const ep = new Endpoint().push(() => sse([chatChunks(false)[0], { error: { message: "upstream died", type: "server_error" } }]));
      const c = ac.instrumentOpenAI(ep.client());
      const s = await c.chat.completions.create({ model: MODEL, messages: MSG, stream: true });
      await assert.rejects(drain(s));
      assert.equal(only().success, false);
    });
  });

  describe("other ways of consuming a call", () => {
    test("withResponse() is tracked once", async () => {
      const ep = new Endpoint().push(() => json(200, chatCompletion()));
      const c = ac.instrumentOpenAI(ep.client());
      const { data } = await c.chat.completions.create({ model: MODEL, messages: MSG }).withResponse();
      assert.equal(data.id, "chatcmpl-123");
      assert.equal(only().metadata.usage_source, "response");
    });

    test("chat.completions.parse() is tracked", async () => {
      const ep = new Endpoint().push(() => json(200, chatCompletion()));
      const c = ac.instrumentOpenAI(ep.client());
      // v5+: chat.completions.parse; v4: beta.chat.completions.parse
      const res: any = (c.chat.completions as any).parse ? c.chat.completions : (c as any).beta.chat.completions;
      await res.parse({ model: MODEL, messages: MSG });
      assert.equal(only().input_tokens, 12);
    });

    test("chat.completions.stream() helper is tracked", async () => {
      const ep = new Endpoint().push(() => sse(chatChunks(true)));
      const c = ac.instrumentOpenAI(ep.client());
      const res: any = (c.chat.completions as any).stream ? c.chat.completions : (c as any).beta.chat.completions;
      const s = res.stream({ model: MODEL, messages: MSG });
      await s.finalChatCompletion();
      assert.equal(only().input_tokens, 20);
    });

    test("responses.stream() helper is tracked", async () => {
      const ep = new Endpoint().push(() => sse(responseEvents(), false));
      const c = ac.instrumentOpenAI(ep.client());
      const s = c.responses.stream({ model: MODEL, input: SECRET_PROMPT });
      await s.finalResponse();
      assert.equal(only().metadata.response_id, "resp_789");
    });

    test("toReadableStream() and tee() still work and are tracked", async () => {
      const ep = new Endpoint().push(() => sse(chatChunks(true)), () => sse(chatChunks(true)));
      const c = ac.instrumentOpenAI(ep.client());
      const s1 = await c.chat.completions.create({ model: MODEL, messages: MSG, stream: true });
      const reader = s1.toReadableStream().getReader();
      while (!(await reader.read()).done);
      const s2 = await c.chat.completions.create({ model: MODEL, messages: MSG, stream: true });
      const [a, b] = s2.tee();
      await drain(a);
      await drain(b);
      const ev = events();
      assert.equal(ev.length, 2);
      assert.ok(ev.every((e) => e.metadata.usage_source === "response"));
    });

    test("instrumenting twice does not double-count", async () => {
      const ep = new Endpoint().push(() => json(200, chatCompletion()));
      const c = ac.instrumentOpenAI(ac.instrumentOpenAI(ep.client()));
      await c.chat.completions.create({ model: MODEL, messages: MSG });
      assert.equal(events().length, 1);
    });

    test("uninstrumented clients are untouched", async () => {
      const ep = new Endpoint().push(() => json(200, chatCompletion()));
      await ep.client().chat.completions.create({ model: MODEL, messages: MSG });
      assert.equal(events().length, 0);
    });
  });

  describe("stream_options fallback", () => {
    const rejections: [string, () => Response][] = [
      ["names stream_options", () => apiError(400, "Unrecognized request argument supplied: stream_options")],
      ["param field", () => apiError(400, "bad request", { param: "stream_options" })],
      ["include_usage", () => apiError(400, "include_usage is not supported")],
      ["unsupported parameter 422", () => apiError(422, "Unsupported parameter in request body")],
      ["extra fields", () => apiError(400, "Extra fields not permitted")],
    ];
    for (const [name, reject] of rejections) {
      test(`resent once without it: ${name}`, async () => {
        const ep = new Endpoint().push(reject, () => sse(chatChunks(false)));
        const c = ac.instrumentOpenAI(ep.client());
        await drain(await c.chat.completions.create({ model: MODEL, messages: MSG, stream: true }));
        assert.equal(ep.requests.length, 2);
        assert.ok(ep.requests[0].body.stream_options);
        assert.equal(ep.requests[1].body.stream_options, undefined);
        const e = only();
        assert.equal(e.success, true);
        assert.equal(e.metadata.stream_options_rejected, true);
        assert.equal(e.metadata.usage_source, "missing");
      });
    }

    const unrelated: [string, () => Response][] = [
      ["429", () => apiError(429, "Rate limit reached")],
      ["401", () => apiError(401, "Invalid API key")],
      ["403 quota", () => apiError(403, "insufficient_user_quota")],
      ["500", () => apiError(500, "Internal error")],
      ["context length", () => apiError(400, "This model's maximum context length is 8192 tokens")],
      ["invalid value", () => apiError(400, "Invalid value for parameter 'temperature'")],
    ];
    for (const [name, reject] of unrelated) {
      test(`not resent: ${name}`, async () => {
        const ep = new Endpoint().push(reject);
        const c = ac.instrumentOpenAI(ep.client());
        await assert.rejects(c.chat.completions.create({ model: MODEL, messages: MSG, stream: true }));
        assert.equal(ep.requests.length, 1);
        const e = only();
        assert.equal(e.success, false);
        assert.equal("stream_options_rejected" in e.metadata, false);
      });
    }

    test("caller-set stream_options are never modified or stripped", async () => {
      const ep = new Endpoint().push(() => apiError(400, "stream_options not supported"));
      const c = ac.instrumentOpenAI(ep.client());
      await assert.rejects(c.chat.completions.create({ model: MODEL, messages: MSG, stream: true, stream_options: { include_usage: false } }));
      assert.equal(ep.requests.length, 1);
      assert.deepEqual(ep.requests[0].body.stream_options, { include_usage: false });
    });

    test("the fallback works through withResponse() too", async () => {
      const ep = new Endpoint().push(() => apiError(400, "stream_options not supported"), () => sse(chatChunks(false)));
      const c = ac.instrumentOpenAI(ep.client());
      const { data } = await c.chat.completions.create({ model: MODEL, messages: MSG, stream: true }).withResponse();
      await drain(data);
      assert.equal(only().metadata.stream_options_rejected, true);
    });
  });

  describe("attribution", () => {
    test("agent -> job (workflow = trace) -> step, with no cross-talk", async () => {
      const ep = new Endpoint();
      for (let i = 0; i < 6; i++) ep.push(() => json(200, chatCompletion()));
      const c = ac.instrumentOpenAI(ep.client());
      const call = () => c.chat.completions.create({ model: MODEL, messages: MSG });
      const traces: Record<string, string> = {};
      await ac.agent("researcher", () =>
        Promise.all(["job-1", "job-2"].map((job) =>
          ac.workflow(job, async (tid) => {
            traces[job] = tid;
            await ac.step("plan", call);
            await ac.tool("search", call);
          }),
        )),
      );
      await ac.agent("writer", () => ac.workflow("job-3", async (tid) => {
        traces["job-3"] = tid;
        await call();
        await call();
      }));
      const ev = events();
      assert.equal(ev.length, 6);
      for (const job of ["job-1", "job-2"]) {
        const mine = ev.filter((e) => e.workflow === job);
        assert.equal(mine.length, 2);
        assert.ok(mine.every((e) => e.trace_id === traces[job] && e.agent_name === "researcher"));
        assert.deepEqual(mine.map((e) => e.step_name ?? e.tool_name).sort(), ["plan", "search"]);
        assert.equal(mine.find((e) => e.tool_name)?.tool_name, "search");
      }
      const w = ev.filter((e) => e.workflow === "job-3");
      assert.equal(w.length, 2);
      assert.ok(w.every((e) => e.agent_name === "writer" && e.trace_id === traces["job-3"]));
      assert.equal(new Set(Object.values(traces)).size, 3);
      assert.equal(new Set(ev.map((e) => e.span_id)).size, 6);
    });

    test("a stream consumed later is attributed to where it was created", async () => {
      const ep = new Endpoint().push(() => sse(chatChunks(true)));
      const c = ac.instrumentOpenAI(ep.client());
      const s = await ac.agent("a1", () => ac.workflow("job", () => c.chat.completions.create({ model: MODEL, messages: MSG, stream: true })));
      await drain(s);
      const e = only();
      assert.equal(e.agent_name, "a1");
      assert.equal(e.workflow, "job");
    });

    test("outside any context: default agent, no trace fields", async () => {
      const ep = new Endpoint().push(() => json(200, chatCompletion()));
      const c = ac.instrumentOpenAI(ep.client());
      await c.chat.completions.create({ model: MODEL, messages: MSG });
      const e = only();
      assert.equal(e.agent_name, "default");
      assert.equal("trace_id" in e, false);
    });

    test("outcome is emitted once when the job closes", async () => {
      await ac.workflow("job", async (tid) => {
        ac.outcome(false, "timeout");
        return tid;
      });
      const o = ac.getLocalEvents().filter((r: any) => r.record_type === "outcome") as any[];
      assert.equal(o.length, 1);
      assert.equal(o[0].success, false);
      assert.equal(o[0].label, "timeout");
    });
  });

  describe("compatibility and privacy", () => {
    test("caller metadata kept; observed keys win on collision", async () => {
      const ep = new Endpoint().push(() => json(200, chatCompletion()));
      const c = ac.instrumentOpenAI(ep.client());
      await ac.metadata({ customer: "acme", usage_source: "forged" }, () => c.chat.completions.create({ model: MODEL, messages: MSG }));
      const e = only();
      assert.equal(e.metadata.customer, "acme");
      assert.equal(e.metadata.usage_source, "response");
    });

    test("top-level fields are a subset of the backend schema", async () => {
      const ep = new Endpoint().push(() => json(200, chatCompletion()), () => sse(chatChunks(true)));
      const c = ac.instrumentOpenAI(ep.client());
      await ac.workflow("w", () => ac.tool("t", () => c.chat.completions.create({ model: MODEL, messages: MSG })));
      await drain(await c.chat.completions.create({ model: MODEL, messages: MSG, stream: true }));
      for (const e of events()) {
        for (const k of Object.keys(e)) assert.ok(EVENT_FIELDS.has(k), `unexpected field ${k}`);
        assert.ok(e.event_id.length <= 64);
        assert.ok(!Number.isNaN(Date.parse(e.timestamp)));
      }
    });

    test("no prompt, completion or key in any event", async () => {
      const ep = new Endpoint().push(() => json(200, chatCompletion()), () => sse(chatChunks(true)), () => json(200, responseObject()), () => apiError(500, SECRET_PROMPT));
      const c = ac.instrumentOpenAI(ep.client());
      await c.chat.completions.create({ model: MODEL, messages: MSG });
      await drain(await c.chat.completions.create({ model: MODEL, messages: MSG, stream: true }));
      await c.responses.create({ model: MODEL, input: SECRET_PROMPT });
      await assert.rejects(c.chat.completions.create({ model: MODEL, messages: MSG }));
      const wire = JSON.stringify(ac.getLocalEvents());
      for (const s of [SECRET_PROMPT, SECRET_REPLY, GATEWAY_KEY]) assert.ok(!wire.includes(s), `leaked ${s}`);
    });

    test("a tracker failure never breaks the caller's call", async () => {
      await ac.shutdown();
      const ep = new Endpoint().push(() => json(200, chatCompletion()));
      const c = ac.instrumentOpenAI(ep.client());
      const r = await c.chat.completions.create({ model: MODEL, messages: MSG });
      assert.equal(r.choices[0].message.content, SECRET_REPLY);
    });
  });
});

describe("delivery", () => {
  afterEach(() => ac.shutdown());

  test("event ids are stable when a batch is retried", async () => {
    const backend = new Backend([503, 200]);
    ac.init({ apiKey: "sk_test", projectId: PROJECT, fetch: backend.fetch as any, flushIntervalMs: 600000, baseUrl: "https://ac.test" });
    const ep = new Endpoint().push(() => json(200, chatCompletion()), () => json(200, chatCompletion()));
    const c = ac.instrumentOpenAI(ep.client());
    await c.chat.completions.create({ model: MODEL, messages: MSG });
    await c.chat.completions.create({ model: MODEL, messages: MSG });
    await ac.flush();
    await ac.flush();
    assert.deepEqual(backend.statuses, [503, 200]);
    const first = backend.batches[0].events.map((e: any) => e.event_id);
    const second = backend.batches[1].events.map((e: any) => e.event_id);
    assert.equal(first.length, 2);
    assert.deepEqual(second, first);
    assert.equal(backend.batches[0].project_id, PROJECT);
  });

  test("a non-retryable refusal is dropped, not resent forever", async () => {
    const backend = new Backend([403]);
    const warn = console.warn;
    console.warn = () => undefined;
    try {
      ac.init({ apiKey: "sk_test", projectId: PROJECT, fetch: backend.fetch as any, flushIntervalMs: 600000 });
      const ep = new Endpoint().push(() => json(200, chatCompletion()));
      await ac.instrumentOpenAI(ep.client()).chat.completions.create({ model: MODEL, messages: MSG });
      await ac.flush();
      await ac.flush();
      assert.equal(backend.batches.length, 1);
    } finally {
      console.warn = warn;
    }
  });

  test("network failure keeps the batch; outcomes travel in the batch", async () => {
    let calls = 0;
    const backend = new Backend();
    const flaky = async (i: any, init: any) => {
      if (calls++ === 0) throw new TypeError("fetch failed");
      return backend.fetch(i, init);
    };
    ac.init({ apiKey: "sk_test", projectId: PROJECT, fetch: flaky as any, flushIntervalMs: 600000 });
    const ep = new Endpoint().push(() => json(200, chatCompletion()));
    const c = ac.instrumentOpenAI(ep.client());
    await ac.workflow("job", async () => {
      await c.chat.completions.create({ model: MODEL, messages: MSG });
      ac.outcome(true, "done");
    });
    await ac.flush();
    await ac.flush();
    assert.equal(backend.batches.length, 1);
    assert.equal(backend.batches[0].events.length, 1);
    assert.equal(backend.batches[0].outcomes[0].label, "done");
  });

  test("batches never exceed the backend limit", async () => {
    const backend = new Backend();
    ac.init({ apiKey: "sk_test", projectId: PROJECT, fetch: backend.fetch as any, batchSize: 500, flushIntervalMs: 600000 });
    const ep = new Endpoint();
    for (let i = 0; i < 101; i++) ep.push(() => json(200, chatCompletion()));
    const c = ac.instrumentOpenAI(ep.client());
    for (let i = 0; i < 101; i++) await c.chat.completions.create({ model: MODEL, messages: MSG });
    await ac.flush();
    assert.deepEqual(backend.batches.map((b) => b.events.length), [100, 1]);
  });
});

void GATEWAY;
