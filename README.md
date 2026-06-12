# RACS NPM

[![npm version](https://img.shields.io/badge/npm-1.0.0-blue)](https://www.npmjs.com/package/@takk/racs)
[![license](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](./LICENSE)
[![types](https://img.shields.io/badge/types-TypeScript-3178c6)](./SPEC.md)
[![tests](https://img.shields.io/badge/tests-187%20passing-brightgreen)](./SPEC.md#12-the-planning-benchmark-p1-p10)
[![coverage](https://img.shields.io/badge/coverage-92%25-brightgreen)](./SPEC.md)
[![runtime deps](https://img.shields.io/badge/runtime%20deps-0-success)](./package.json)

<p align="center">
  <img src="https://raw.githubusercontent.com/davccavalcante/racs/main/assets/racs.png" alt="RACS" width="500">
</p>

RACS (Remote Agent Context Store) plans provider-faithful prefix-cache directives for Massive Intelligence (IM) agent workloads, and it never calls a provider API. That is the product invariant: zero credentials, zero network, the host stays in full control of its own calls, retries, and transport. RACS tells you where to place `cache_control` breakpoints, which `prompt_cache_key` to send, when to create, refresh, or delete a Gemini `cachedContent` resource, and when a cache write would lose money. You apply the directives to the call you were already making, then report the usage counters you already received, and RACS accounts for every cached token.

Why it exists: prefix caching saves 41 to 80 percent of input spend in measured agent workloads (arXiv 2601.06007, January 2026), and the documented production failure is volatile content silently busting the cache. One OpenClaw issue measured ten times the expected cost from timestamps interpolated into a system prompt. Providers also disagree on semantics: Anthropic wants explicit breakpoints, OpenAI caches automatically behind routing keys with no write counter, Gemini bills server-side cached content by the token-hour. As of June 2026 we found no shipping npm package that combines stability linting, multi-provider directive planning, drift detection, persistence, and savings analytics, and the Hermes Agent ecosystem has multiple open issues asking for exactly these capabilities.

What ships: 16 provider profiles over 4 adapter families, 9 lint codes catching the documented cache-killers, deterministic prefix keys (FNV-1a 64), break-even math, TTL keep-warm scheduling, prefix drift detection, hit-ratio and USD savings analytics with user-supplied pricing, memory, file, and KV persistence, a Vercel AI SDK middleware, OpenTelemetry GenAI ingestion, bridges for the @takk family, and a CLI with a hardened HTTP bridge. Zero runtime dependencies. 187 tests across 13 suites on Node 22 and Node 24.

---

## See it run

This is the literal output of the deterministic simulation that ships in the CLI. Same flags, same bytes, every run:

```console
$ racs simulate --calls 400 --seed 7
racs simulate: 400 calls, seed 7, interval 60s, provider anthropic
structured lint: clean
naive lint:
LINT warning segment-order naive-turn Volatile segment 'naive-turn' precedes stable segment 'naive-tools'. Prefix caches are left-anchored, so every token after 'naive-turn' is unreachable for the cache. Reorder stable-first: move 'naive-tools' and every other stable segment ahead of 'naive-turn'.
LINT warning timestamp-in-stable naive-system Segment 'naive-system' is declared stable but contains an ISO-8601 datetime (digest 9d6f8366), and the words 'today' or 'current time' near digits. A timestamp changes the prefix on every call and silently defeats the cache. Move live time values into a volatile segment at the prompt tail.
drift naive: 217dbd595cc63a93 -> 7dfee9d9ed5102b9, segments [naive-system], 3000 tokens invalidated (call 2)
drift naive: 7dfee9d9ed5102b9 -> 44338bff92d176f9, segments [naive-system], 3000 tokens invalidated (call 3)
drift naive: 44338bff92d176f9 -> afa57f324ffa6032, segments [naive-system], 3000 tokens invalidated (call 4)
[... 399 lines hidden: 396 further drift reports (calls 5 through 400) and the progress lines at calls 100, 200, and 300 ...]
progress: 400/400 calls, structured hits 399, naive hits 0
--- summary ---
calls: 400
structured: hit ratio 0.96, net savings 9.87 USD
naive: hit ratio 0.00, write-premium loss 1.50 USD
structured prompt saves $11.37 (88.1%) versus naive
```

Two prompts with identical content run side by side. The structured one orders stable segments first and hits the cache on 399 of 400 calls. The naive one interpolates a timestamp into its "stable" system prompt, so the prefix key drifts on every call, it never reads a single cached token, and it pays the write premium 400 times. RACS catches the bug at lint time, names the segment, and quantifies the loss.

---

## Quickstart

```bash
pnpm add @takk/racs
# or: npm install @takk/racs
```

Plan, apply, record. The whole integration is this loop:

```ts
import { createRACS } from '@takk/racs';

const racs = createRACS({
  // Pricing is always user-supplied; without it you still get every
  // token-denominated statistic, just no USD figures.
  pricing: {
    'claude-sonnet-4-5': {
      inputPerMTok: 3,
      cacheReadPerMTok: 0.3,
      cacheWrite5mPerMTok: 3.75,
      cacheWrite1hPerMTok: 6,
    },
  },
});

const plan = racs.plan({
  agentId: 'support-agent',
  provider: 'anthropic',
  model: 'claude-sonnet-4-5',
  segments: [
    { id: 'system', role: 'system', stability: 'stable', content: SYSTEM_PROMPT },
    { id: 'tools', role: 'tools', stability: 'stable', content: TOOLS_JSON },
    { id: 'history', role: 'history', stability: 'semi', content: historyText },
    { id: 'turn', role: 'dynamic', stability: 'volatile', content: userTurn },
  ],
  reuse: { intervalSeconds: 60 },
});

// Gate on the lint pass: an error-severity finding means the prompt as
// declared cannot achieve cache hits.
const fatal = plan.findings.find((finding) => finding.severity === 'error');
if (fatal !== undefined) throw new Error(`${fatal.code}: ${fatal.message}`);

// plan.directives for this input:
//   [{ kind: 'breakpoint', segmentId: 'system', ttl: '5m' },
//    { kind: 'breakpoint', segmentId: 'tools', ttl: '5m' },
//    { kind: 'breakpoint', segmentId: 'history', ttl: '5m' }]
// Apply them to your own Anthropic call: a cache_control marker on the
// last content block of each named segment. RACS never makes that call.

// After your call returns, report the usage counters it already carried:
racs.record({
  provider: 'anthropic',
  model: 'claude-sonnet-4-5',
  prefixKey: plan.prefixKey,
  inputTokens: 5200,
  cacheReadTokens: 4600,
});

const stats = racs.stats();
console.log(stats.hitRatio, stats.savedUsd, stats.netUsd);
```

`CacheUsage.inputTokens` is the all-in billed input (fresh input + cached reads + cache writes); the otel and vercel adapters normalize raw exclusive provider counts to this convention automatically.

The full engine surface is `plan`, `lint`, `record`, `stats`, `schedule`, `markRefreshed`, `drifts`, `invalidate`, `profileOf`, `on`, `flush`, and `close`, specified in [SPEC.md](./SPEC.md).

---

## Provider matrix

Every named provider is a thin profile over exactly one of four adapter families, which is how 16 providers ship without 16 code paths. All numbers document provider semantics as researched in June 2026 and are overridable per engine instance through `options.profiles`.

| Provider | Family | Mechanism |
|---|---|---|
| `anthropic` | breakpoint | Explicit `cache_control` markers, up to 4 per request, 5m and 1h TTL tiers, 1.25x and 2x write premiums, 0.1x reads |
| `bedrock` | breakpoint | `cachePoint` blocks on the Converse API, Anthropic-equivalent breakpoint semantics and multipliers |
| `hermes` | breakpoint | Hermes Agent's fixed system_and_3 layout rides `cache_control`; RACS plans superior layouts for it; 1024-token cacheable minimum as on Anthropic |
| `microsoft-foundry` | breakpoint | Claude models on Microsoft Foundry honor `cache_control` unchanged |
| `openai` | routing-key | Automatic server-side caching in 128-token increments above 1024, `prompt_cache_key` stickiness, optional 24h retention, no write counter |
| `xai` | routing-key | Automatic prefix caching, steerable via the `x-grok-conv-id` header and `prompt_cache_key` |
| `mistral` | routing-key | Automatic caching in 64-token blocks with `prompt_cache_key` routing |
| `moonshot` | routing-key | Kimi platform caching through the OpenAI-compatible surface, conservative defaults |
| `openrouter` | routing-key | Normalizes `cache_control` passthrough and `cached_tokens` reporting across upstream providers |
| `google` | resource | `cachedContent` lifecycle: create, reuse, refresh, delete, caller-set TTL, per-token-hour storage billing |
| `groq` | passive | Automatic on gpt-oss models, no control surface, entries expire after roughly 2 hours idle |
| `deepseek` | passive | Disk-based automatic context caching with hit and miss token reporting |
| `ollama` | passive | Local runtime KV reuse, no billing dimension, analytics measure latency-motivated reuse |
| `lmstudio` | passive | Local runtime KV reuse, same posture as Ollama |
| `huggingface` | passive | Inference Endpoints expose no public prefix-cache controls as of June 2026 |
| `custom` | passive (default) | Escape hatch, fully caller-defined through `options.profiles` |

Passive providers still get the full value of segment ordering, linting, and usage accounting; the ordering itself is the optimization.

---

## Lint codes

Nine codes, each a documented production cache-killer the analyzer detects from structure alone. Errors defeat caching, warnings degrade it, info advises.

| Code | What it catches | Severity |
|---|---|---|
| `volatile-early` | A volatile segment in the first half of the prompt before any breakpoint-eligible boundary; nothing after it can ever be cached | error |
| `unstable-tools` | A tools segment declared semi or volatile; almost always a serialization bug (key order, timestamps in descriptions) | error |
| `breakpoint-after-volatile` | A breakpoint would land after a volatile segment; the written span could never be read back | error |
| `timestamp-in-stable` | ISO-8601 datetimes, unix epochs, or "today"/"current time" near digits inside a stable or semi segment | warning |
| `identifier-in-stable` | UUID v4 shapes, long hex runs, or base64-like runs inside a stable segment (session ids, request ids) | warning |
| `write-premium-trap` | Declared reuse does not repay the cache write premium inside the TTL window; caching this prefix loses money | warning |
| `segment-order` | Segments are not ordered stable-first; reordering would lengthen the cacheable prefix without semantic change | warning |
| `below-minimum` | The stable prefix is shorter than the provider minimum; the provider would silently cache nothing | info |
| `missing-stability` | A contradictory or unusable stability declaration (guards untyped JavaScript callers) | info |

Run the lint pass standalone with `racs.lint(input)` or gate prompt changes in CI with `racs analyze --input prompts.json`, which exits 1 on any error-severity finding.

---

## Break-even math

Cache writes cost a premium, and RACS refuses to recommend a write that will not pay for itself. The math is stated in base-input-token equivalents because the multipliers are price-relative, so it holds with or without a pricing table.

Worked example, Anthropic 5-minute tier, 4000 stable tokens:

```text
write multiplier  1.25   (5m tier)
read multiplier   0.1

writePremiumTokens = 4000 * (1.25 - 1)  = 1000 token equivalents
savingsPerReuse    = 4000 * (1 - 0.1)   = 3600 token equivalents
minReusesToProfit  = ceil(1000 / 3600)  = 1
```

One read inside the window already repays the write. The same prefix on the 1-hour tier (2x write multiplier) costs a 4000-token premium and needs 2 reuses. When the declared `reuse` pattern cannot reach `minReusesToProfit` inside the TTL window, the plan carries a `write-premium-trap` warning, and where caching can only lose money the directive is an explicit `{ kind: 'none', reason }` instead of a trap.

For resource-family providers the same logic runs in USD against per-token-hour storage: below roughly one reuse per hour, keeping a Gemini `cachedContent` alive costs more in storage than the reads save, and RACS says so.

### Keep-warm scheduling

Breakpoint and resource caches expire on a TTL, and a touch shortly before expiry keeps them warm at read price instead of paying the write premium again. `racs.schedule()` returns every prefix whose refresh is due, scheduled at 90 percent of the TTL window after the last write, early enough to absorb timer jitter, late enough not to waste reads. The host runs the timer and the warming call, then reports it with `racs.markRefreshed(prefixKey)`.

### Caching MCP tool descriptions

An MCP server's tool list is the ideal cache prefix: tool schemas and descriptions routinely run thousands of tokens, the list is byte-stable between calls, and the agent replays it on every request. Serialize the `tools/list` response into a `'tools'` segment and let the planner place the marker:

```ts
const tools = JSON.stringify(toolListResponse.tools); // serialized MCP tools/list result
const plan = racs.plan({
  provider: 'anthropic',
  model: 'claude-sonnet-4-5',
  segments: [{ id: 'mcp-tools', role: 'tools', stability: 'stable', content: tools }],
});
```

The `'tools'` role carries the highest breakpoint placement weight, so the marker lands exactly where the provider hashes first. Keep the serialization deterministic (same key order, no timestamps in descriptions), or the `unstable-tools` lint will name the bug. The runnable version, a literal tool-list shape with no MCP SDK import, is [examples/mcp-tools-segment.ts](./examples/mcp-tools-segment.ts).

---

## Persistence

State backends persist fingerprints, schedules, the resource registry, and ledger aggregates, never prompt content. Three ship in the box: `memoryState` (default), `fileState` (Node), and `kvState`, which wraps any string key-value client in one line:

```ts
import { createRACS, kvState } from '@takk/racs';

// Any Redis client (ioredis, node-redis), one line:
const state = kvState({
  get: (k) => redis.get(k),
  set: (k, v) => redis.set(k, v),
  delete: (k) => redis.del(k),
});

// Upstash Redis:        get: (k) => upstash.get<string>(k), set: (k, v) => upstash.set(k, v), delete: (k) => upstash.del(k)
// Cloudflare KV:        get: (k) => env.RACS_KV.get(k),     set: (k, v) => env.RACS_KV.put(k, v), delete: (k) => env.RACS_KV.delete(k)

const racs = createRACS({ state });
// ... plan and record as usual ...
await racs.flush(); // snapshot saved; a new engine with the same backend restores it
```

RACS never constructs the client and never sees connection credentials; the host passes a ready object.

---

## Vercel AI SDK middleware

One middleware object plans before each call, applies directives through `providerOptions`, and records the usage the provider reports back, including streamed calls via `wrapStream`:

```ts
import { anthropic } from '@ai-sdk/anthropic';
import { wrapLanguageModel } from 'ai';
import { createRACS } from '@takk/racs';
import { racsMiddleware } from '@takk/racs/vercel';

const racs = createRACS();
const model = wrapLanguageModel({
  model: anthropic('claude-sonnet-4-5'),
  middleware: racsMiddleware(racs, { provider: 'anthropic', model: 'claude-sonnet-4-5' }),
});

// Use `model` with generateText or streamText as usual, then:
const { hitRatio, savedUsd } = racs.stats();
```

The middleware is structural: it matches the `LanguageModelV3Middleware` contract without importing the `ai` package, so the zero-dependency invariant survives. A custom `segmenter` lets the host declare its own prompt anatomy when the default segmentation is not enough.

---

## OpenTelemetry ingestion

If your stack already emits GenAI spans, RACS ingests them directly. `usageFromSpan` reads token counters and identity only, never `gen_ai.prompt`, `gen_ai.completion`, or any content attribute:

```ts
import { createRACS } from '@takk/racs';
import { usageFromSpan, type GenAISpanLike } from '@takk/racs/otel';

const racs = createRACS();

// Inside a span processor's onEnd, an OTLP collector hook, or wherever
// finished spans surface in your host:
function onSpanEnd(span: GenAISpanLike): void {
  const usage = usageFromSpan(span, { provider: 'anthropic' });
  if (usage !== undefined) racs.record(usage);
}
```

It tolerates every attribute spelling in circulation (Anthropic-flavored, OpenLLMetry lineage, and the newer semantic-convention draft) and works with the spans Vercel AI SDK telemetry emits under `experimental_telemetry`.

---

## CLI and the serve bridge

The `racs` binary ships five commands: `help`, `version`, `analyze` (the CI lint gate), `simulate` (the deterministic demonstration above), `inspect` (print a saved snapshot, `--watch` for a live redraw), and `serve`.

`racs serve` wraps one engine in a hardened local HTTP bridge so non-JavaScript hosts can plan, lint, record, and read statistics. Endpoints: `POST /plan`, `POST /lint`, `POST /usage`, `GET /stats`, `GET /schedule`, `POST /refreshed`, `POST /invalidate`, and a `GET /healthz` that never requires the bearer. It binds loopback by default, refuses non-loopback hosts without a bearer token, rejects non-loopback Host headers in tokenless mode with 403 (the DNS-rebinding defense, `/healthz` included for consistency), compares tokens in constant time, and gates bodies with 415 and 413 responses.

```bash
racs serve --port 4378 --token "$RACS_TOKEN" --state .racs/state.json

curl -s -X POST http://127.0.0.1:4378/plan \
  -H "authorization: Bearer $RACS_TOKEN" \
  -H "content-type: application/json" \
  -d '{
    "provider": "anthropic",
    "model": "claude-sonnet-4-5",
    "segments": [
      { "id": "system", "role": "system", "stability": "stable", "contentHash": "sys-v1", "tokens": 3000 },
      { "id": "turn", "role": "dynamic", "stability": "volatile", "contentHash": "turn-1", "tokens": 200 }
    ],
    "reuse": { "intervalSeconds": 60 }
  }'
```

Hermes Agent note: a Hermes deployment can call `/plan` before each provider call and `/usage` after it, getting planned breakpoint layouts, drift detection, and savings analytics without touching its own transport. The full recipe, including the shell hook and the honest limits of an out-of-process bridge, is in [examples/hermes-bridge.md](./examples/hermes-bridge.md).

---

## Package surface

| Entry | What it is | Brotli size |
|---|---|---|
| `@takk/racs` | The engine, profiles, state backends, hashing | 10.72 kB ESM / 10.86 kB CJS |
| `@takk/racs/otel` | GenAI span ingestion | 604 B |
| `@takk/racs/vercel` | Vercel AI SDK middleware | 1.15 kB |
| `@takk/racs/integrations` | The four family bridges | 666 B |
| `@takk/racs/web` | Browser surface, no Node imports | 10.23 kB |
| `@takk/racs/edge` | Edge-runtime surface, no Node imports | 10.23 kB |

Zero runtime dependencies on every entry. The published tarball carries 46 files.

---

## The family stack

RACS is one layer of a five-package stack for production agents, each independent, each one line to bridge:

- Route models with [@takk/modelchain](https://www.npmjs.com/package/@takk/modelchain): `modelchainBridge` plans a cache per routed model, because provider caches are per-model.
- Rotate credentials with [@takk/keymesh](https://www.npmjs.com/package/@takk/keymesh): `keymeshBridge` invalidates provider-scoped cache state on `key.rotated` and `circuit.open`, since cached resources may be scoped to the credential that created them.
- Observe behavior with [@takk/behavioralai](https://www.npmjs.com/package/@takk/behavioralai): `behavioralaiBridge` turns the cache itself into a behaviorally observed agent, so a hit-ratio collapse surfaces as behavioral drift.
- Tune parameters with [@takk/noeticos](https://www.npmjs.com/package/@takk/noeticos): `noeticosBridge` freezes parameter tuning when a prefix drifts (the reward landscape moved) and releases after 3 stable plans.
- Cache context with RACS.

All four bridges live in `@takk/racs/integrations`, are structural (no sibling package is imported at runtime), and the siblings stay optional peers.

---

## FAQ

**Does RACS ever make a network call?**
No, never. RACS plans directives and normalizes usage reports; the host makes every provider call with its own credentials and transport. This is the product invariant, and it is why the package has zero runtime dependencies, never sees an API key, and runs identically in Node, browsers, and edge runtimes.

**Where do prices come from?**
You supply them, per model, in `options.pricing`. RACS never hardcodes prices because providers change terms without notice, and a stale hardcoded number is worse than none. Without a pricing table you still get every token-denominated statistic, just no USD figures.

**What happens below provider minimums?**
Providers silently cache nothing below their minimum prefix length (1024 tokens on most Anthropic and OpenAI models as of June 2026), with no error and no signal. RACS fires the `below-minimum` lint before that happens and emits an explicit `none` directive with the reason instead of a marker that would buy nothing.

**Why did my plan say `none` when my prompt is cacheable?**
Probably the write-premium trap. If your declared reuse can never repay the write premium, neither inside the refresh-extended TTL window (reads refresh breakpoint-family TTLs at no cost, so any reuse interval that fits the window keeps the cache alive indefinitely) nor through keep-warm touches, caching loses money and RACS refuses: it emits an explicit `none` plus the `write-premium-trap` finding. The `breakEven` field on the plan shows the exact derivation; raise reuse density, choose a longer TTL tier, or accept the no-op.

**What is the difference between drift and volatile churn?**
Volatile segments are declared to differ on every call, so their churn is expected behavior and never drift. Drift is when a segment you declared stable or semi quietly changes, which invalidates the entire left-anchored prefix behind it. RACS fingerprints stable and semi segments per agent lineage, names exactly which segments changed, and quantifies the invalidated tokens.

**Can I use RACS without ever showing it my prompts?**
Yes, hash-only mode. Pass `contentHash` (any stable digest you compute) plus `tokens` instead of `content`, and RACS never sees or stores the text. Plans, drift reports, persisted snapshots, and telemetry then carry hashes and counts only. Content-shape lints such as `timestamp-in-stable` are skipped for those segments by design, there is nothing to scan.

**How does RACS behave across multiple replicas?**
Each engine learns per process: fingerprints, schedules, and aggregates live in one engine instance. A shared KV backend shares state across restarts and replicas, but it is persistence, not coordination, the snapshot is last-writer-wins. For exact multi-replica aggregation, run one engine behind `racs serve` as a sidecar, or aggregate usage centrally before recording.

**How is this different from response-caching gateways like LiteLLM or Helicone?**
Those products sit on the wire and translate requests or cache whole responses. RACS does neither: it plans the structure of your prompt so the provider's own prefix cache hits, and accounts for what the provider reports. The two are complementary; a gateway cannot fix a timestamp in your system prompt, and RACS will not serve you a cached response.

**OpenAI reports no cache write counter. How do analytics work there?**
The routing-key family has no write premium and no write counter, so the ledger accounts reads against total input tokens (`cached_tokens` over `prompt_tokens`), which is exactly the normalized hit ratio. Write-tier fields stay empty for those providers, and the break-even question never arises because writes are free.

**Does it work on edge runtimes and in the browser?**
Yes. `@takk/racs/web` and `@takk/racs/edge` export the full surface minus the Node-only file state backend. Nothing in the engine touches sockets, the filesystem, or platform globals; persist through `kvState` over Cloudflare KV or Upstash.

---

## Author

RACS is built and maintained by David C Cavalcante, Takk Innovate Studio, who researches Massive Intelligence (IM) and non-human entities at [takk.ag](https://takk.ag).

- Email: [davcavalcante@proton.me](mailto:davcavalcante@proton.me)
- GitHub: [github.com/davccavalcante](https://github.com/davccavalcante)
- Project site: [https://racs.takk.ag/](https://racs.takk.ag/)

## Sponsors

If RACS saves your agent fleet real money, consider sponsoring continued maintenance through the channels in [.github/FUNDING.yml](./.github/FUNDING.yml). Sponsorship never buys roadmap priority; it buys maintenance time.

## License

[Apache-2.0](./LICENSE). Copyright 2026 David C Cavalcante, Takk Innovate Studio. See [NOTICE](./NOTICE).
