# Tracking calls through a gateway or proxy

Many teams call models through an OpenAI-compatible gateway, a proxy, or a
self-hosted endpoint instead of the provider directly. AgentCost tracks those
calls the same way: the SDK records each call inside your application and sends
usage, never content, to your AgentCost project. Nothing needs to run on the
gateway.

## Connect

### TypeScript / JavaScript

```sh
npm install @agentcost/sdk openai
```

```ts
import OpenAI from "openai";
import * as agentcost from "@agentcost/sdk";

agentcost.init(); // reads AGENTCOST_API_KEY and AGENTCOST_PROJECT_ID

const client = agentcost.instrumentOpenAI(
  new OpenAI({ baseURL: process.env.GATEWAY_BASE_URL, apiKey: process.env.GATEWAY_API_KEY }),
);
```

LangChain.js and the Vercel AI SDK work the same way with `agentcostCallbacks()`
and `agentcostMiddleware()`.

### Python

```sh
pip install agentcost openai
```

```python
import os
from openai import OpenAI
from agentcost import track_costs

track_costs.init(api_key=os.environ["AGENTCOST_API_KEY"], project_id=os.environ["AGENTCOST_PROJECT_ID"])
client = OpenAI(base_url=os.environ["GATEWAY_BASE_URL"], api_key=os.environ["GATEWAY_API_KEY"])
```

## Agents and jobs

| You want cost per | Wrap the calls in | Shows up as |
|---|---|---|
| agent | `agent("name")` | `agent_name` |
| job (a named, repeatable task) | `workflow("job-name")` | `workflow` |
| one run of that job | the same `workflow()` block | `trace_id` |
| step inside a run | `step("name")` | `step_name` |
| customer, tenant, anything | `metadata(...)` | `metadata` |

In the dashboard: **Agents** for cost per agent, **Workflows** for what one run
of a job costs, **Events** for individual calls.

## What each event carries

Requested model (the priced field), input / output / cached tokens, latency,
success, the attribution above, an `event_id` idempotency key, and in
`metadata`:

- `gateway_host`: the base URL's host (host only, never the path)
- `response_model`: the model the endpoint said it served
- `response_id`: the endpoint's id for the call
- `usage_source`: `response` (counts from the endpoint), `estimated`, or
  `missing` (no usage arrived; the zeros are placeholders, not zero usage)

Prompts, completions, API keys and error message text are never sent.

## Cost

AgentCost prices each call from its own model catalogue and the token counts
the endpoint reports. A gateway that bills with its own prices or multipliers
will show a different total in its console; use `response_id` to match a call
between the two. Models not yet in the catalogue are recorded with their tokens
and a cost of $0.

## Check it works

1. Make one call.
2. Flush: Python `track_costs.flush()`, TypeScript `await agentcost.flush()`.
3. AgentCost dashboard → **Events**: the call appears with its model and tokens.
   The metadata fields are readable through the API:
   ```sh
   curl -s -H "Authorization: Bearer $AGENTCOST_API_KEY" "https://api.agentcost.tech/v1/events?limit=5"
   ```

Short-lived scripts and serverless functions must flush before exiting
(TypeScript: `await agentcost.shutdown()`; Python flushes at exit).

## Troubleshooting

| Symptom | Cause |
|---|---|
| No events | `AGENTCOST_API_KEY` / `AGENTCOST_PROJECT_ID` missing or wrong (the SDK warns), or the process exited without flushing |
| `usage_source: missing` | the endpoint sent no usage for that call, or the call failed |
| Python warns `AgentCost has no pricing for model ...` | the SDK's local price list lacks the model; the AgentCost server prices it on arrival |
| Same call recorded twice | the call is tracked twice, e.g. `instrumentOpenAI` on a client that LangChain also wraps |
| Streamed calls show no usage | the endpoint ignores `stream_options.include_usage`; the event says `usage_source: missing` |
