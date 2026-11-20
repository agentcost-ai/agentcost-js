// The CommonJS build works under require(), and the CJS and ESM builds share
// one tracker and one attribution context when an app loads both.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const OpenAI = require("openai").default ?? require("openai");
const cjs = require("../dist/cjs/index.js");

const completion = {
  id: "chatcmpl-cjs",
  object: "chat.completion",
  created: 1,
  model: "m-served",
  choices: [{ index: 0, message: { role: "assistant", content: "x" }, finish_reason: "stop" }],
  usage: { prompt_tokens: 7, completion_tokens: 2, total_tokens: 9 },
};
const fakeFetch = async () => new Response(JSON.stringify(completion), { status: 200, headers: { "content-type": "application/json" } });

test("require() build records calls", async () => {
  cjs.init({ localMode: true });
  try {
    const client = cjs.instrumentOpenAI(new OpenAI({ apiKey: "k", baseURL: "https://gw.example/v1", fetch: fakeFetch, maxRetries: 0 }));
    await cjs.agent("cjs-agent", () => client.chat.completions.create({ model: "m", messages: [{ role: "user", content: "hi" }] }));
    const [e] = cjs.getLocalEvents();
    assert.equal(e.agent_name, "cjs-agent");
    assert.equal(e.input_tokens, 7);
    assert.equal(e.metadata.gateway_host, "gw.example");
  } finally {
    await cjs.shutdown();
  }
});

test("ESM and CJS builds share the tracker and context", async () => {
  const esm = await import(pathToFileURL(path.join(__dirname, "../dist/esm/index.js")).href);
  assert.notEqual(esm.init, cjs.init, "two module instances are loaded");
  cjs.init({ localMode: true });
  try {
    const client = esm.instrumentOpenAI(new OpenAI({ apiKey: "k", baseURL: "https://gw.example/v1", fetch: fakeFetch, maxRetries: 0 }));
    await cjs.agent("shared-agent", () => esm.workflow("job", () => client.chat.completions.create({ model: "m", messages: [] })));
    const events = esm.getLocalEvents();
    assert.equal(events.length, 1);
    assert.equal(events[0].agent_name, "shared-agent");
    assert.equal(events[0].workflow, "job");
  } finally {
    await esm.shutdown();
  }
});
