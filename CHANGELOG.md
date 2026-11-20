# Changelog

All notable changes to the AgentCost TypeScript / JavaScript SDK.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [0.1.1] - 2026-11-20

### Changed
- Documentation and examples: the gateway guide and examples are vendor-neutral
  (`docs/gateways.md`, `examples/gateway.ts`). No code changes.

## [0.1.0] - 2026-11-20

### Added
- Integrations: OpenAI (incl. Azure and OpenAI-compatible gateways), Anthropic,
  Google Gen AI, LangChain.js callback handler, Vercel AI SDK language and
  embedding middleware.
- Attribution context: `agent()`, `metadata()`, `workflow()`, `step()`,
  `tool()`, `outcome()`, shared across async boundaries with AsyncLocalStorage.
- Event fields matching the Python SDK: idempotency `event_id`,
  `metadata.usage_source` (`response` / `estimated` / `missing`),
  `response_model`, `response_id`, `gateway_host`, `stream_options_rejected`,
  `_ac_caps` capability fingerprint, cache read and cache write tokens.
- Batched delivery with retry of the same batch (stable `event_id`s) on network
  errors, timeouts, 408, 429 and 5xx.
- ESM and CommonJS builds with types; one shared tracker when both are loaded.
