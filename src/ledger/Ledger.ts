/**
 * Usage ledger of RACS (Remote Agent Context Store): aggregates normalized provider usage
 * reports into per-prefix and ledger-wide hit ratios and USD savings.
 *
 * The ledger holds aggregates only, never prompt content, so its serialized form leaks
 * nothing. It is synchronous, allocation-light, and bounded: at most `maxPrefixes` distinct
 * prefixes are tracked, with least-recently-used eviction beyond that.
 *
 * @packageDocumentation
 */

import type { CacheUsage, LedgerStats, PrefixStats, PricingTable, ProviderId } from '../types.js';

/**
 * Mutable per-prefix running totals. The two write tiers are kept apart because their
 * write premiums differ, see {@link Ledger.stats} for the USD math.
 */
interface PrefixAggregate {
  provider: ProviderId;
  model: string;
  calls: number;
  readTokens: number;
  write5mTokens: number;
  write1hTokens: number;
  uncachedTokens: number;
}

/**
 * One serialized prefix aggregate, see {@link LedgerJSON}.
 */
export interface LedgerEntryJSON {
  /** Aggregate key: the usage `prefixKey`, or `provider:model` for plan-less usage. */
  readonly key: string;
  /** Provider of the aggregated calls. */
  readonly provider: ProviderId;
  /** Model of the aggregated calls, the {@link PricingTable} lookup key. */
  readonly model: string;
  /** Number of usage records aggregated. */
  readonly calls: number;
  /** Total tokens served from cache. */
  readonly readTokens: number;
  /** Total tokens written to 5-minute-TTL caches. */
  readonly write5mTokens: number;
  /** Total tokens written to 1-hour-TTL caches. */
  readonly write1hTokens: number;
  /** Total input tokens that were neither read from nor written to cache. */
  readonly uncachedTokens: number;
}

/**
 * Serialized ledger state, the shape produced by {@link Ledger.toJSON} and consumed by
 * {@link Ledger.fromJSON}. Entries are ordered least-recently-used first, so a round trip
 * preserves eviction order exactly. Pricing is configuration, not state, and is therefore
 * re-supplied to `fromJSON` instead of being serialized.
 */
export interface LedgerJSON {
  /** The eviction cap the ledger was running with. */
  readonly maxPrefixes: number;
  /** Per-prefix aggregates, least-recently-used first. */
  readonly entries: readonly LedgerEntryJSON[];
}

/**
 * Bounded, LRU-evicting accumulator of {@link CacheUsage} records.
 *
 * Aggregation key: `usage.prefixKey` when the call executed a RACS plan, otherwise the
 * synthetic `provider:model` pair, so plan-less calls still aggregate into ledger totals
 * as {@link CacheUsage.prefixKey} documents.
 *
 * Hit-ratio definition: `readTokens / (readTokens + writeTokens + uncachedTokens)`, the
 * share of all input-side token traffic that was served from cache. The denominator counts
 * cached reads, cache writes of both TTL tiers, and uncached input, so a prefix that keeps
 * paying write premiums without ever reading back scores zero, exactly the failure the
 * ratio exists to expose. A zero denominator reports a ratio of zero. Uncached input
 * derives from the all-in {@link CacheUsage.inputTokens} convention, see
 * {@link Ledger.record}, so the denominator equals the all-in billed input when the
 * source reports consistently.
 *
 * USD math, computed only for models the {@link PricingTable} covers:
 * - `savedUsd = readTokens / 1e6 * (inputPerMTok - cacheReadPerMTok)`, what the cached
 *   reads would have cost at base input price minus what they actually cost. Requires
 *   `cacheReadPerMTok`, without it the model counts as not covered for savings.
 * - `writeSpendUsd` is the write PREMIUM over base input price, not the full write bill:
 *   `write5mTokens / 1e6 * (cacheWrite5mPerMTok - inputPerMTok)` plus the 1-hour tier
 *   likewise. A mispriced table can make a tier premium negative, which would silently
 *   inflate savings, so each tier term is clamped at zero before summing.
 * - `netUsd = savedUsd - writeSpendUsd`, negative when caching lost money.
 *
 * Ledger-wide USD totals sum every prefix whose model the pricing table covers, prefixes
 * without pricing contribute only token statistics, and the USD fields are omitted
 * entirely when no aggregated prefix is covered.
 */
export class Ledger {
  private readonly pricing: PricingTable | undefined;
  private readonly maxPrefixes: number;
  /** Map iteration order doubles as recency order: oldest first, see {@link Ledger.record}. */
  private readonly aggregates = new Map<string, PrefixAggregate>();

  /**
   * @param pricing - Per-model price cards for USD figures, always user-supplied. Without
   *   it every token-denominated statistic is still reported, just no USD.
   * @param maxPrefixes - Cap on distinct tracked prefixes before LRU eviction.
   */
  constructor(pricing?: PricingTable, maxPrefixes = 1000) {
    this.pricing = pricing;
    this.maxPrefixes = maxPrefixes;
  }

  /**
   * Ingests one normalized usage record into the aggregate for its prefix.
   *
   * Per call, `uncachedTokens` accumulates
   * `max(0, inputTokens - cacheReadTokens - cacheWriteTokens5m - cacheWriteTokens1h)`:
   * {@link CacheUsage.inputTokens} is the ALL-IN billed input including cached reads and
   * cache writes of both tiers, so the uncached remainder subtracts all three. Clamped at
   * zero because a source reporting more cached traffic than billed input is a reporting
   * artifact that must not drive the aggregate negative.
   *
   * @param usage - The normalized usage report, see {@link CacheUsage}.
   * @returns `hit` is true when the call read at least one cached token. `evicted` names
   *   the least-recently-used prefix key dropped to stay within `maxPrefixes`, present
   *   only when an eviction happened.
   */
  record(usage: CacheUsage): { hit: boolean; evicted?: string } {
    const key = usage.prefixKey ?? `${usage.provider}:${usage.model}`;
    const aggregate: PrefixAggregate = this.aggregates.get(key) ?? {
      provider: usage.provider,
      model: usage.model,
      calls: 0,
      readTokens: 0,
      write5mTokens: 0,
      write1hTokens: 0,
      uncachedTokens: 0,
    };
    // Delete-then-set moves the key to the end of Map iteration order, which keeps the
    // oldest aggregate first and makes eviction a read of the first key.
    this.aggregates.delete(key);
    this.aggregates.set(key, aggregate);

    aggregate.calls += 1;
    aggregate.readTokens += usage.cacheReadTokens;
    aggregate.write5mTokens += usage.cacheWriteTokens5m ?? 0;
    aggregate.write1hTokens += usage.cacheWriteTokens1h ?? 0;
    aggregate.uncachedTokens += Math.max(
      0,
      usage.inputTokens -
        usage.cacheReadTokens -
        (usage.cacheWriteTokens5m ?? 0) -
        (usage.cacheWriteTokens1h ?? 0),
    );
    aggregate.provider = usage.provider;
    aggregate.model = usage.model;

    const hit = usage.cacheReadTokens > 0;
    let evicted: string | undefined;
    if (this.aggregates.size > this.maxPrefixes) {
      const oldest = this.aggregates.keys().next();
      if (!oldest.done) {
        evicted = oldest.value;
        this.aggregates.delete(oldest.value);
      }
    }
    return evicted === undefined ? { hit } : { hit, evicted };
  }

  /**
   * Returns ledger-wide statistics with the per-prefix breakdown, optionally narrowed to
   * one prefix key or one provider. The breakdown is sorted by prefix key ascending for
   * stable, diffable output. USD presence rules are documented on {@link Ledger}.
   *
   * @param filter - Optional narrowing, both fields combine conjunctively when given.
   */
  stats(filter?: { prefixKey?: string; provider?: ProviderId }): LedgerStats {
    const prefixes: PrefixStats[] = [];
    let calls = 0;
    let readTokens = 0;
    let writeTokens = 0;
    let uncachedTokens = 0;
    let savedUsd = 0;
    let writeSpendUsd = 0;
    let priced = false;

    for (const [key, aggregate] of this.aggregates) {
      if (filter?.prefixKey !== undefined && key !== filter.prefixKey) {
        continue;
      }
      if (filter?.provider !== undefined && aggregate.provider !== filter.provider) {
        continue;
      }
      const stat = this.prefixStats(key, aggregate);
      prefixes.push(stat);
      calls += aggregate.calls;
      readTokens += aggregate.readTokens;
      writeTokens += aggregate.write5mTokens + aggregate.write1hTokens;
      uncachedTokens += aggregate.uncachedTokens;
      if (stat.savedUsd !== undefined) {
        savedUsd += stat.savedUsd;
        priced = true;
      }
      if (stat.writeSpendUsd !== undefined) {
        writeSpendUsd += stat.writeSpendUsd;
        priced = true;
      }
    }

    prefixes.sort((a, b) => (a.prefixKey < b.prefixKey ? -1 : a.prefixKey > b.prefixKey ? 1 : 0));
    const denominator = readTokens + writeTokens + uncachedTokens;
    return {
      calls,
      hitRatio: denominator === 0 ? 0 : readTokens / denominator,
      readTokens,
      writeTokens,
      uncachedTokens,
      ...(priced ? { savedUsd, netUsd: savedUsd - writeSpendUsd } : {}),
      prefixes,
    };
  }

  /**
   * Serializes every aggregate, least-recently-used first. The result is pure JSON data,
   * carries no prompt content, and round-trips through {@link Ledger.fromJSON}.
   */
  toJSON(): LedgerJSON {
    const entries: LedgerEntryJSON[] = [];
    for (const [key, aggregate] of this.aggregates) {
      entries.push({
        key,
        provider: aggregate.provider,
        model: aggregate.model,
        calls: aggregate.calls,
        readTokens: aggregate.readTokens,
        write5mTokens: aggregate.write5mTokens,
        write1hTokens: aggregate.write1hTokens,
        uncachedTokens: aggregate.uncachedTokens,
      });
    }
    return { maxPrefixes: this.maxPrefixes, entries };
  }

  /**
   * Rebuilds a ledger from {@link Ledger.toJSON} output, restoring aggregates and their
   * recency order. Pricing is configuration, pass the current table, it is deliberately
   * not part of the snapshot so stale prices never resurrect from persistence.
   *
   * @param json - A previously serialized ledger.
   * @param pricing - The pricing table to compute USD figures with from now on.
   */
  static fromJSON(json: LedgerJSON, pricing?: PricingTable): Ledger {
    const ledger = new Ledger(pricing, json.maxPrefixes);
    for (const entry of json.entries) {
      ledger.aggregates.set(entry.key, {
        provider: entry.provider,
        model: entry.model,
        calls: entry.calls,
        readTokens: entry.readTokens,
        write5mTokens: entry.write5mTokens,
        write1hTokens: entry.write1hTokens,
        uncachedTokens: entry.uncachedTokens,
      });
    }
    return ledger;
  }

  /** Computes one {@link PrefixStats} from a live aggregate, USD rules per {@link Ledger}. */
  private prefixStats(key: string, aggregate: PrefixAggregate): PrefixStats {
    const writeTokens = aggregate.write5mTokens + aggregate.write1hTokens;
    const denominator = aggregate.readTokens + writeTokens + aggregate.uncachedTokens;
    const hitRatio = denominator === 0 ? 0 : aggregate.readTokens / denominator;

    const price = this.pricing?.[aggregate.model];
    let savedUsd: number | undefined;
    let writeSpendUsd: number | undefined;
    if (price !== undefined) {
      if (price.cacheReadPerMTok !== undefined) {
        savedUsd = (aggregate.readTokens / 1e6) * (price.inputPerMTok - price.cacheReadPerMTok);
      }
      const premium5m =
        price.cacheWrite5mPerMTok === undefined
          ? 0
          : Math.max(
              0,
              (aggregate.write5mTokens / 1e6) * (price.cacheWrite5mPerMTok - price.inputPerMTok),
            );
      const premium1h =
        price.cacheWrite1hPerMTok === undefined
          ? 0
          : Math.max(
              0,
              (aggregate.write1hTokens / 1e6) * (price.cacheWrite1hPerMTok - price.inputPerMTok),
            );
      writeSpendUsd = premium5m + premium1h;
    }

    return {
      prefixKey: key,
      calls: aggregate.calls,
      hitRatio,
      readTokens: aggregate.readTokens,
      writeTokens,
      uncachedTokens: aggregate.uncachedTokens,
      ...(savedUsd !== undefined ? { savedUsd } : {}),
      ...(writeSpendUsd !== undefined ? { writeSpendUsd } : {}),
    };
  }
}
