/**
 * The single type contract of RACS (Remote Agent Context Store), provider-faithful
 * prefix-cache management for Massive Intelligence (IM) agent workloads.
 *
 * Product invariant, the one rule everything else follows from:
 *
 * RACS never talks to any provider network API. It plans cache directives, normalizes the
 * usage reports the host application already receives from its own provider calls, and
 * accounts for every cached token. The host application stays in full control of its own
 * API calls, credentials, retries, and transport.
 *
 * Why this invariant exists:
 * - Zero runtime dependencies. No provider SDK ever enters the dependency graph, so the
 *   package stays auditable and immune to upstream SDK churn.
 * - Zero credentials. RACS never sees an API key, so it can never leak one, and security
 *   review of the package is a pure-logic review.
 * - Works everywhere. Browsers, edge runtimes, workers, and Node all run the same code,
 *   because nothing here touches sockets, the filesystem (outside the optional file state
 *   backend), or platform-specific globals.
 *
 * Determinism contract: RACS never calls the global random generator. Identifiers derive
 * from a seeded generator ({@link RACSOptions.seed}), and the platform wall clock is read
 * only where a timestamp is part of the public record, always injectable through
 * {@link RACSOptions.clock} for tests.
 *
 * @packageDocumentation
 */

/**
 * Semantic role of a prompt segment inside the assembled request.
 *
 * Roles let the planner reason about conventional prompt anatomy without parsing content:
 * - `'system'`: system instructions, persona, policies. Usually the most stable text.
 * - `'tools'`: tool and function definitions. Should be byte-stable between calls, see
 *   the `'unstable-tools'` lint.
 * - `'documents'`: retrieved or attached reference material, knowledge bases, file dumps.
 * - `'history'`: prior conversation turns. Grows monotonically in well-behaved agents.
 * - `'dynamic'`: the live tail, the current user turn, scratch state, anything expected to
 *   differ on every call.
 *
 * The union is minor-extensible: new roles may appear in minor versions, consumers must
 * tolerate unknown members.
 */
export type SegmentRole = 'system' | 'tools' | 'documents' | 'history' | 'dynamic';

/**
 * Declared change frequency of a segment, the planner's primary input.
 *
 * - `'stable'`: byte-identical across calls for the lifetime of the agent or deployment.
 * - `'semi'`: changes occasionally, for example a document set refreshed hourly. May still
 *   be worth caching when expected reuse is dense enough.
 * - `'volatile'`: expected to differ on every call. Anything cached after a volatile
 *   segment can never be reused, see the `'breakpoint-after-volatile'` lint.
 *
 * Stability is declared by the caller, not inferred from content, because only the host
 * knows its own update cadence. RACS lints for declarations that look wrong.
 */
export type Stability = 'stable' | 'semi' | 'volatile';

/**
 * One contiguous span of the prompt, the planning unit of RACS.
 *
 * Content contract: provide `content` OR `contentHash`, at least one of the two.
 * - When only `content` is given, the engine hashes it itself to derive the deterministic
 *   prefix key, and estimates `tokens` at roughly 4 characters per token, the standard
 *   English-text approximation. Estimates are good enough for break-even math, pass real
 *   `tokens` from a tokenizer when precision matters.
 * - When only `contentHash` is given (hash-only mode), RACS never sees and never stores the
 *   text. This is the privacy mode: plans, drift reports, persisted snapshots, and telemetry
 *   carry hashes and token counts only, never prompt content. Provide `tokens` alongside,
 *   otherwise the segment counts as zero tokens in break-even math.
 * - When both are given, `contentHash` wins for keying and `content` is used only for
 *   content-shape lints such as `'timestamp-in-stable'`.
 */
export interface PromptSegment {
  /**
   * Caller-chosen identifier, unique within one {@link PlanInput}. Referenced by
   * directives, lint findings, and drift reports, so keep it stable across calls for the
   * same logical segment ("system-prompt", "tool-defs", "kb-v3").
   */
  readonly id: string;
  /** Semantic role of this span, see {@link SegmentRole}. */
  readonly role: SegmentRole;
  /** Declared change frequency, see {@link Stability}. */
  readonly stability: Stability;
  /**
   * The literal text of the segment. Optional, see the content contract on
   * {@link PromptSegment}. Never persisted, never emitted in telemetry.
   */
  readonly content?: string;
  /**
   * Caller-computed digest of the segment text, any stable scheme the caller likes
   * (sha-256 hex is conventional). Presence of this field without `content` activates
   * hash-only privacy mode for the segment.
   */
  readonly contentHash?: string;
  /**
   * Exact token count from the provider tokenizer when the caller has one. Overrides the
   * 4-characters-per-token estimate derived from `content`.
   */
  readonly tokens?: number;
}

/**
 * How often the caller expects to replay this prefix, the demand side of break-even math
 * and the input to TTL selection and refresh scheduling.
 *
 * Both fields describe the same thing from two angles, provide whichever is natural.
 * When both are present `intervalSeconds` wins, it is the more precise statement.
 */
export interface ExpectedReuse {
  /** Expected seconds between consecutive calls sharing this prefix. */
  readonly intervalSeconds?: number;
  /** Expected number of calls per hour sharing this prefix. */
  readonly callsPerHour?: number;
}

/**
 * Everything the planner needs to produce a {@link CachePlan}. Pure data, no callbacks,
 * trivially serializable, so plans can be computed anywhere and shipped anywhere.
 */
export interface PlanInput {
  /**
   * Optional logical agent identity. Segments from different agents never share prefix
   * keys even when content collides, and drift is tracked per agent lineage.
   */
  readonly agentId?: string;
  /** Target provider, selects the adapter family and profile. */
  readonly provider: ProviderId;
  /** Provider model identifier, verbatim, for example 'claude-sonnet-4-5'. */
  readonly model: string;
  /**
   * Prompt segments in request order, first element is the start of the prompt. Order is
   * meaningful: prefix caches are strictly left-anchored on every provider family.
   */
  readonly segments: readonly PromptSegment[];
  /** Expected reuse pattern, drives TTL choice, break-even math, and refresh scheduling. */
  readonly reuse?: ExpectedReuse;
}

/**
 * The four cache-control mechanisms that exist across the provider landscape. Every named
 * provider is a thin profile over exactly one family, which is why RACS supports 15+
 * providers without 15 code paths.
 *
 * - `'breakpoint'`: the caller marks explicit cache boundaries inside the request body and
 *   pays a write premium per marked span (Anthropic `cache_control`, Amazon Bedrock
 *   `cachePoint`). Plans emit `'breakpoint'` directives.
 * - `'routing-key'`: the provider caches implicitly server-side and the caller can only
 *   steer request routing with a key so that identical prefixes land on the same cache
 *   (OpenAI `prompt_cache_key`). Plans emit `'routing-key'` directives.
 * - `'resource'`: the cache is a first-class server resource with its own lifecycle,
 *   created, refreshed, and deleted by the host, often with per-token-hour storage billing
 *   (Google Gemini `cachedContents`). Plans emit `'resource'` directives.
 * - `'passive'`: the provider caches automatically and exposes no control surface at all
 *   (DeepSeek, Groq, local runtimes). RACS still plans segment ordering, lints, and
 *   accounts usage, the ordering itself is the optimization.
 */
export type AdapterFamily = 'breakpoint' | 'routing-key' | 'resource' | 'passive';

/**
 * Named provider profiles shipped with RACS, each a thin parameterization of one
 * {@link AdapterFamily}.
 *
 * This union is minor-extensible: new providers may be added in minor versions, consumers
 * must tolerate unknown members and should treat the type as open when switching on it.
 * The TeleologHI provider arrives in 2.0.0.
 *
 * `'custom'` is the escape hatch: pair it with {@link RACSOptions.profiles} to describe
 * any provider RACS does not name yet.
 */
export type ProviderId =
  | 'anthropic'
  | 'openai'
  | 'google'
  | 'bedrock'
  | 'xai'
  | 'groq'
  | 'deepseek'
  | 'mistral'
  | 'openrouter'
  | 'moonshot'
  | 'ollama'
  | 'lmstudio'
  | 'huggingface'
  | 'microsoft-foundry'
  | 'hermes'
  | 'custom';

/**
 * Cache time-to-live tiers offered by breakpoint-family providers. Resource-family TTLs
 * are arbitrary second counts and are expressed as numbers where they occur
 * ({@link RefreshEntry.ttl}, the `'resource'` directive).
 *
 * As of June 2026 the two-tier 5-minute and 1-hour model is the breakpoint-family
 * standard, sources cited in the profiles module.
 *
 * The union is minor-extensible: new TTL tiers may be added in minor versions, and
 * consumers must tolerate unknown members, exactly as with {@link ProviderId}.
 */
export type CacheTtl = '5m' | '1h';

/**
 * Cache semantics of one provider, the numbers the planner reasons with.
 *
 * Every numeric field documents provider semantics as researched in June 2026, with
 * sources cited in JSDoc inside the profiles module where the shipped values live. All of
 * them are overridable per engine instance through {@link RACSOptions.profiles}, because
 * providers change terms faster than packages release.
 */
export interface ProviderProfile {
  /** The provider this profile describes. */
  readonly id: ProviderId;
  /** Which of the four mechanisms this provider implements, see {@link AdapterFamily}. */
  readonly family: AdapterFamily;
  /**
   * Smallest prefix, in tokens, the provider will cache at all. Shorter prefixes are
   * silently uncached by the provider, the `'below-minimum'` lint fires before that
   * happens. Example as of June 2026: 1024 tokens on most Anthropic and OpenAI models.
   */
  readonly minCacheableTokens?: number;
  /**
   * Maximum number of cache breakpoints one request may carry, breakpoint family only.
   * Example as of June 2026: 4 `cache_control` blocks per Anthropic request.
   */
  readonly maxBreakpoints?: number;
  /** TTL tiers this provider offers, breakpoint family only. */
  readonly ttls?: readonly CacheTtl[];
  /**
   * Price multiplier for writing a 5-minute-TTL cache span, relative to base input price.
   * Example as of June 2026: 1.25 on Anthropic, meaning a 25 percent write premium.
   */
  readonly writeMultiplier5m?: number;
  /**
   * Price multiplier for writing a 1-hour-TTL cache span, relative to base input price.
   * Example as of June 2026: 2.0 on Anthropic.
   */
  readonly writeMultiplier1h?: number;
  /**
   * Price multiplier for reading cached tokens, relative to base input price. Example as
   * of June 2026: 0.1 on Anthropic, meaning cached reads cost a tenth of fresh input.
   */
  readonly readMultiplier?: number;
  /**
   * Whether the provider offers extended cache retention behind its routing key, for
   * example the 24-hour retention tier OpenAI attaches to `prompt_cache_key` as of
   * June 2026. Routing-key family only.
   */
  readonly supportsRetention?: boolean;
  /**
   * Storage price in USD per million tokens per hour for keeping a resource-family cache
   * alive (Google Gemini `cachedContents` billing model as of June 2026). Resource family
   * only, feeds the net-cost side of break-even math.
   */
  readonly storagePerMTokHour?: number;
  /** Free-form caveats that do not fit a number, surfaced verbatim in plan reasoning. */
  readonly notes?: string;
}

/**
 * One provider-faithful instruction the host applies to its own API call. Discriminated on
 * `kind`, exactly one kind per adapter family plus the explicit `'none'`.
 *
 * RACS emits directives, the host executes them. This is the product invariant in type
 * form: nothing here is a network call, everything here is a description of one.
 *
 * Minor-extensible literals, same rule as {@link ProviderId}: the routing-key
 * `retention` literal (`'24h'`) and the resource `action` union
 * (`'create' | 'reuse' | 'refresh' | 'delete'`) may gain new members in minor versions,
 * and consumers must tolerate unknown members when switching on them.
 */
export type CacheDirective =
  | {
      /**
       * Breakpoint family: place a cache marker (Anthropic `cache_control`, Bedrock
       * `cachePoint`) at the end of the named segment, with the chosen TTL tier.
       */
      readonly kind: 'breakpoint';
      /** Segment after which the marker goes, references {@link PromptSegment.id}. */
      readonly segmentId: string;
      /** TTL tier to request for the span ending here. */
      readonly ttl: CacheTtl;
    }
  | {
      /**
       * Routing-key family: send this key with the request (OpenAI `prompt_cache_key`) so
       * identical prefixes route to the same server-side cache.
       */
      readonly kind: 'routing-key';
      /** Deterministic key derived from the stable prefix, send verbatim. */
      readonly key: string;
      /** Request the extended retention tier when the profile supports it. */
      readonly retention?: '24h';
    }
  | {
      /**
       * Resource family: perform one lifecycle action on a server-side cache resource
       * (Google Gemini `cachedContents`). The host owns the actual API call and should
       * report the outcome back through usage recording.
       */
      readonly kind: 'resource';
      /** Lifecycle step: create a new resource, reuse, refresh its TTL, or delete it. */
      readonly action: 'create' | 'reuse' | 'refresh' | 'delete';
      /** RACS-side identity of the resource, stable across plans for the same prefix. */
      readonly resourceKey: string;
      /** TTL in seconds to set on the resource, resource families take arbitrary values. */
      readonly ttlSeconds: number;
    }
  | {
      /**
       * Nothing to do, with the reason stated. Emitted for passive-family providers, for
       * prefixes below the cacheable minimum, and for plans where caching loses money.
       */
      readonly kind: 'none';
      /** Human-readable explanation of why no directive applies. */
      readonly reason: string;
    };

/**
 * Machine-readable lint codes, each a cache-efficiency hazard the planner can detect from
 * structure alone. Minor-extensible: new codes may be added in minor versions, consumers
 * must tolerate unknown members.
 *
 * - `'volatile-early'`: a volatile segment sits before stable or semi segments, every
 *   token after it is unreachable for the cache.
 * - `'below-minimum'`: the stable prefix is shorter than the provider's minimum cacheable
 *   token count, the provider would silently cache nothing.
 * - `'unstable-tools'`: a `'tools'` segment is declared semi or volatile. Tool definitions
 *   are usually generated and should be byte-stable, instability here is almost always a
 *   serialization bug (key order, timestamps in descriptions).
 * - `'timestamp-in-stable'`: a stable segment's content appears to embed a timestamp or
 *   date, which silently changes the prefix on every call and defeats the cache.
 * - `'identifier-in-stable'`: a stable segment's content appears to embed a per-request
 *   identifier (UUID, request id, session id), same failure mode as a timestamp.
 * - `'breakpoint-after-volatile'`: a breakpoint would land after a volatile segment, the
 *   written span could never be read back.
 * - `'write-premium-trap'`: given the declared {@link ExpectedReuse}, the cache write
 *   premium exceeds the plausible read savings, caching this prefix loses money.
 * - `'segment-order'`: segments are not ordered stable-first, reordering would lengthen
 *   the cacheable prefix without changing semantics the planner can see.
 * - `'missing-stability'`: a segment arrived without a usable stability declaration.
 *   Unreachable through this type system, guards untyped JavaScript callers at runtime.
 */
export type LintCode =
  | 'volatile-early'
  | 'below-minimum'
  | 'unstable-tools'
  | 'timestamp-in-stable'
  | 'identifier-in-stable'
  | 'breakpoint-after-volatile'
  | 'write-premium-trap'
  | 'segment-order'
  | 'missing-stability';

/**
 * One lint result. Errors mean the plan as declared cannot achieve cache hits, warnings
 * mean money or hit ratio is probably being left on the table, info is advisory.
 */
export interface LintFinding {
  /** How bad it is: 'error' defeats caching, 'warning' degrades it, 'info' advises. */
  readonly severity: 'error' | 'warning' | 'info';
  /** Machine-readable code, see {@link LintCode} for the catalog. */
  readonly code: LintCode;
  /** Offending segment when the finding is local to one, references {@link PromptSegment.id}. */
  readonly segmentId?: string;
  /** Human-readable explanation with the concrete fix, English prose for logs. */
  readonly message: string;
}

/**
 * Economics of caching this prefix: what the write premium costs and how many reuses pay
 * it back. Computed from the provider profile multipliers, and stated in tokens so it
 * works even when no {@link PricingTable} was supplied.
 */
export interface BreakEven {
  /**
   * Extra tokens the write premium effectively costs, the multiplier surcharge expressed
   * in base-input-token equivalents.
   */
  readonly writePremiumTokens: number;
  /** Number of cache reads after the write at which cumulative savings turn positive. */
  readonly minReusesToProfit: number;
  /** Whether the declared {@link ExpectedReuse} reaches that reuse count inside the TTL. */
  readonly profitable: boolean;
  /** Human-readable derivation of the numbers above, suitable for logs and reviews. */
  readonly reasoning: string;
}

/**
 * The planner's complete answer for one {@link PlanInput}: directives to apply, lints to
 * heed, economics, and a deterministic identity.
 *
 * Determinism: the same input, options, and seed always produce the same `planId` and
 * `prefixKey`. Plans are pure data and safe to persist, diff, and replay.
 */
export interface CachePlan {
  /** Deterministic plan identity, derived from the seeded generator, never random. */
  readonly planId: string;
  /** Provider this plan targets, echoed from the input. */
  readonly provider: ProviderId;
  /** Model this plan targets, echoed from the input. */
  readonly model: string;
  /** Adapter family the directives belong to, resolved from the provider profile. */
  readonly family: AdapterFamily;
  /**
   * Deterministic cache key of the stable prefix, derived from segment hashes, provider,
   * model, and agent identity. Equal keys mean byte-equal cacheable prefixes. This is the
   * join key across plans, usage, stats, drift, and refresh scheduling.
   */
  readonly prefixKey: string;
  /** Token count of the cacheable stable prefix, exact or estimated per segment rules. */
  readonly stableTokens: number;
  /** Token count of the whole prompt, same exact-or-estimated provenance. */
  readonly totalTokens: number;
  /** Provider-faithful instructions for the host to apply, in application order. */
  readonly directives: readonly CacheDirective[];
  /** Lint findings for this input, also available standalone via {@link RACS.lint}. */
  readonly findings: readonly LintFinding[];
  /** Cache economics, present when the profile carries the multipliers to compute it. */
  readonly breakEven?: BreakEven;
  /** Human-readable narrative of why the planner chose these directives. */
  readonly reasoning: string;
}

/**
 * Normalized usage report for one provider call, the input to hit-ratio analytics.
 *
 * The host extracts these counts from the provider response it already has (for example
 * Anthropic `usage.cache_read_input_tokens`, OpenAI `usage.prompt_tokens_details.cached_tokens`)
 * and reports them here. RACS normalizes the babel of provider usage shapes into this one
 * record, it never fetches usage itself.
 */
export interface CacheUsage {
  /** Provider that served the call. */
  readonly provider: ProviderId;
  /** Model that served the call, must match a {@link PricingTable} key for USD figures. */
  readonly model: string;
  /**
   * Prefix key of the plan this call executed, links the usage to plan-level stats and
   * drift tracking. Omit for calls made outside any RACS plan, they still aggregate into
   * ledger totals.
   */
  readonly prefixKey?: string;
  /**
   * Total input tokens billed for the call, ALL-IN: uncached fresh input plus cached
   * reads plus cache writes of both TTL tiers. Hit-ratio math derives the uncached
   * remainder as `inputTokens - cacheReadTokens - cacheWriteTokens5m - cacheWriteTokens1h`,
   * so a source reporting EXCLUSIVE counts (raw Anthropic usage, whose `input_tokens`
   * excludes cache reads and cache writes) must be normalized to the all-in total before
   * recording. The shipped otel and vercel adapters perform that normalization; hosts
   * recording by hand must sum the exclusive counts themselves.
   */
  readonly inputTokens: number;
  /** Input tokens served from cache at the discounted read rate. */
  readonly cacheReadTokens: number;
  /** Tokens written to a 5-minute-TTL cache on this call, breakpoint family. */
  readonly cacheWriteTokens5m?: number;
  /** Tokens written to a 1-hour-TTL cache on this call, breakpoint family. */
  readonly cacheWriteTokens1h?: number;
  /**
   * Milliseconds since the Unix epoch when the call happened. Defaults to the injected
   * clock at recording time, pass it explicitly when replaying historical usage.
   */
  readonly timestamp?: number;
}

/**
 * Per-model price card in USD per million tokens. Always user-supplied, see
 * {@link PricingTable}.
 */
export interface Pricing {
  /** Base input price, USD per million tokens. */
  readonly inputPerMTok: number;
  /** Discounted cache read price, USD per million tokens. */
  readonly cacheReadPerMTok?: number;
  /** 5-minute-TTL cache write price, USD per million tokens. */
  readonly cacheWrite5mPerMTok?: number;
  /** 1-hour-TTL cache write price, USD per million tokens. */
  readonly cacheWrite1hPerMTok?: number;
  /** Output price, USD per million tokens, used only for completeness in reports. */
  readonly outputPerMTok?: number;
  /** Resource-family storage price, USD per million tokens per hour. */
  readonly storagePerMTokHour?: number;
}

/**
 * Prices keyed by model id, matched against {@link CacheUsage.model}.
 *
 * ALWAYS user-supplied: the engine never hardcodes prices, because prices change without
 * notice and a stale hardcoded number is worse than none. USD figures such as
 * {@link PrefixStats.savedUsd} are reported only when the table covers the model in
 * question, token-denominated statistics are always reported regardless.
 */
export type PricingTable = Readonly<Record<string, Pricing>>;

/**
 * Aggregated cache performance of one prefix across every recorded call.
 */
export interface PrefixStats {
  /** The prefix these numbers describe, see {@link CachePlan.prefixKey}. */
  readonly prefixKey: string;
  /** Number of usage records aggregated. */
  readonly calls: number;
  /**
   * Normalized hit ratio in [0, 1]: cache read tokens divided by total input tokens,
   * the same formula across all providers so numbers are comparable between them.
   */
  readonly hitRatio: number;
  /** Total tokens served from cache. */
  readonly readTokens: number;
  /** Total tokens written to cache, both TTL tiers combined. */
  readonly writeTokens: number;
  /** Total input tokens that were neither read from nor written to cache. */
  readonly uncachedTokens: number;
  /**
   * USD saved by cache reads versus paying base input price, present only when the
   * {@link PricingTable} covers the model.
   */
  readonly savedUsd?: number;
  /** USD spent on write premiums, present only when pricing covers the model. */
  readonly writeSpendUsd?: number;
}

/**
 * Ledger-wide aggregate over every recorded usage, plus the per-prefix breakdown.
 * Returned by {@link RACS.stats}.
 */
export interface LedgerStats {
  /** Total usage records aggregated under the active filter. */
  readonly calls: number;
  /** Normalized hit ratio in [0, 1], same formula as {@link PrefixStats.hitRatio}. */
  readonly hitRatio: number;
  /** Total tokens served from cache. */
  readonly readTokens: number;
  /** Total tokens written to cache. */
  readonly writeTokens: number;
  /** Total input tokens untouched by any cache. */
  readonly uncachedTokens: number;
  /** USD saved by cache reads, present only when pricing covers the models involved. */
  readonly savedUsd?: number;
  /**
   * Net USD effect of caching, savings minus write premiums and storage, present only
   * when pricing covers the models involved. Negative means caching lost money.
   */
  readonly netUsd?: number;
  /** Per-prefix breakdown, sorted by the engine for stable output. */
  readonly prefixes: readonly PrefixStats[];
}

/**
 * Record of one detected prefix drift: the same agent and model lineage produced a
 * different prefix key than last time, so previously cached tokens are dead.
 *
 * Drift is the silent cache killer, a one-byte change in a "stable" segment invalidates
 * the entire left-anchored prefix from that byte onward. RACS detects it by comparing
 * fingerprints across plans, names the segments that changed, and quantifies the loss.
 */
export interface DriftReport {
  /**
   * Logical agent the drifting lineage belongs to, present when the plans carried
   * {@link PlanInput.agentId}. Lets downstream consumers, for example parameter-tuning
   * runtimes, map the drift back to the agent whose reward landscape just moved.
   */
  readonly agentId?: string;
  /** The new prefix key produced by the latest plan. */
  readonly prefixKey: string;
  /** The prefix key the same lineage produced previously. */
  readonly previousKey: string;
  /** Ids of the segments whose hashes changed between the two plans. */
  readonly changedSegmentIds: readonly string[];
  /** Stable-prefix tokens whose cached copies the drift invalidated. */
  readonly invalidatedTokens: number;
  /** Milliseconds since the Unix epoch when the drift was detected, from the clock. */
  readonly timestamp: number;
}

/**
 * One entry in the keep-warm schedule, the heartbeat pattern as a library primitive.
 *
 * Provider caches expire on a TTL, and a read or refresh shortly before expiry keeps the
 * cache warm for another window at read price instead of paying the write premium again.
 * `refreshAt` is set at 90 percent of the TTL window after the last write, early enough to
 * absorb scheduling jitter, late enough not to waste reads. The host runs the timer and
 * the call, RACS only computes when, see the product invariant.
 */
export interface RefreshEntry {
  /** Prefix this entry keeps warm, see {@link CachePlan.prefixKey}. */
  readonly prefixKey: string;
  /** Provider the cached prefix lives on. */
  readonly provider: ProviderId;
  /** Model the cached prefix belongs to. */
  readonly model: string;
  /**
   * TTL the cache was written with: a {@link CacheTtl} tier for breakpoint and
   * routing-key families, a plain number of seconds for resource-family entries, which
   * carry the `ttlSeconds` of their directive.
   */
  readonly ttl: CacheTtl | number;
  /** Milliseconds since the Unix epoch of the last cache write or refresh. */
  readonly lastWriteAt: number;
  /** Milliseconds since the Unix epoch when the keep-warm touch is due, 90 percent of TTL. */
  readonly refreshAt: number;
}

/**
 * Everything observable about a running engine, discriminated on `type`. Listeners are
 * synchronous and must not throw, see {@link TelemetryListener}. All timestamps come from
 * the injected clock, so telemetry is deterministic under test.
 *
 * - `'plan.created'`: a plan was produced by {@link RACS.plan}.
 * - `'prefix.drifted'`: a drift was detected, the report carries its own timestamp.
 * - `'usage.recorded'`: a usage record was ingested, `hit` is true when the call read at
 *   least one cached token.
 * - `'refresh.due'`: a keep-warm entry crossed its `refreshAt` during {@link RACS.schedule}.
 * - `'resource.action'`: a resource-family lifecycle directive was emitted, mirror this
 *   into the host's own resource bookkeeping.
 * - `'limit.reached'`: a bounded internal store hit its cap and evicted or dropped data,
 *   `scope` names the store, `detail` says what was sacrificed.
 */
export type TelemetryEvent =
  | { readonly type: 'plan.created'; readonly plan: CachePlan; readonly timestamp: number }
  | { readonly type: 'prefix.drifted'; readonly report: DriftReport }
  | {
      readonly type: 'usage.recorded';
      readonly usage: CacheUsage;
      readonly hit: boolean;
      readonly timestamp: number;
    }
  | { readonly type: 'refresh.due'; readonly entry: RefreshEntry; readonly timestamp: number }
  | {
      readonly type: 'resource.action';
      readonly directive: Extract<CacheDirective, { kind: 'resource' }>;
      readonly timestamp: number;
    }
  | {
      readonly type: 'limit.reached';
      readonly scope: 'prefixes' | 'ledger';
      readonly detail: string;
      readonly timestamp: number;
    };

/**
 * Receives every {@link TelemetryEvent} synchronously, in emission order. Keep it fast and
 * non-throwing, the engine calls it inline on its own hot path. Subscribe via
 * {@link RACS.on}, which returns the matching unsubscribe function.
 */
export type TelemetryListener = (event: TelemetryEvent) => void;

/**
 * Minimal structural contract for any string key-value store. Deliberately tiny so that
 * any Redis, Upstash, or Cloudflare KV client wraps into it in one line, for example
 * `{ get: (k) => redis.get(k), set: (k, v) => redis.set(k, v), delete: (k) => redis.del(k) }`.
 *
 * RACS never constructs a client and never sees connection credentials, the host passes a
 * ready object. Returning `null` or `undefined` from `get` both mean "absent".
 */
export interface KvLike {
  /** Reads a value, `undefined` or `null` when the key is absent. */
  get(key: string): Promise<string | undefined | null>;
  /** Writes a value, the return value is ignored. */
  set(key: string, value: string): Promise<unknown>;
  /** Deletes a key, the return value is ignored. */
  delete(key: string): Promise<unknown>;
}

/**
 * Serialized engine state: aggregate fingerprints, the resource registry, and ledger
 * aggregates. Never prompt content, the snapshot holds hashes and numbers only, so
 * persisting it leaks nothing even when the backing store is shared.
 */
export interface StateSnapshot {
  /** Snapshot schema version, currently the literal 1, bumped on breaking layout change. */
  readonly version: 1;
  /** Milliseconds since the Unix epoch when the snapshot was taken, from the clock. */
  readonly savedAt: number;
  /** Opaque engine state, treat as a black box, round-trip it unmodified. */
  readonly data: Readonly<Record<string, unknown>>;
}

/**
 * Where snapshots go. Implementations decide the medium: in-memory for tests, a file via
 * the file backend, any {@link KvLike} via the KV backend. The engine calls `save` on
 * {@link RACS.flush} and {@link RACS.close}, and `load` once on startup.
 */
export interface StateBackend {
  /** Returns the last saved snapshot, or `undefined` when none exists yet. */
  load(): Promise<StateSnapshot | undefined>;
  /** Persists the snapshot, replacing any previous one. */
  save(snapshot: StateSnapshot): Promise<void>;
}

/**
 * Construction options for the engine. Every field is optional, the zero-config default
 * is a fully working in-memory engine.
 */
export interface RACSOptions {
  /**
   * Per-provider overrides merged over the shipped profiles. Use this when a provider
   * changes its terms before RACS releases, or to describe a `'custom'` provider.
   */
  readonly profiles?: Partial<Readonly<Record<ProviderId, Partial<ProviderProfile>>>>;
  /**
   * Model prices for USD reporting, see {@link PricingTable}. Without it the engine still
   * reports every token-denominated statistic, just no USD figures.
   */
  readonly pricing?: PricingTable;
  /**
   * Maximum number of distinct prefixes tracked before least-recently-used eviction, with
   * a `'limit.reached'` telemetry event on each eviction. Default 1000.
   */
  readonly maxPrefixes?: number;
  /**
   * Seed for the deterministic id generator. Same seed, same inputs, same ids. Default 7.
   * RACS never calls the global random generator.
   */
  readonly seed?: number;
  /** Persistence backend, see {@link StateBackend}. Without it state is in-memory only. */
  readonly state?: StateBackend;
  /**
   * Time source returning milliseconds since the Unix epoch. Default is the platform wall
   * clock. Inject a fake in tests to make every timestamp in the public record
   * deterministic.
   */
  readonly clock?: () => number;
}

/**
 * The engine surface. All planning and accounting methods are synchronous and pure with
 * respect to the network, only `flush` and `close` are asynchronous because persistence
 * may be. See the product invariant at the top of this module: nothing on this interface
 * ever performs a provider API call.
 */
export interface RACS {
  /**
   * Computes the full cache plan for one prompt: prefix key, directives, lints, and
   * break-even economics. Records the plan fingerprint for drift detection and feeds the
   * refresh schedule. Emits `'plan.created'`, and `'prefix.drifted'` when applicable.
   *
   * @throws RacsError code `'ERR_INVALID_INPUT'` on malformed input.
   */
  plan(input: PlanInput): CachePlan;
  /**
   * Runs only the lint pass over the input, no fingerprinting, no drift tracking, no
   * telemetry. Use it in CI to gate prompt changes before they ship.
   *
   * @throws RacsError code `'ERR_INVALID_INPUT'` on malformed input.
   */
  lint(input: PlanInput): readonly LintFinding[];
  /**
   * Ingests one normalized usage report into the ledger and updates per-prefix
   * aggregates. Emits `'usage.recorded'`.
   *
   * @throws RacsError code `'ERR_INVALID_INPUT'` on malformed usage.
   */
  record(usage: CacheUsage): void;
  /**
   * Returns ledger-wide statistics, optionally narrowed to one prefix or one provider.
   * USD figures appear only where the pricing table covers the models involved.
   */
  stats(filter?: { prefixKey?: string; provider?: ProviderId }): LedgerStats;
  /**
   * Returns every keep-warm entry due at or before `now` (default: the injected clock).
   * Emits `'refresh.due'` per returned entry. The host performs the actual warming call,
   * then reports it via {@link RACS.markRefreshed}.
   */
  schedule(now?: number): readonly RefreshEntry[];
  /**
   * Tells the engine the host touched the cache for this prefix at `now` (default: the
   * injected clock), restarting that entry's TTL window and rescheduling its refresh.
   */
  markRefreshed(prefixKey: string, now?: number): void;
  /** Returns the most recent drift reports in chronological order, newest last, capped at `limit` when given. */
  drifts(limit?: number): readonly DriftReport[];
  /**
   * Clears engine bookkeeping for every matching prefix: drift fingerprints, keep-warm
   * refresh schedules, and resource registry entries. Emits a `'resource.action'`
   * telemetry event with action `'delete'` for each resource-family entry invalidated, so
   * the host can mirror the deletion onto the provider (Gemini `cachedContents` deletes
   * especially). Returns the number of distinct prefixes invalidated. Without a filter
   * everything is cleared.
   *
   * Built for credential rotation: provider-side cached resources may be scoped to the
   * credential or workspace that created them, so after a key rotates their handles are
   * unreliable or orphaned, invalidate and re-plan from scratch. Ledger statistics and
   * drift history are accounting records, not cache state, and are deliberately left
   * untouched.
   */
  invalidate(filter?: { readonly prefixKey?: string; readonly provider?: ProviderId }): number;
  /**
   * Returns the effective profile for a provider, shipped values merged with the
   * {@link RACSOptions.profiles} overrides, the numbers the planner is actually using.
   */
  profileOf(provider: ProviderId): ProviderProfile;
  /** Subscribes to telemetry. Returns the unsubscribe function, idempotent to call twice. */
  on(listener: TelemetryListener): () => void;
  /** Persists a snapshot through the configured state backend, no-op without one. */
  flush(): Promise<void>;
  /** Flushes, then releases internal resources. The instance must not be used afterward. */
  close(): Promise<void>;
}
