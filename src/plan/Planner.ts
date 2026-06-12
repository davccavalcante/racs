/**
 * The directive planner of RACS (Remote Agent Context Store).
 *
 * One pure class maps an analyzed prompt onto the cache-control surface of one provider
 * family: explicit breakpoints, routing keys, server-side cache resources, or a reasoned
 * no-op for passive providers. The planner is deterministic and stateless, it reads no
 * clock and no random source, so identical inputs always yield identical directives. The
 * engine core owns fingerprinting, drift tracking, refresh timing, and telemetry.
 *
 * @packageDocumentation
 */

import { combineKeys } from '../stats/hash.js';
import { tokensOf } from '../stats/tokens.js';
import type {
  BreakEven,
  CacheDirective,
  CacheTtl,
  LintFinding,
  PlanInput,
  Pricing,
  PromptSegment,
  ProviderProfile,
  SegmentRole,
} from '../types.js';

/**
 * Aggregates the analysis stage computed once, so the planner never recounts the prompt.
 */
export interface PlanAnalysis {
  /** Findings the lint pass produced, context the planner extends through extraFindings. */
  findings: LintFinding[];
  /** Token count of the cacheable stable prefix, exact or estimated per segment rules. */
  stableTokens: number;
  /** Token count of the whole prompt, same exact-or-estimated provenance. */
  totalTokens: number;
  /**
   * Count of leading segments, in request order, forming the left-anchored cacheable
   * prefix. Prefix caches reuse nothing past this boundary on any provider family.
   */
  orderedStableBoundary: number;
}

/**
 * The planner's contribution to one cache plan, merged by the engine core with the plan
 * identity, the fingerprints, and the analysis findings.
 */
export interface PlannerResult {
  /** Provider-faithful instructions in application order. */
  directives: CacheDirective[];
  /** Cache economics, present when profile multipliers or pricing allow computing them. */
  breakEven?: BreakEven;
  /** One dense human-readable sentence per planning decision. */
  reasoning: string;
  /** Findings only the planning stage can detect, appended to the analysis findings. */
  extraFindings: LintFinding[];
}

/**
 * Breakpoint selection priority per segment role. Anthropic hashes the request prefix as
 * tools, then system, then messages (Anthropic prompt caching docs, June 2026), and Amazon
 * Bedrock `cachePoint` follows the same request anatomy (AWS Bedrock prompt caching docs,
 * June 2026), so a marker after each large stable region in that order preserves partial
 * reuse when a later region drifts.
 */
const ROLE_WEIGHT: Readonly<Record<SegmentRole, number>> = {
  tools: 4,
  system: 3,
  documents: 2,
  history: 1,
  dynamic: 0,
};

/** Window lengths of the two breakpoint-family TTL tiers, see {@link CacheTtl}. */
const TTL_SECONDS: Readonly<Record<CacheTtl, number>> = { '5m': 300, '1h': 3600 };

/**
 * Reuse-interval ceilings for TTL tier choice. The two-tier 5-minute and 1-hour model is
 * the breakpoint-family standard as of June 2026 (Anthropic prompt caching docs). The
 * ceilings keep 60s and 300s of refresh headroom under the 300s and 3600s windows, so a
 * keep-warm touch scheduled at 90 percent of the TTL still lands before expiry despite
 * timer jitter.
 */
const FIVE_MINUTE_INTERVAL_CEILING = 240;
const ONE_HOUR_INTERVAL_CEILING = 3300;

/**
 * Resource-family TTL bounds. Google Gemini `cachedContents` defaults to a 3600 second TTL
 * and bills storage per token-hour while the resource stays alive (Google Gemini API
 * caching docs, June 2026).
 */
const RESOURCE_TTL_MIN_SECONDS = 300;
const RESOURCE_TTL_DEFAULT_SECONDS = 3600;

/** Formats counts for reasoning prose without dragging float noise into the sentence. */
const formatCount = (value: number): string =>
  Number.isInteger(value) ? value.toString() : value.toFixed(2);

/** Formats small USD amounts for reasoning prose at three significant digits. */
const formatUsd = (value: number): string => `${value.toPrecision(3)} USD`;

/**
 * Effective seconds between calls sharing this prefix. Per the {@link PlanInput} contract
 * `intervalSeconds` wins over `callsPerHour` when both are present.
 */
const intervalSecondsOf = (input: PlanInput): number | undefined => {
  const reuse = input.reuse;
  if (reuse === undefined) {
    return undefined;
  }
  if (reuse.intervalSeconds !== undefined) {
    return reuse.intervalSeconds;
  }
  if (reuse.callsPerHour !== undefined && reuse.callsPerHour > 0) {
    return 3600 / reuse.callsPerHour;
  }
  return undefined;
};

/** Effective calls per hour, the demand side of every break-even comparison. */
const callsPerHourOf = (input: PlanInput): number | undefined => {
  const reuse = input.reuse;
  if (reuse === undefined) {
    return undefined;
  }
  if (reuse.intervalSeconds !== undefined && reuse.intervalSeconds > 0) {
    return 3600 / reuse.intervalSeconds;
  }
  if (reuse.callsPerHour !== undefined) {
    return reuse.callsPerHour;
  }
  return undefined;
};

/**
 * Write multiplier for the chosen tier, from the profile when it carries one, otherwise
 * derived from the pricing table. Multipliers are price-relative, so pricing is optional.
 */
const writeMultiplierFor = (
  ttl: CacheTtl,
  profile: ProviderProfile,
  pricing?: Pricing,
): number | undefined => {
  const fromProfile = ttl === '1h' ? profile.writeMultiplier1h : profile.writeMultiplier5m;
  if (fromProfile !== undefined) {
    return fromProfile;
  }
  if (pricing !== undefined && pricing.inputPerMTok > 0) {
    const writePrice = ttl === '1h' ? pricing.cacheWrite1hPerMTok : pricing.cacheWrite5mPerMTok;
    if (writePrice !== undefined) {
      return writePrice / pricing.inputPerMTok;
    }
  }
  return undefined;
};

/** Read multiplier, profile first, pricing-derived second, same rationale as above. */
const readMultiplierFor = (profile: ProviderProfile, pricing?: Pricing): number | undefined => {
  if (profile.readMultiplier !== undefined) {
    return profile.readMultiplier;
  }
  if (pricing !== undefined && pricing.inputPerMTok > 0 && pricing.cacheReadPerMTok !== undefined) {
    return pricing.cacheReadPerMTok / pricing.inputPerMTok;
  }
  return undefined;
};

/** One contiguous run of same-role non-volatile segments inside the cacheable prefix. */
interface StableSpan {
  readonly role: SegmentRole;
  readonly tokens: number;
  readonly endSegmentId: string;
  readonly endIndex: number;
}

/**
 * Groups the left-anchored cacheable prefix into role spans. Iteration stops at the first
 * volatile segment because prefix caches are strictly left-anchored, nothing written past
 * a volatile span could ever be read back.
 */
const stableSpansOf = (segments: readonly PromptSegment[], boundary: number): StableSpan[] => {
  const spans: StableSpan[] = [];
  let open: StableSpan | undefined;
  const limit = Math.min(boundary, segments.length);
  for (let index = 0; index < limit; index += 1) {
    const segment = segments[index];
    if (segment === undefined || segment.stability === 'volatile') {
      break;
    }
    const tokens = tokensOf(segment);
    if (open !== undefined && open.role === segment.role) {
      open = {
        role: open.role,
        tokens: open.tokens + tokens,
        endSegmentId: segment.id,
        endIndex: index,
      };
    } else {
      if (open !== undefined) {
        spans.push(open);
      }
      open = { role: segment.role, tokens, endSegmentId: segment.id, endIndex: index };
    }
  }
  if (open !== undefined) {
    spans.push(open);
  }
  return spans;
};

/**
 * Break-even economics for the breakpoint family inside the TTL window, stated in
 * base-input-token equivalents because the multipliers are price-relative, which is
 * exactly why pricing stays optional.
 *
 * Reuse model, refresh-on-use: breakpoint providers refresh the cache TTL at no
 * additional cost every time the cached content is read (Anthropic prompt caching
 * documentation, "the cache TTL is refreshed each time the cached content is used",
 * retrieved June 2026). When the declared reuse interval fits inside the TTL window the
 * entry therefore survives indefinitely under steady traffic: the write premium is paid
 * once, every read recovers `coveredTokens * (1 - readMultiplier)`, and the
 * `minReusesToProfit`-th repaying read always arrives, so profitability reduces to each
 * read actually saving, that is `readMultiplier < 1`. `expectedReuses` is reported over a
 * one-hour horizon as `max(1, round(callsPerHour))` in the reasoning prose. Without a
 * declared reuse pattern (`callsPerHour` undefined) a single reuse is assumed and
 * profitability compares it to `minReusesToProfit`, because no traffic statement exists
 * for the survival argument to lean on.
 *
 * @param coveredTokens - Tokens actually covered up to the last placed marker, the span
 * the write premium is paid on, see the coverage computation in the breakpoint planner.
 */
const breakpointBreakEven = (
  coveredTokens: number,
  ttl: CacheTtl,
  callsPerHour: number | undefined,
  profile: ProviderProfile,
  pricing?: Pricing,
): BreakEven | undefined => {
  const writeMultiplier = writeMultiplierFor(ttl, profile, pricing);
  const readMultiplier = readMultiplierFor(profile, pricing);
  if (writeMultiplier === undefined || readMultiplier === undefined) {
    return undefined;
  }
  const writePremiumTokens = Math.max(0, coveredTokens * (writeMultiplier - 1));
  const savingsPerReuse = coveredTokens * (1 - readMultiplier);
  const minReusesToProfit =
    savingsPerReuse > 0
      ? Math.ceil(writePremiumTokens / savingsPerReuse)
      : Number.POSITIVE_INFINITY;
  if (callsPerHour === undefined) {
    const profitable = 1 >= minReusesToProfit;
    const reasoning = `The ${ttl} write multiplier ${formatCount(writeMultiplier)} prices the premium at ${formatCount(writePremiumTokens)} base-token equivalents, each reuse at read multiplier ${formatCount(readMultiplier)} recovers ${formatCount(savingsPerReuse)}, so ${formatCount(minReusesToProfit)} reuse(s) repay the write against the single assumed reuse (no reuse pattern was declared; multipliers are price-relative, the math holds with or without a pricing table), ${profitable ? 'profitable' : 'not profitable'}.`;
    return { writePremiumTokens, minReusesToProfit, profitable, reasoning };
  }
  const expectedReuses = Math.max(1, Math.round(callsPerHour));
  const profitable = Number.isFinite(minReusesToProfit);
  const reasoning = `The ${ttl} write multiplier ${formatCount(writeMultiplier)} prices the premium at ${formatCount(writePremiumTokens)} base-token equivalents, each reuse at read multiplier ${formatCount(readMultiplier)} recovers ${formatCount(savingsPerReuse)}, so ${formatCount(minReusesToProfit)} reuse(s) repay the single write; reads refresh the ${ttl} window at no extra cost (refresh-on-use), steady declared reuse keeps the entry alive indefinitely at about ${formatCount(expectedReuses)} reuse(s) per hour (multipliers are price-relative, the math holds with or without a pricing table), ${profitable ? 'profitable' : 'not profitable'}.`;
  return { writePremiumTokens, minReusesToProfit, profitable, reasoning };
};

/**
 * Break-even economics for the keep-warm band, the SAME touch-cost model that justifies
 * keeping the tier, so the branch reasoning and the break-even verdict can never
 * contradict each other.
 *
 * Model: when the reuse interval outruns the widest TTL window, scheduled refresh touches
 * at 90 percent of the TTL keep the entry alive at read price (refresh-on-use, Anthropic
 * prompt caching documentation, June 2026). Each real reuse recovers
 * `coveredTokens * (1 - r)` and carries `refreshesPerHour / callsPerHour` touches costing
 * `coveredTokens * r` each, so the net per reuse is the savings minus the touch share,
 * and the single write premium is repaid after `ceil(premium / net)` reuses. The
 * keep-warm branch is entered only when the net is strictly positive, so a kept tier is
 * always profitable here; a non-positive net never reaches this function because the
 * planner declines the tier instead.
 */
const keepWarmBreakEven = (
  coveredTokens: number,
  ttl: CacheTtl,
  callsPerHour: number,
  refreshesPerHour: number,
  readMultiplier: number,
  profile: ProviderProfile,
  pricing?: Pricing,
): BreakEven | undefined => {
  const writeMultiplier = writeMultiplierFor(ttl, profile, pricing);
  if (writeMultiplier === undefined || callsPerHour <= 0) {
    return undefined;
  }
  const writePremiumTokens = Math.max(0, coveredTokens * (writeMultiplier - 1));
  const savingsPerReuse = coveredTokens * (1 - readMultiplier);
  const touchCostPerReuse = (refreshesPerHour / callsPerHour) * coveredTokens * readMultiplier;
  const netPerReuse = savingsPerReuse - touchCostPerReuse;
  const profitable = netPerReuse > 0;
  const minReusesToProfit = profitable
    ? Math.ceil(writePremiumTokens / netPerReuse)
    : Number.POSITIVE_INFINITY;
  const reasoning = `Keep-warm economics: each reuse recovers ${formatCount(savingsPerReuse)} base-token equivalents and carries ${formatCount(touchCostPerReuse)} of scheduled refresh touches (${formatCount(refreshesPerHour)} touch(es) per hour at read multiplier ${formatCount(readMultiplier)} spread over ${formatCount(callsPerHour)} call(s) per hour), netting ${formatCount(netPerReuse)}, so the single ${ttl} write premium of ${formatCount(writePremiumTokens)} is repaid after ${formatCount(minReusesToProfit)} reuse(s), ${profitable ? 'profitable' : 'not profitable'}.`;
  return { writePremiumTokens, minReusesToProfit, profitable, reasoning };
};

/**
 * Storage economics for the resource family: storage cost per hour versus read savings per
 * call times calls per hour. USD-denominated because per-token-hour storage has no
 * price-relative form, so this needs the pricing table to exist.
 */
const resourceBreakEven = (
  stableTokens: number,
  callsPerHour: number,
  profile: ProviderProfile,
  pricing?: Pricing,
): BreakEven | undefined => {
  const storagePerMTokHour = pricing?.storagePerMTokHour ?? profile.storagePerMTokHour;
  if (storagePerMTokHour === undefined || pricing === undefined || pricing.inputPerMTok <= 0) {
    return undefined;
  }
  const readPerMTok =
    pricing.cacheReadPerMTok ??
    (profile.readMultiplier === undefined
      ? undefined
      : pricing.inputPerMTok * profile.readMultiplier);
  if (readPerMTok === undefined) {
    return undefined;
  }
  const savingsPerCallUsd = (stableTokens / 1_000_000) * (pricing.inputPerMTok - readPerMTok);
  if (savingsPerCallUsd <= 0) {
    return undefined;
  }
  const storagePerHourUsd = (stableTokens / 1_000_000) * storagePerMTokHour;
  const writePremiumTokens = (storagePerHourUsd / pricing.inputPerMTok) * 1_000_000;
  const minReusesToProfit = Math.ceil(storagePerHourUsd / savingsPerCallUsd);
  const profitable = callsPerHour >= minReusesToProfit;
  const reasoning = `Keeping ${formatCount(stableTokens)} tokens resident bills ${formatUsd(storagePerHourUsd)} per hour of storage (${formatCount(writePremiumTokens)} base-token equivalents), each cached read saves ${formatUsd(savingsPerCallUsd)}, so ${formatCount(minReusesToProfit)} reuse(s) per hour break even against ${formatCount(callsPerHour)} expected, ${profitable ? 'profitable' : 'not profitable'}.`;
  return { writePremiumTokens, minReusesToProfit, profitable, reasoning };
};

/**
 * Maps one analyzed prompt to provider-faithful cache directives, per adapter family.
 *
 * Family semantics implemented here are research snapshots of June 2026, sources cited on
 * the constants above, and every number flows from the {@link ProviderProfile}, so a
 * profile override updates the planner without a release.
 */
export class Planner {
  /**
   * Produces directives, break-even economics, and planner-stage findings for one input.
   *
   * @param input - The prompt being planned, segments in request order.
   * @param profile - Effective provider profile, overrides already merged by the core.
   * @param analysis - Aggregates the analysis stage computed, see {@link PlanAnalysis}.
   * @param prefixKey - Deterministic key of the stable prefix, computed by the core.
   * @param pricing - Optional model price card, refines multipliers and storage math.
   * @param knownResource - Resource family only: whether the core already tracks a live
   * cache resource for this prefix. First sight emits `'create'`, later sights `'reuse'`,
   * and the core swaps `'reuse'` for `'refresh'` when its clock sits inside the last 10
   * percent of the TTL window, the planner emits the shape, the core decides the timing.
   */
  plan(
    input: PlanInput,
    profile: ProviderProfile,
    analysis: PlanAnalysis,
    prefixKey: string,
    pricing?: Pricing,
    knownResource = false,
  ): PlannerResult {
    const result = this.planFamily(input, profile, analysis, prefixKey, pricing, knownResource);
    if (profile.notes !== undefined && profile.notes !== '') {
      return { ...result, reasoning: `${result.reasoning} Provider note: ${profile.notes}` };
    }
    return result;
  }

  private planFamily(
    input: PlanInput,
    profile: ProviderProfile,
    analysis: PlanAnalysis,
    prefixKey: string,
    pricing: Pricing | undefined,
    knownResource: boolean,
  ): PlannerResult {
    switch (profile.family) {
      case 'breakpoint':
        return this.planBreakpoint(input, profile, analysis, pricing);
      case 'routing-key':
        return this.planRoutingKey(input, profile, analysis, prefixKey);
      case 'resource':
        return this.planResource(input, profile, analysis, prefixKey, knownResource, pricing);
      default:
        // 'passive' and any family a newer minor may add degrade to the no-op family.
        return this.planPassive(profile);
    }
  }

  /**
   * Breakpoint family (anthropic, bedrock, hermes, microsoft-foundry): explicit markers,
   * one TTL tier chosen from the declared reuse. The deepest stable boundary is always
   * marked because the last marker determines left-anchored coverage, remaining budget
   * goes to the largest stable spans by role weight. Economics follow the refresh-on-use
   * model documented on {@link breakpointBreakEven} inside the TTL window and the
   * touch-cost model on {@link keepWarmBreakEven} beyond it; when neither sustains the
   * cache the planner declines with a reasoned `'none'` plus a `'write-premium-trap'`
   * finding, so an emitted breakpoint plan is never knowingly unprofitable.
   */
  private planBreakpoint(
    input: PlanInput,
    profile: ProviderProfile,
    analysis: PlanAnalysis,
    pricing?: Pricing,
  ): PlannerResult {
    const extraFindings: LintFinding[] = [];
    const minCacheable = profile.minCacheableTokens ?? 0;
    if (analysis.stableTokens < minCacheable) {
      return {
        directives: [
          {
            kind: 'none',
            reason: `stable prefix is ${formatCount(analysis.stableTokens)} tokens, below the provider minimum of ${formatCount(minCacheable)}, the provider would silently cache nothing`,
          },
        ],
        reasoning: `Skipped caching because the ${formatCount(analysis.stableTokens)}-token stable prefix sits below the ${formatCount(minCacheable)}-token provider minimum, a marker there would buy nothing.`,
        extraFindings,
      };
    }

    const spans = stableSpansOf(input.segments, analysis.orderedStableBoundary);
    const deepest = spans[spans.length - 1];
    if (deepest === undefined) {
      const first = input.segments[0];
      if (first !== undefined && first.stability === 'volatile') {
        extraFindings.push({
          severity: 'error',
          code: 'breakpoint-after-volatile',
          segmentId: first.id,
          message: `the only breakpoint candidate follows volatile segment '${first.id}', a span written there could never be read back; move volatile content after the stable prefix`,
        });
        return {
          directives: [
            {
              kind: 'none',
              reason:
                'every breakpoint candidate sits after a volatile segment, a written span could never be read back',
            },
          ],
          reasoning:
            'Refused to place a breakpoint after a volatile segment, the written span could never be read back, so the write premium would be pure loss.',
          extraFindings,
        };
      }
      return {
        directives: [
          { kind: 'none', reason: 'no left-anchored stable prefix exists to mark for caching' },
        ],
        reasoning: 'Skipped caching, the prompt carries no left-anchored stable prefix to mark.',
        extraFindings,
      };
    }

    const budget = profile.maxBreakpoints ?? 1;
    if (budget <= 0) {
      return {
        directives: [
          { kind: 'none', reason: 'the provider profile allows zero cache breakpoints' },
        ],
        reasoning: 'Skipped caching, the effective profile grants no breakpoint slots.',
        extraFindings,
      };
    }

    const sentences: string[] = [];
    const interval = intervalSecondsOf(input);
    const callsPerHour = callsPerHourOf(input);
    const tiers: readonly CacheTtl[] = profile.ttls ?? ['5m'];
    const supports1h = tiers.includes('1h');
    let ttl: CacheTtl;
    let keepWarm: { refreshesPerHour: number; readMultiplier: number } | undefined;
    if (interval === undefined) {
      ttl = tiers.includes('5m') || !supports1h ? '5m' : '1h';
      sentences.push(
        `No reuse pattern was declared, defaulting to the ${ttl} tier, the lowest write premium the profile offers, with a single assumed reuse for break-even.`,
      );
    } else if (interval <= FIVE_MINUTE_INTERVAL_CEILING && tiers.includes('5m')) {
      ttl = '5m';
      sentences.push(
        `Reuse every ${formatCount(interval)}s fits the 5m tier with ${formatCount(TTL_SECONDS['5m'] - interval)}s of refresh headroom before the 300s window closes, and every read refreshes the window at no cost.`,
      );
    } else if (interval <= ONE_HOUR_INTERVAL_CEILING && supports1h) {
      ttl = '1h';
      sentences.push(
        `Reuse every ${formatCount(interval)}s overruns the 5m tier, the 1h tier holds it with ${formatCount(TTL_SECONDS['1h'] - interval)}s of refresh headroom under the 3600s window, and every read refreshes the window at no cost.`,
      );
    } else {
      const widest: CacheTtl = supports1h ? '1h' : '5m';
      const refreshesPerHour = 3600 / TTL_SECONDS[widest];
      const readMultiplier = readMultiplierFor(profile, pricing);
      // Decline at equality too: a net of exactly zero never repays the write premium,
      // and a kept tier must always be repayable, see keepWarmBreakEven.
      if (
        callsPerHour === undefined ||
        readMultiplier === undefined ||
        readMultiplier >= 1 ||
        callsPerHour * (1 - readMultiplier) <= refreshesPerHour * readMultiplier
      ) {
        extraFindings.push({
          severity: 'warning',
          code: 'write-premium-trap',
          message: `the declared reuse every ${formatCount(interval)}s outruns the widest ${widest} window and the traffic cannot cover keep-warm touches, so the write premium on ${formatCount(analysis.stableTokens)} stable tokens would never be repaid; raise reuse density or skip caching`,
        });
        return {
          directives: [
            {
              kind: 'none',
              reason: 'reuse interval exceeds provider TTL, caching would re-write every call',
            },
          ],
          reasoning: `Reuse every ${formatCount(interval)}s exceeds what the widest ${widest} window holds with refresh headroom, every call would pay the write premium again, so no marker is placed.`,
          extraFindings,
        };
      }
      ttl = widest;
      keepWarm = { refreshesPerHour, readMultiplier };
      sentences.push(
        `Reuse every ${formatCount(interval)}s exceeds the ${widest} window, but ${formatCount(callsPerHour)} calls per hour against ${formatCount(refreshesPerHour)} keep-warm touches per hour at read multiplier ${formatCount(readMultiplier)} keep refresh-keeping profitable, so the ${widest} tier stays on with touches scheduled at 90 percent of the TTL.`,
      );
    }

    // The deepest stable boundary is ALWAYS marked: the last marker determines the
    // left-anchored coverage, so dropping the final span by role weight would silently
    // shrink what the plan claims to cache. Remaining slots go to the largest stable
    // spans by role weight for partial-reuse protection when a later region drifts.
    const ranked = [...spans.slice(0, -1)].sort((a, b) => {
      const byWeight = ROLE_WEIGHT[b.role] - ROLE_WEIGHT[a.role];
      if (byWeight !== 0) {
        return byWeight;
      }
      if (b.tokens !== a.tokens) {
        return b.tokens - a.tokens;
      }
      return a.endIndex - b.endIndex;
    });
    const chosen = [deepest, ...ranked.slice(0, Math.max(0, budget - 1))].sort(
      (a, b) => a.endIndex - b.endIndex,
    );
    const directives: CacheDirective[] = chosen.map((span) => ({
      kind: 'breakpoint',
      segmentId: span.endSegmentId,
      ttl,
    }));
    // Coverage is left-anchored and runs to the LAST chosen marker, which is the forced
    // deepest boundary, so every stable span at or before it counts as covered.
    const lastChosen = chosen[chosen.length - 1] ?? deepest;
    let coveredTokens = 0;
    for (const span of spans) {
      if (span.endIndex <= lastChosen.endIndex) {
        coveredTokens += span.tokens;
      }
    }
    const placement = chosen
      .map(
        (span) =>
          `${span.role} ending at '${span.endSegmentId}', ${formatCount(span.tokens)} tokens`,
      )
      .join('; ');
    sentences.push(
      `Placed ${formatCount(directives.length)} of ${formatCount(budget)} allowed breakpoints: the deepest stable boundary '${deepest.endSegmentId}' is always marked because the last marker determines left-anchored coverage, and the remaining slots go to the largest stable spans weighted tools over system over documents over history (${placement}) because the provider hashes tools, then system, then messages, so each extra marker preserves partial reuse when a later region drifts, covering ${formatCount(coveredTokens)} of ${formatCount(analysis.totalTokens)} prompt tokens.`,
    );

    const breakEven =
      keepWarm !== undefined && callsPerHour !== undefined
        ? keepWarmBreakEven(
            coveredTokens,
            ttl,
            callsPerHour,
            keepWarm.refreshesPerHour,
            keepWarm.readMultiplier,
            profile,
            pricing,
          )
        : breakpointBreakEven(
            coveredTokens,
            ttl,
            interval === undefined ? undefined : callsPerHour,
            profile,
            pricing,
          );
    if (breakEven !== undefined) {
      sentences.push(breakEven.reasoning);
      if (!breakEven.profitable) {
        extraFindings.push({
          severity: 'warning',
          code: 'write-premium-trap',
          message: `expected reuse inside the ${ttl} window does not repay the cache write premium on ${formatCount(coveredTokens)} covered stable tokens; raise reuse density, choose a longer TTL tier, or skip caching`,
        });
      }
    }

    return {
      directives,
      ...(breakEven !== undefined ? { breakEven } : {}),
      reasoning: sentences.join(' '),
      extraFindings,
    };
  }

  /**
   * Routing-key family (openai, xai, mistral, moonshot, openrouter): the provider caches
   * implicitly, the key only steers identical prefixes to the same cache shard, and the
   * extended 24-hour retention tier rides along when supported and the reuse is sparse
   * (OpenAI `prompt_cache_key` retention as of June 2026).
   */
  private planRoutingKey(
    input: PlanInput,
    profile: ProviderProfile,
    analysis: PlanAnalysis,
    prefixKey: string,
  ): PlannerResult {
    const interval = intervalSecondsOf(input);
    const wantsRetention =
      profile.supportsRetention === true && interval !== undefined && interval > 3600;
    const directives: CacheDirective[] = [
      {
        kind: 'routing-key',
        key: prefixKey,
        ...(wantsRetention ? { retention: '24h' as const } : {}),
      },
    ];
    const retentionNote =
      wantsRetention && interval !== undefined
        ? `, and reuse every ${formatCount(interval)}s outlives the default cache window, so the 24h retention tier is requested behind the key`
        : '';
    return {
      directives,
      reasoning: `${profile.id} caches prefixes automatically on the server, the routing key only pins the ${formatCount(analysis.stableTokens)}-token stable prefix of ${formatCount(analysis.totalTokens)} prompt tokens to one cache shard, so keeping that prefix byte-stable is the real lever${retentionNote}.`,
      extraFindings: [],
    };
  }

  /**
   * Resource family (google): the cache is a server resource the host creates, reuses,
   * refreshes, and deletes, billed per token-hour of storage while it stays alive.
   */
  private planResource(
    input: PlanInput,
    profile: ProviderProfile,
    analysis: PlanAnalysis,
    prefixKey: string,
    knownResource: boolean,
    pricing?: Pricing,
  ): PlannerResult {
    const extraFindings: LintFinding[] = [];
    const interval = intervalSecondsOf(input);
    const ttlSeconds =
      interval === undefined
        ? RESOURCE_TTL_DEFAULT_SECONDS
        : Math.min(RESOURCE_TTL_DEFAULT_SECONDS, Math.max(RESOURCE_TTL_MIN_SECONDS, interval * 4));
    // Guards untyped callers handing an empty prefix key, the directive shape stays valid
    // and deterministic by deriving identity from the same lineage fields the core uses.
    const resourceKey =
      prefixKey !== ''
        ? prefixKey
        : combineKeys([input.provider, input.model, input.agentId ?? '']);
    const callsPerHour = callsPerHourOf(input) ?? 1;
    const breakEven = resourceBreakEven(analysis.stableTokens, callsPerHour, profile, pricing);
    if (callsPerHour < 1) {
      extraFindings.push({
        severity: 'warning',
        code: 'write-premium-trap',
        message: `the storage trap: at ${formatCount(callsPerHour)} reuses per hour, per-token-hour storage on ${formatCount(analysis.stableTokens)} resident tokens outruns the read savings; raise reuse density or rely on implicit provider caching`,
      });
      return {
        directives: [
          {
            kind: 'none',
            reason:
              'below one reuse per hour the per-token-hour storage bill outruns the read savings, the storage trap, so no cache resource is worth keeping alive',
          },
        ],
        ...(breakEven !== undefined ? { breakEven } : {}),
        reasoning: `Skipped the cache resource because ${formatCount(callsPerHour)} reuses per hour cannot cover storage billed for every hour the resource stays alive, the classic resource-family storage trap.`,
        extraFindings,
      };
    }
    const action: 'create' | 'reuse' = knownResource ? 'reuse' : 'create';
    const directives: CacheDirective[] = [{ kind: 'resource', action, resourceKey, ttlSeconds }];
    const sentences: string[] = [
      `${action === 'create' ? 'Creating' : 'Reusing'} the server-side cache resource for this prefix with a ${formatCount(ttlSeconds)}s TTL, four times the ${interval === undefined ? 'default-assumed' : `${formatCount(interval)}s`} reuse interval clamped to [${formatCount(RESOURCE_TTL_MIN_SECONDS)}, ${formatCount(RESOURCE_TTL_DEFAULT_SECONDS)}], and the core swaps reuse for refresh inside the last 10 percent of that window.`,
    ];
    if (breakEven !== undefined) {
      sentences.push(breakEven.reasoning);
      if (!breakEven.profitable) {
        extraFindings.push({
          severity: 'warning',
          code: 'write-premium-trap',
          message: `at ${formatCount(callsPerHour)} reuses per hour the per-token-hour storage bill on ${formatCount(analysis.stableTokens)} resident tokens exceeds the read savings; raise reuse density or shorten the resource TTL`,
        });
      }
    }
    return {
      directives,
      ...(breakEven !== undefined ? { breakEven } : {}),
      reasoning: sentences.join(' '),
      extraFindings,
    };
  }

  /**
   * Passive family (groq, deepseek, ollama, lmstudio, huggingface, custom): no control
   * surface exists, stable-first ordering and accounting are the whole contribution.
   */
  private planPassive(profile: ProviderProfile): PlannerResult {
    return {
      directives: [
        {
          kind: 'none',
          reason:
            'provider caches automatically (or exposes no controls); RACS contributes structure linting and analytics',
        },
      ],
      reasoning: `${profile.id} exposes no cache control surface, so stable-first segment ordering is the entire optimization, and the ledger still accounts every cached token the provider reports.`,
      extraFindings: [],
    };
  }
}
