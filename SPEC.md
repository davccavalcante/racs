# SPEC: @takk/racs 1.0.0

Engineering specification for RACS (Remote Agent Context Store). This document is the binding contract for the public surface, the planning semantics, the SemVer policy, and the threat model. Where this document and the code disagree, the code is the bug.

---

## 1. Product invariant

RACS never talks to any provider network API. It plans cache directives, normalizes the usage reports the host application already receives from its own provider calls, and accounts for every cached token. The host stays in full control of its own API calls, credentials, retries, and transport.

Consequences, by design:

- **Zero runtime dependencies.** No provider SDK enters the dependency graph; the package is a pure-logic review.
- **Zero credentials.** RACS never sees an API key, so it can never leak one.
- **Runs everywhere.** Node, browsers, edge runtimes, and workers run the same engine; nothing touches sockets or platform globals (the optional file state backend and the CLI are the only Node-bound surfaces, isolated in their own entries).
- **Determinism.** RACS never calls the global random generator. Plan identity derives from a seeded counter (`options.seed`, default 7), and the wall clock is read only where a timestamp is part of the public record, always injectable through `options.clock`.

## 2. Architecture

One engine (`createRACS`) wires seven components. Each is pure or self-contained; the core decides every interaction.

| Component | Module | Responsibility |
|---|---|---|
| Analyzer | `src/plan/PrefixAnalyzer.ts` | Structural linting and prefix geometry: stable-prefix tokens, total tokens, the volatile boundary |
| Planner | `src/plan/Planner.ts` | Maps the analyzed prompt onto one adapter family's directive surface; break-even economics |
| Profiles | `src/providers/profiles.ts` | The 16 shipped provider profiles and the override merge (`resolveProfile`) |
| Ledger | `src/ledger/Ledger.ts` | Bounded LRU aggregation of usage records into per-prefix and ledger-wide statistics |
| Fingerprints | `src/drift/Fingerprints.ts` | Per-lineage segment fingerprints; drift detection across consecutive plans |
| Keeper | `src/schedule/TtlKeeper.ts` | Keep-warm schedule: when each cached prefix needs a refresh touch |
| State | `src/state/{memory,file,kv}.ts` | Snapshot persistence behind the `StateBackend` interface |

The core additionally owns the resource registry (live resource-family caches), the drift ring (capacity 200), the prefix registry (capped at `maxPrefixes`, default 1000, LRU with `limit.reached` telemetry), telemetry fan-out (synchronous, listener exceptions swallowed), and defensive snapshot restore (each section restored in its own try/catch; a corrupt section degrades to empty, never to a crash).

### 2.1 Planning pipeline

`plan(input)` executes, in order: validate input, resolve profile, hash segments (caller `contentHash` wins, otherwise FNV-1a 64 of `content`), analyze (lints plus geometry), derive the prefix key, plan family directives, swap resource `reuse` for `refresh` inside the last 10 percent of the TTL window, assign the deterministic plan id, observe fingerprints (emit `prefix.drifted` when applicable), register the prefix (keeper tracking and resource bookkeeping, degraded with `limit.reached` past the cap), and emit `plan.created`. The same input, options, and seed always produce the same `planId`, `prefixKey`, and directives (benchmark P9).

## 3. Adapter families, semantics as of June 2026

Every named provider parameterizes exactly one family. Numbers live in the profile table and are overridable per engine through `options.profiles`, because providers change terms faster than packages release. Sources were retrieved in June 2026.

### 3.1 Breakpoint family (`anthropic`, `bedrock`, `hermes`, `microsoft-foundry`)

The caller marks explicit cache boundaries in the request body and pays a write premium per marked span. Anthropic `cache_control`: at most 4 breakpoints per request, 5m and 1h TTL tiers, write multipliers 1.25x (5m) and 2x (1h), read multiplier 0.1x, minimum cacheable prefix 1024 tokens in the common case, 512 on the newest frontier models, 4096 on small models (Anthropic prompt caching documentation, docs.claude.com, retrieved June 2026). Amazon Bedrock `cachePoint` blocks on the Converse API carry Anthropic-equivalent semantics (AWS Bedrock prompt caching documentation, retrieved June 2026). Claude on Microsoft Foundry honors `cache_control` unchanged (Microsoft Foundry documentation, retrieved June 2026). Hermes Agent rides Anthropic semantics with its fixed system_and_3 layout, the system prompt plus the last 3 messages (observed June 2026).

Planner behavior: groups the left-anchored stable run into role spans, ranks them tools > system > documents > history (the provider hashes tools, then system, then messages, so each marker preserves partial reuse when a later region drifts), ties broken by span size then request order, takes up to `maxBreakpoints`, re-sorts into request order, and emits `{ kind: 'breakpoint', segmentId, ttl }` per chosen span. Below `minCacheableTokens` the directive is `{ kind: 'none', reason }`.

TTL tier selection from the declared reuse interval: at or below 240 s the 5m tier (60 s refresh headroom under the 300 s window); at or below 3300 s the 1h tier (300 s headroom under 3600 s); above that, the tier stays on only when keep-warm economics hold strictly, `callsPerHour * (1 - readMultiplier) > refreshesPerHour * readMultiplier` (equality declines, see the section 6 touch-cost model), otherwise `none` with the reason `reuse interval exceeds provider TTL, caching would re-write every call` plus a `write-premium-trap` warning. With no declared reuse, the lowest-premium tier and a single assumed reuse.

### 3.2 Routing-key family (`openai`, `xai`, `mistral`, `moonshot`, `openrouter`)

The provider caches implicitly server-side; the caller can only steer routing so identical prefixes land on the same cache shard. OpenAI: automatic caching in 128-token increments above a 1024-token minimum, `prompt_cache_key` stickiness, no write counter and no write premium, read discount 50 to 90 percent by model (0.25x is the conservative shipped default), and an extended 24-hour retention tier attached to the key (OpenAI prompt caching guide, platform.openai.com, retrieved June 2026). xAI steers with the `x-grok-conv-id` header and `prompt_cache_key`, reads near 0.16x (docs.x.ai, retrieved June 2026). Mistral caches in 64-token blocks (docs.mistral.ai, retrieved June 2026). Moonshot Kimi caches via the OpenAI-compatible surface with less documented semantics, so the profile carries conservative defaults (platform.moonshot.ai, retrieved June 2026). OpenRouter normalizes `cache_control` passthrough and `cached_tokens` reporting across upstreams (openrouter.ai/docs, retrieved June 2026).

Planner behavior: one `{ kind: 'routing-key', key, retention? }` directive whose key is the deterministic prefix key. `retention: '24h'` is requested only when the profile supports it and the declared interval strictly exceeds 3600 s (benchmark P5 pins the boundary). The real lever is byte-stability of the prefix, which the lints enforce.

### 3.3 Resource family (`google`)

The cache is a first-class server resource with its own lifecycle. Google Gemini: implicit caching on 2.5 and newer models plus explicit `cachedContents` with caller-set TTL and storage billed per token-hour at 1.0 USD per million tokens per hour, minimum 2048 tokens, reads near 0.1x (Google Gemini API context caching documentation, ai.google.dev, retrieved June 2026).

Planner behavior: `{ kind: 'resource', action, resourceKey, ttlSeconds }` with action `create` on first sight, `reuse` afterward, swapped to `refresh` by the core inside the last 10 percent of the TTL window, and `delete` emitted through telemetry on invalidation. `ttlSeconds` is four times the declared reuse interval clamped to [300, 3600], default 3600. Below one reuse per hour the storage trap fires: the per-token-hour bill outruns the read savings, the directive is `none`, and a `write-premium-trap` warning names the numbers. The host performs the actual lifecycle API calls and mirrors outcomes back through usage recording.

### 3.4 Passive family (`groq`, `deepseek`, `ollama`, `lmstudio`, `huggingface`, `custom`)

No control surface exists. Groq caches automatically on gpt-oss models, reads at 0.5x, entries expire after roughly 2 hours idle (console.groq.com/docs, retrieved June 2026). DeepSeek runs disk-based automatic context caching with hit and miss reporting, reads at 0.1x (api-docs.deepseek.com, retrieved June 2026). Ollama and LM Studio reuse local KV state with no billing dimension (docs.ollama.com and lmstudio.ai/docs, retrieved June 2026). Hugging Face Inference Endpoints expose no public prefix-cache controls as of June 2026. Planner behavior: an explicit reasoned `{ kind: 'none' }`; stable-first ordering and ledger accounting are the entire contribution. Unknown future families degrade to this path.

## 4. The nine lint heuristics

Deterministic, pure functions of the input and profile. Emission order is fixed: structural lints, then per-segment scans in segment order, then the prefix-level summary, then planner-stage extras. Content heuristics run only on segments carrying `content`; hash-only segments are skipped by design. Finding messages never embed matched substrings; matches are referenced by an 8-character FNV digest so findings can travel inside persisted plans.

| Code | Severity | Trigger |
|---|---|---|
| `segment-order` | warning | The first volatile segment that precedes any stable or semi segment |
| `volatile-early` | error | A volatile segment inside the first half of total tokens and before any breakpoint-eligible boundary (the leading stable run is below the provider minimum) |
| `unstable-tools` | error | A `tools` segment declared volatile |
| `missing-stability` | info | A `dynamic` segment declared stable (contradiction guard for untyped callers) |
| `timestamp-in-stable` | warning | Timestamp shapes in a stable or semi segment, three regex classes below |
| `identifier-in-stable` | warning | Per-request identifier shapes in a stable segment, three regex classes below |
| `below-minimum` | info | Stable prefix shorter than `minCacheableTokens` |
| `breakpoint-after-volatile` | error | Planner stage: the only breakpoint candidate follows a volatile segment |
| `write-premium-trap` | warning | Planner stage: declared reuse cannot repay the write premium (breakpoint) or storage bill (resource) |

Regex classes, all bounded, linear-scan, no catastrophic backtracking:

- ISO-8601 datetime: `\b\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:?\d{2})?\b`
- Unix epoch: exact 10-digit (seconds) or 13-digit (milliseconds) runs, `\b(?:\d{13}|\d{10})\b`
- Relative time: the words `today` or `current time` within 32 non-digit characters of a digit on the same line, case-insensitive
- UUID v4: version nibble 4, variant nibble 8 through b
- Hex run: 24 or more hex characters, `\b[0-9a-f]{24,}\b` case-insensitive
- Base64-like run: `[A-Za-z0-9+/]{24,}={0,2}` candidates filtered in code to require at least one digit and one letter, which excludes long prose words and long plain numbers

## 5. Prefix keys and identity

Hashing is FNV-1a 64-bit over UTF-16 code units (two bytes per unit, low byte first), reference offset basis and prime per Fowler, Noll, and Vo, rendered as 16 lowercase hex characters. `combineKeys(parts)` joins parts with the ASCII unit separator U+001F, which cannot occur in hex output, so part boundaries always contribute to the digest and concatenation ambiguity is impossible.

The prefix key fuses, in order: the hashes of the left-anchored stable run (every segment before the first volatile one), the provider id, the model id, and the agent id (empty string when absent). Equal keys mean byte-equal cacheable prefixes on the same provider, model, and agent lineage; different agents never share keys even on identical content. Per the segment content contract, `contentHash` wins for keying when both fields are present.

Plan ids are `rx-<counter>-<base36 digest of seed and counter>`, from a seeded monotonic counter, never the platform UUID.

Non-cryptographic by declaration: FNV-1a is trivially invertible and collision-constructible by an adversary. Keys exist solely so byte-equal inputs get equal bookkeeping keys; they must never gate authentication, authorization, or integrity. Non-adversarial collision odds follow the birthday bound, roughly n^2 / 2^65, about 1 in 37 million at one million distinct prefixes; a collision costs at worst one misattributed statistic, never a wrong answer to the host.

## 6. Break-even formulas

Token estimates feeding these formulas come from explicit `tokens` when given, otherwise `ceil(content.length / 4)`, otherwise 0 (hash-only without a count contributes nothing by design).

Breakpoint family, stated in base-input-token equivalents (multipliers are price-relative, so a pricing table is optional):

```text
writePremiumTokens = coveredTokens * (writeMultiplier - 1)
savingsPerReuse    = coveredTokens * (1 - readMultiplier)
minReusesToProfit  = ceil(writePremiumTokens / savingsPerReuse)
```

Declared reuse inside the TTL window: the provider refreshes the TTL at no cost on every read (refresh-on-use, Anthropic prompt caching documentation, June 2026), so steady reuse keeps the entry alive indefinitely, the single premium is always repaid when `readMultiplier < 1`, `profitable` holds exactly when `minReusesToProfit` is finite, and `expectedReuses` is reported over a one-hour horizon as `max(1, round(callsPerHour))`. Undeclared reuse: a single reuse is assumed and `profitable = 1 >= minReusesToProfit`. `coveredTokens` is the cumulative stable-span total up to the last placed marker, and because the deepest stable boundary is always marked it equals the full stable prefix on emitted plans.

Keep-warm band (interval beyond the widest TTL):

```text
netPerReuse       = savingsPerReuse - (refreshesPerHour / callsPerHour) * coveredTokens * readMultiplier
minReusesToProfit = ceil(writePremiumTokens / netPerReuse)
```

The tier is kept only when `netPerReuse` is strictly positive (equality declines), so a kept tier is always profitable and break-even uses the same touch-cost model as the keep decision; a decline emits `'none'` plus a `'write-premium-trap'` warning. The keep-warm cutoff on Anthropic numbers sits strictly above `callsPerHour = 1/9`.

`intervalSeconds` wins over `callsPerHour` when both are declared; each converts to the other through 3600. Multipliers come from the profile first, and are derived from the pricing table (`writePrice / inputPrice`) when the profile carries none.

Resource family, USD-denominated (per-token-hour storage has no price-relative form, so this requires pricing):

```text
storagePerHourUsd  = stableTokens / 1e6 * storagePerMTokHour
savingsPerCallUsd  = stableTokens / 1e6 * (inputPerMTok - cacheReadPerMTok)
minReusesToProfit  = ceil(storagePerHourUsd / savingsPerCallUsd)   (per hour)
profitable         = callsPerHour >= minReusesToProfit
writePremiumTokens = storagePerHourUsd / inputPerMTok * 1e6        (token-equivalent restatement)
```

Ledger USD math, computed only for models the pricing table covers: `savedUsd = readTokens / 1e6 * (inputPerMTok - cacheReadPerMTok)`; `writeSpendUsd` is the premium over base input per write tier, each tier term clamped at zero so a mispriced table cannot inflate savings; `netUsd = savedUsd - writeSpendUsd`. The normalized hit ratio is `readTokens / (readTokens + writeTokens + uncachedTokens)`, the same formula on every provider, so numbers are comparable across them; a prefix that keeps paying write premiums without reading back scores zero, exactly the failure the ratio exists to expose. Uncached input per record is `max(0, inputTokens - cacheReadTokens - cacheWriteTokens5m - cacheWriteTokens1h)`: `CacheUsage.inputTokens` is the ALL-IN billed input including cached reads and cache writes of both tiers. Adapters normalize provider conventions to all-in: Anthropic-flavored OTel counts (`gen_ai.usage.cache_read_input_tokens`, `cache_creation_input_tokens`, `cache_write_input_tokens`) are EXCLUSIVE and added to `gen_ai.usage.input_tokens`; OpenAI-flavored counts (`cached_tokens`, `input_cached_tokens`) are INCLUSIVE subsets and never added; the Vercel middleware adds the cached subsets back when `usage.inputTokens < reads + writes`, which proves the counts exclusive (the documented limit: exclusive counts whose fresh input outweighs reads plus writes pass through unadjusted).

## 7. Drift semantics

Lineage key: `agentId` when given, otherwise `provider:model`. The fingerprint store remembers, per lineage, the latest prefix key, its stable-token count, and the hash plus declared stability of every segment.

Stable-only comparison: only stable and semi segments count. A volatile segment is declared to differ on every call, so its churn, including appearance and disappearance, is expected behavior and never drift. For a segment present in both plans the current declaration decides (re-declaring a segment volatile opts it out of drift tracking from that plan onward); for a removed segment the previous declaration is used. First observation of a lineage never reports.

A `DriftReport` carries the new and previous prefix keys, the sorted ids of changed, added, or removed stable and semi segments, `invalidatedTokens` equal to the previous stable prefix size when the key changed (those are exactly the cached tokens the drift killed) and zero when the key survived, and the clock timestamp. Reports land in a bounded ring (capacity 200, oldest dropped), readable via `drifts(limit?)`, and emit `prefix.drifted` telemetry. Benchmark P8 pins zero reports across 100 volatile-churn plans and exactly one report per stable mutation.

## 8. Schedule math

The keeper tracks one keep-warm entry per prefix for plans whose directives carry a host-controlled expiry: breakpoint tiers (5m = 300 s, 1h = 3600 s) and resource `ttlSeconds`. Routing-key and `none` plans track nothing. When one plan carries several tracked TTLs, the shortest drives the schedule, since the earliest-expiring span bounds how long the whole prefix stays warm.

```text
refreshAt = lastWriteAt + 0.9 * ttlMillis
```

The 0.9 fraction is the production heartbeat convention (as observed across Anthropic prompt caching deployments, June 2026): touching at 100 percent races expiry against timer drift and request latency, one lost race costs a full write premium, and touching much earlier wastes paid reads. `schedule(now?)` returns entries due at or before `now`, most overdue first, ties broken by prefix key, and emits `refresh.due` per entry. The host performs the warming call and reports it with `markRefreshed(prefixKey, now?)`, which slides the window. The same 0.9 boundary drives the core's resource `reuse` to `refresh` swap.

## 9. Invalidate semantics

`invalidate(filter?)` clears engine bookkeeping for every prefix matching the optional `prefixKey` and `provider` filters (conjunctive): drift fingerprints, keep-warm entries, and resource registry records. It emits one `resource.action` telemetry event with action `delete` per invalidated resource so the host can mirror the deletion onto the provider (Gemini `cachedContents` deletes especially). It returns the number of distinct prefixes cleared. Without a filter, everything is cleared. Fingerprint lineages carry no provider attribution of their own, so under a provider filter only prefixes attributed through the registries are pruned; without one, every matching lineage goes, including lineages for capped prefixes the registry never tracked.

Built for credential rotation: provider-side cached resources may be scoped to the credential or workspace that created them, so after a key rotates their handles are unreliable or orphaned; invalidate and re-plan from scratch. Ledger statistics and drift history are accounting records, not cache state, and are deliberately left untouched.

## 10. Public API reference

### 10.1 `@takk/racs` (core)

- `createRACS(options?: RACSOptions): RACS`, the single entry point. Zero-config default: in-memory engine, shipped profiles, seed 7, 1000-prefix cap, wall clock.
- `RACS`: `plan(input)`, `lint(input)`, `record(usage)`, `stats(filter?)`, `schedule(now?)`, `markRefreshed(prefixKey, now?)`, `drifts(limit?)`, `invalidate(filter?)`, `profileOf(provider)`, `on(listener)`, `flush()`, `close()`. All planning and accounting methods are synchronous; only `flush` and `close` are async because persistence may be.
- `RACSOptions`: `profiles`, `pricing`, `maxPrefixes`, `seed`, `state`, `clock`.
- Profiles: `PROVIDER_PROFILES`, `resolveProfile(id, overrides?)`.
- State backends: `memoryState()`, `fileState(options)` (Node-only), `kvState(kv, key?)` over any `KvLike`.
- Building blocks: `PrefixAnalyzer`, `Planner`, `Ledger`, `fnv1a64`, `combineKeys`, `estimateTokens`.
- Errors: `RacsError` with stable `code` (`ERR_INVALID_INPUT`, `ERR_STATE_LOAD`, `ERR_STATE_VERSION`); branch on `code`, never on `message`.
- Types: `PlanInput`, `PromptSegment`, `SegmentRole`, `Stability`, `ExpectedReuse`, `CachePlan`, `CacheDirective`, `CacheTtl`, `LintCode`, `LintFinding`, `BreakEven`, `CacheUsage`, `Pricing`, `PricingTable`, `PrefixStats`, `LedgerStats`, `DriftReport`, `RefreshEntry`, `TelemetryEvent`, `TelemetryListener`, `ProviderId`, `ProviderProfile`, `AdapterFamily`, `KvLike`, `StateBackend`, `StateSnapshot`.

### 10.2 `@takk/racs/otel`

- `usageFromSpan(span: GenAISpanLike, fallback?): CacheUsage | undefined`. Structural ingestion of finished GenAI spans: provider from `gen_ai.system` (spelling table, case-insensitive) with fallback, model from request then response attributes then fallback, input tokens normalized to the all-in convention per attribute spelling, cached reads across three attribute spellings, cache writes across two spellings attributed to the 5-minute tier (the conventions carry no TTL split; the cheaper premium is the conservative default), timestamp from the span end. Reads identity and counters only, never content attributes. Returns `undefined` without a resolvable provider and model.

### 10.3 `@takk/racs/vercel`

- `racsMiddleware(racs, { provider, model, segmenter?, clock? }): RacsMiddleware`, structurally compatible with `LanguageModelV3Middleware`. `transformParams` plans and applies directives through `providerOptions` (Anthropic `cacheControl`, OpenAI `promptCacheKey` plus `promptCacheRetention`, a `providerOptions.racs` stash carrying the prefix key); `wrapGenerate` and `wrapStream` record usage with documented fallback chains across SDK spellings, streams teed and never consumed. A thrown wrapped call records nothing, no usage exists.
- `defaultSegmenter(params)`: system stable, tools stable (JSON-keyed), prior messages one semi history segment, final message volatile. Content capped at 8000 characters for hashing; hosts needing exact economics pass their own segmenter.

### 10.4 `@takk/racs/integrations`

- `noeticosBridge(racs, noeticosLike, { releaseAfterStablePlans? })`: freezes parameter tuning on `prefix.drifted` for the affected agent, releases after 3 consecutive zero-drift plans (default), re-freezes on a new drift. `noeticosAdapter(module, runtime)` folds the published function pair into the structural shape.
- `behavioralaiBridge(racs, behavioralLike, { agentId?, pricing? })`: reports one synthetic turn per `usage.recorded` event, keys and counts only.
- `modelchainBridge(racs)`: `planForModel(base, modelId)`, per routed model, because provider caches are per-model.
- `keymeshBridge(racs, keymeshLike, { providers })`: calls `invalidate({ provider })` on `key.rotated` and `circuit.open`.
- All shapes are local structural interfaces; no sibling package is imported at runtime or at the type level, and the siblings stay optional peer dependencies.

### 10.5 `@takk/racs/web` and `@takk/racs/edge`

The full core surface minus `fileState`, so browser and edge bundles never advertise a backend they cannot run. No `node:` imports anywhere in these graphs.

### 10.6 CLI `racs`

Commands: `help`, `version`, `analyze --input <path> [--pricing <path>]`, `simulate [--calls] [--seed] [--interval] [--provider]`, `inspect --state <path> [--pricing] [--watch]`, `serve [--port] [--host] [--token] [--state] [--seed] [--cors-origin] [--insecure-no-token]`. Exit codes: 0 success, 1 gate or runtime failure (analyze error findings, refused serve startup), 2 usage errors. The first line of `racs help` is the tested CI contract: exactly `racs 1.0.0`.

`serve` endpoints: `GET /healthz` (no bearer required), `POST /plan`, `POST /lint`, `POST /usage`, `GET /stats`, `GET /schedule`, `POST /refreshed`, `POST /invalidate`. Posture: loopback bind by default; non-loopback refused without `--token` unless `--insecure-no-token` is passed with a loud warning; in tokenless mode every request whose Host header hostname (port stripped, IPv6 brackets tolerated) is not loopback (`localhost`, `127.0.0.1`, `::1`) is answered 403 `forbidden host`, the DNS-rebinding defense, `/healthz` included for consistency; bearer compared in constant time over SHA-256 digests; POST bodies must be `application/json` (415) and at most 1 MB (413); CORS headers emitted only when `--token` and `--cors-origin` are both set; SIGINT and SIGTERM flush state and exit 0.

## 11. SemVer policy

The package follows SemVer 2.0.0. The public surface is everything exported from the six entry points plus the CLI flag and exit-code contract and the serve endpoint contract.

Minor-extensible unions, declared: `ProviderId`, `LintCode`, and `TelemetryEvent` may gain new members in minor versions. Consumers must tolerate unknown members: treat these unions as open when switching on them, fall through gracefully on codes, providers, and event types they do not recognize. The same applies to `SegmentRole`, to `RacsError.code` values, and to new discriminants on discriminated unions: new `CacheDirective` kinds and new decision-shaped variants may appear in minors, and exhaustive switches in consumer code should carry a default arm. `CacheTtl` (`'5m' | '1h'`), the routing-key retention literal (`'24h'`), and the resource directive action union (`'create' | 'reuse' | 'refresh' | 'delete'`) are minor-extensible in the same way: new TTL tiers, retention literals, and lifecycle actions may appear in minor versions, and consumers must tolerate unknown members exactly as with `ProviderId`.

- **Patch**: bug fixes, internal refactors, documentation, dependency-free tooling.
- **Minor**: new optional exports, new optional fields, new union members per the rule above, new profile entries, new CLI flags with defaults preserving current behavior.
- **Major**: renaming or removing an export, changing a signature, changing the meaning of an existing directive kind or lint code, changing the `StateSnapshot` layout incompatibly (the snapshot carries `version: 1` and the loader rejects unknown versions with `ERR_STATE_VERSION`), removing a CLI flag, changing an exit code.

Numbers inside shipped profiles (multipliers, minimums, TTL tiers) are research snapshots, not API: they may be corrected in patches, and `options.profiles` exists precisely so hosts never wait for a release. The TeleologHI provider is reserved for 2.0.0.

## 12. The planning benchmark (P1-P10)

`tests/integration/planning-benchmark.test.ts` is the permanent planning-quality contract: ten labeled scenarios with hard bounds pinning provider-faithful behavior in CI forever. A regression on any bound must fail the suite. Every asserted number is hand-computed in a comment next to its assertion, and every scenario runs on an injected clock and fixed seed.

| ID | Contract | Bound |
|---|---|---|
| P1 | Breakpoint fidelity | Exactly 4 markers on the role-weighted largest stable spans, re-sorted into request order, never after the volatile tail, never on the dropped history span |
| P2 | Volatile-early trap | The naive layout yields exactly the finding sequence `segment-order`, `volatile-early` (the one error), `timestamp-in-stable`, `below-minimum`, and the plan is still emitted with a reasoned `none` |
| P3 | Minimum boundary | 1023 estimated tokens yields `none` plus `below-minimum`; exactly 1024 yields a breakpoint |
| P4 | TTL economics | 120 s reuse maps to 5m; 1800 s, 2400 s, and 3300 s map to a profitable 1h under refresh-on-use (premium 4000 tokens, minReuses 2, zero traps); keep-warm at 0.5 and 0.2 calls per hour uses the touch-cost model (minReuses 2 and 3, profitable); at 0.1 calls per hour the planner refuses with the TTL-limit reason plus a write-premium-trap finding |
| P5 | Routing-key stability | 50 OpenAI plans share one prefix key equal to the directive key; retention `24h` appears only strictly above 3600 s declared reuse |
| P6 | Resource lifecycle | Action sequence exactly `create`, `reuse`, `refresh` (inside the last 10 percent of a 2400 s TTL), `delete` (on invalidate); the storage trap at 0.5 calls per hour yields `none` with break-even 800 token equivalents and minReuses 1 |
| P7 | Ledger exactness | Over a scripted 7-call stream: hitRatio = 3500/8000, savedUsd = 0.01575, netUsd = 0.006625, each to 1e-9 |
| P8 | Drift precision | Zero reports across 100 volatile-churn plans; one exact report per stable mutation and per A/B flip, with `invalidatedTokens` equal to the prior stable prefix |
| P9 | Determinism | Same seed and call sequence on two engines: deeply identical plans, ids included |
| P10 | Simulate parity | The CLI simulation holds structured hit ratio above 0.85, naive exactly 0, structured net savings positive, naive premium loss positive |

The full test baseline is 187 tests across 13 suites on Node 22 and Node 24; coverage 92.46 percent statements, 82.09 branches, 93.33 functions, 92.49 lines.

## 13. Limits

- **Token estimates are heuristics.** The 4-characters-per-token estimate gates planning thresholds and break-even math; it is typically within tens of percent for English prose and worse for CJK or dense code. Provider truth arrives through usage reports after the fact. Pass exact `tokens` from a real tokenizer when precision matters.
- **No provider API calls, by design.** RACS cannot verify a cache hit happened; it can only account for what the host reports. The invariant is the feature.
- **Per-process learning.** Fingerprints, schedules, and aggregates live in one engine. KV persistence shares state across restarts and replicas as last-writer-wins snapshots; it is not coordination.
- **Pricing accuracy is the caller's.** USD figures are exactly as good as the supplied table. Stale prices produce stale dollars; token statistics are always exact with respect to the reported usage.
- **Bounded stores degrade, never grow.** Past `maxPrefixes`, new prefixes are planned in full but get no keep-warm or resource bookkeeping, with a `limit.reached` event; the ledger and fingerprints evict LRU.

## 14. Threat model summary

The full policy is in [SECURITY.md](./SECURITY.md).

- **No credentials, ever.** RACS handles no API keys, so credential theft through this package is structurally impossible. The KV and sibling bridges receive ready objects; connection secrets never transit RACS.
- **Forged usage is the operator trust boundary.** `record()` trusts the caller. A host (or anything that can reach an authenticated serve bridge) can submit fabricated `CacheUsage` and skew hit ratios and USD figures. Forged usage never alters directives, plans, or scheduling, only analytics; treat ledger output with the same trust you give the process feeding it. This boundary is documented, not defended, because the engine and its feeder are the same trust domain.
- **Serve posture.** Loopback by default, explicit opt-in for network exposure, tokenless Host-header validation against DNS rebinding (403 `forbidden host` on non-loopback names, `/healthz` included), constant-time bearer comparison, content-type and body-size gates, CORS off unless doubly opted in, version-validated snapshot loading (`ERR_STATE_VERSION`), defensive section-by-section restore.
- **Cache keys are non-cryptographic.** FNV-1a 64 keys are predictable and collision-constructible; they are bookkeeping labels and are never used for authentication, authorization, or integrity, and must not be repurposed for any of those.
