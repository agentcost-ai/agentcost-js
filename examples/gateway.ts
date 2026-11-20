// Track calls made through an OpenAI-compatible gateway or proxy. After `npm run build`:
//   GATEWAY_BASE_URL=... GATEWAY_API_KEY=... AGENTCOST_API_KEY=... AGENTCOST_PROJECT_ID=... node dist-test/examples/gateway.js
import OpenAI from "openai";
import * as agentcost from "../src/index.js";

async function main() {
  agentcost.init();
  const client = agentcost.instrumentOpenAI(
    new OpenAI({ baseURL: process.env.GATEWAY_BASE_URL, apiKey: process.env.GATEWAY_API_KEY }),
  );

  await agentcost.agent("example-agent", () =>
    agentcost.workflow("example-job", async (traceId) => {
      const stream = await client.chat.completions.create({
        model: process.env.MODEL ?? "gpt-4o",
        messages: [{ role: "user", content: "Say hello." }],
        stream: true,
      });
      for await (const chunk of stream) process.stdout.write(chunk.choices[0]?.delta?.content ?? "");
      process.stdout.write(`\ntrace ${traceId}\n`);
      agentcost.outcome(true);
    }),
  );

  await agentcost.shutdown();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
