# Changelog

All notable changes to `@takk/racs` are documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html). Every entry carries a UTC timestamp.

## [1.0.0] - 2026-06-12T04:35:39Z

Initial stable release. RACS (Remote Agent Context Store): provider-faithful prefix-cache planning, linting, scheduling, drift detection, persistence, and savings analytics for Massive Intelligence (IM) agent workloads, without ever calling a provider API. Zero runtime dependencies. 187 tests across 13 suites on Node 22 and Node 24.

### Added

#### Engine core (`@takk/racs`)

- `createRACS(options)` factory returning the full engine surface: `plan`, `lint`, `record`, `stats`, `schedule`, `markRefreshed`, `drifts`, `invalidate`, `profileOf`, `on`, `flush`, `close`.
- Product invariant enforced throughout: no provider network calls, no credentials, no global randomness; deterministic plan ids from a seeded counter (`seed`, default 7) and an injectable clock.
- `PrefixAnalyzer` with nine lint codes: `volatile-early`, `below-minimum`, `unstable-tools`, `timestamp-in-stable`, `identifier-in-stable`, `breakpoint-after-volatile`, `write-premium-trap`, `segment-order`, `missing-stability`. Content heuristics use bounded regex classes (ISO-8601, unix epoch, relative-time-near-digits, UUID v4, hex runs, filtered base64 runs) and never embed matched substrings in findings.
- `Planner` mapping analyzed prompts onto four adapter families: explicit `breakpoint` markers with role-weighted span selection and TTL tier choice, `routing-key` directives with optional 24h retention, `resource` lifecycle directives (`create`/`reuse`/`refresh`/`delete`) with storage-trap protection, and reasoned `none` for passive providers.
- Forced deepest-marker coverage on breakpoint plans: the deepest stable boundary always takes a marker because the last marker determines left-anchored coverage, remaining slots fill in role-weight order, and coverage plus economics are accounted cumulatively to that forced deepest marker, so the reasoning states exactly how many prompt tokens the markers cover and the premium is priced on the covered tokens, never on a flattering subset.
- Break-even economics on every breakpoint and resource plan: write-premium tokens, minimum reuses to profit, profitability against the declared reuse pattern, with a human-readable derivation. The reuse model is refresh-on-use: cache reads refresh the provider TTL window at no extra cost, so steady reuse inside the window keeps a single write alive indefinitely, reuse past the widest window is priced with explicit keep-warm touch costs, and a plan that cannot repay its write is declined with a reasoned `none` plus the `write-premium-trap` finding, so an emitted breakpoint plan is never knowingly unprofitable.
- Deterministic prefix keys: FNV-1a 64 over UTF-16 code units, fused with provider, model, and agent lineage through a separator-safe `combineKeys`. Hash-only privacy mode: segments keyed by caller-supplied `contentHash`, content never required.
- Prefix drift detection (`Fingerprints`): per-lineage stable-and-semi fingerprints, changed-segment naming, invalidated-token quantification, a 200-entry drift ring, `prefix.drifted` telemetry.
- TTL keep-warm scheduling (`TtlKeeper`): refresh touches at 90 percent of the TTL window, shortest-TTL-wins on multi-directive plans, `schedule`/`markRefreshed` round trip, `refresh.due` telemetry.
- Usage ledger (`Ledger`): normalized hit ratio (`reads / (reads + writes + uncached)`) under the all-in accounting convention, `CacheUsage.inputTokens` is the all-in billed input including cached reads and cache writes of both TTL tiers, and the uncached remainder subtracts all three, so one workload reports one identical hit ratio whether usage arrives ledger-direct, through OTel span ingestion, through the Vercel AI SDK middleware, or through simulate accounting (cross-entry-point equality, probed to 1e-9). USD savings and net figures from a user-supplied `PricingTable` (prices are never hardcoded), per-prefix breakdown, bounded LRU with `limit.reached` telemetry.
- `invalidate({ prefixKey?, provider? })`: clears fingerprints, keep-warm schedules, and resource registry entries; emits a `resource.action` delete per dropped resource for the host to mirror; built for credential rotation; ledger and drift history deliberately untouched.
- 16 provider profiles over the 4 families: `anthropic`, `bedrock`, `hermes`, `microsoft-foundry` (breakpoint; `cache_control` or `cachePoint`, 4 breakpoints, 5m and 1h TTLs, 1.25x and 2x write premiums, 0.1x reads, and the 1024-token Anthropic minimum on every breakpoint profile, hermes included, so a below-minimum prefix plans to a reasoned `none` instead of a write the provider would silently ignore); `openai`, `xai`, `mistral`, `moonshot`, `openrouter` (routing-key; `prompt_cache_key` style stickiness, optional 24h retention); `google` (resource; `cachedContent` lifecycle with per-token-hour storage economics); `groq`, `deepseek`, `ollama`, `lmstudio`, `huggingface`, `custom` (passive; analytics only). Every number overridable per engine through `options.profiles`.
- Telemetry: `plan.created`, `prefix.drifted`, `usage.recorded`, `refresh.due`, `resource.action`, `limit.reached`; synchronous fan-out, listener exceptions contained.
- `RacsError` with stable machine-readable codes: `ERR_INVALID_INPUT`, `ERR_STATE_LOAD`, `ERR_STATE_VERSION`.

#### State backends

- `memoryState()` (default posture), `fileState({ path })` (Node-only, atomic JSON snapshot), and `kvState(kv, key?)` wrapping any Redis, Upstash, or Cloudflare KV client in one line through the structural `KvLike` interface.
- Snapshots carry hashes and aggregates only, never prompt content; version-validated (`version: 1`) and restored section by section, a corrupt section degrades to empty instead of crashing the engine.

#### `@takk/racs/otel`

- `usageFromSpan(span, fallback?)`: structural ingestion of finished OpenTelemetry GenAI spans into normalized `CacheUsage`, tolerating the Anthropic-flavored, OpenLLMetry, and draft semantic-convention attribute spellings, plus OTLP JSON int64 strings. Reads token counters and identity only, never prompt or completion attributes.

#### `@takk/racs/vercel`

- `racsMiddleware(racs, options)`: Vercel AI SDK middleware (structurally `LanguageModelV3Middleware`) that plans per call, applies directives via `providerOptions`, and records usage from both `wrapGenerate` and `wrapStream` (stream teed, parts untouched, finish-part usage recorded on flush).
- `defaultSegmenter` mapping the conventional call anatomy onto segments, fully replaceable through `options.segmenter`.

#### `@takk/racs/integrations`

- `noeticosBridge`: freezes parameter tuning on prefix drift, releases after 3 stable plans; plus `noeticosAdapter` folding the published module surface into the structural shape.
- `behavioralaiBridge`: turns the cache into a behaviorally observed agent, one synthetic turn per recorded usage, keys and counts only.
- `modelchainBridge`: per-routed-model cache planning.
- `keymeshBridge`: provider-scoped invalidation on credential rotation and opened circuits.
- All bridges are structural; siblings remain optional peer dependencies and are never imported at runtime.

#### `@takk/racs/web` and `@takk/racs/edge`

- Full engine surface without the Node-only file backend; no `node:` imports in either graph; runs in browsers, Cloudflare Workers, and other edge runtimes.

#### CLI `racs`

- `help` (first line `racs 1.0.0`, a tested CI contract), `version`, `analyze` (PlanInput lint-and-plan gate, exit 1 on error findings), `simulate` (deterministic structured-versus-naive demonstration, byte-identical output per flag set), `inspect` (snapshot rendering with optional `--watch`), and `serve`.
- `racs serve`: hardened local HTTP bridge with `/healthz`, `/plan`, `/lint`, `/usage`, `/stats`, `/schedule`, `/refreshed`, `/invalidate`; loopback by default, constant-time bearer auth, and Host-header validation on tokenless instances: any request whose Host header is not a loopback name (`localhost`, `127.0.0.1`, `::1`, port stripped, IPv6 brackets tolerated) is answered 403 `forbidden host`, closing the DNS-rebinding vector, `/healthz` included; with `--token` the bearer is the gate and the Host header is not consulted. Plus 415/413 body gates, CORS only when token and origin are both configured, graceful signal shutdown with state flush.

#### Documentation

- "Caching MCP tool descriptions" section in the README: the serialized `tools/list` response of an MCP server becomes one stable `'tools'` segment, the role with the highest breakpoint placement weight, with deterministic-serialization guidance backed by the `unstable-tools` lint. Runnable companion example [examples/mcp-tools-segment.ts](./examples/mcp-tools-segment.ts), structural on purpose, no MCP SDK import.

#### Quality contract

- Planning benchmark P1-P10 pinning breakpoint fidelity, the volatile-early trap, minimum boundaries, TTL economics, routing-key stability, the resource lifecycle, ledger exactness, drift precision, cross-engine determinism, and simulate parity.
- SemVer extensibility clauses (SPEC section 11): `ProviderId`, `LintCode`, `TelemetryEvent`, `SegmentRole`, `RacsError.code`, `CacheDirective` kinds, `CacheTtl` tiers, the retention literal union, and the resource lifecycle action union are declared minor-extensible; consumers treat them as open unions and carry a default arm on exhaustive switches.
- 187 tests across 13 suites; coverage 92.46 percent statements, 82.09 branches, 93.33 functions, 92.49 lines.
- Brotli budgets enforced in CI: core 10.72 kB ESM / 10.86 kB CJS, `/otel` 604 B, `/vercel` 1.15 kB, `/integrations` 666 B, `/web` 10.23 kB, `/edge` 10.23 kB. Published tarball: 46 files.
