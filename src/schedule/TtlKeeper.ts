/**
 * Keep-warm scheduling of RACS (Remote Agent Context Store): tracks when each cached
 * prefix was last written and when a refresh touch is due, so the host can keep caches
 * warm at read price instead of paying the write premium again after expiry.
 *
 * The keeper computes WHEN, the host runs the timer and the warming call, per the product
 * invariant, RACS never talks to any provider network API.
 *
 * @packageDocumentation
 */

import type { CachePlan, CacheTtl, RefreshEntry } from '../types.js';

/**
 * Fraction of the TTL window after which the keep-warm touch is scheduled.
 *
 * The 90 percent headroom is the production heartbeat convention for prompt-cache
 * keep-warm loops (as observed across Anthropic prompt caching deployments, June 2026):
 * touching at 100 percent races cache expiry against timer drift, queue delay, and request
 * latency, one lost race costs a full write premium, while touching much earlier wastes
 * paid reads on a cache that had plenty of life left. One tenth of the window absorbs the
 * jitter of ordinary schedulers at both the 5-minute and 1-hour tiers.
 */
const REFRESH_FRACTION = 0.9;

/**
 * Converts a TTL declaration to milliseconds. The `'5m'` (300 seconds) and `'1h'`
 * (3600 seconds) tiers are the breakpoint-family standard as of June 2026, see
 * {@link CacheTtl}. Resource-family TTLs arrive as arbitrary second counts.
 */
function ttlToMillis(ttl: CacheTtl | number): number {
  if (ttl === '5m') {
    return 300_000;
  }
  if (ttl === '1h') {
    return 3_600_000;
  }
  return ttl * 1000;
}

/**
 * Serialized keeper state, produced by {@link TtlKeeper.toJSON} and consumed by
 * {@link TtlKeeper.fromJSON}. {@link RefreshEntry} is already pure JSON data, so entries
 * serialize verbatim, ordered least-recently-tracked first to preserve eviction order.
 */
export interface TtlKeeperJSON {
  /** The eviction cap the keeper was running with. */
  readonly capacity: number;
  /** Keep-warm entries, least-recently-tracked first. */
  readonly entries: readonly RefreshEntry[];
}

/**
 * Bounded, LRU-evicting registry of keep-warm entries, one per prefix key.
 *
 * Tracked directives: `'breakpoint'` directives with their `'5m'` or `'1h'` tier, and
 * `'resource'` directives with their `ttlSeconds`. `'routing-key'`, `'none'`, and plans
 * without cache writes track nothing, there is no host-controlled expiry to keep warm. A
 * `'resource'` directive with action `'delete'` removes the entry instead, a deleted
 * resource must not be kept warm.
 *
 * When one plan carries several tracked directives with different TTLs, the SHORTEST one
 * drives the schedule: a refresh touch rewarms every span of the prefix at once, and the
 * earliest-expiring span bounds how long the whole prefix stays warm.
 */
export class TtlKeeper {
  private readonly capacity: number;
  /** Map iteration order doubles as recency order, oldest entry first. */
  private readonly entries = new Map<string, RefreshEntry>();

  /**
   * @param capacity - Cap on distinct tracked prefixes before LRU eviction.
   */
  constructor(capacity = 1000) {
    this.capacity = capacity;
  }

  /**
   * Records or replaces the keep-warm entry for the plan's prefix.
   *
   * `refreshAt = lastWriteAt + 0.9 * ttlMillis`, see {@link REFRESH_FRACTION} for why
   * 90 percent.
   *
   * @param plan - The plan whose directives describe the cache writes to keep warm.
   * @param now - Milliseconds since the Unix epoch, from the injected engine clock,
   *   taken as the moment of the cache write.
   */
  track(plan: CachePlan, now: number): void {
    let ttl: CacheTtl | number | undefined;
    for (const directive of plan.directives) {
      if (directive.kind === 'breakpoint') {
        if (ttl === undefined || ttlToMillis(directive.ttl) < ttlToMillis(ttl)) {
          ttl = directive.ttl;
        }
      } else if (directive.kind === 'resource') {
        if (directive.action === 'delete') {
          this.remove(plan.prefixKey);
          return;
        }
        if (ttl === undefined || ttlToMillis(directive.ttlSeconds) < ttlToMillis(ttl)) {
          ttl = directive.ttlSeconds;
        }
      }
    }
    if (ttl === undefined) {
      return;
    }

    const entry: RefreshEntry = {
      prefixKey: plan.prefixKey,
      provider: plan.provider,
      model: plan.model,
      ttl,
      lastWriteAt: now,
      refreshAt: now + REFRESH_FRACTION * ttlToMillis(ttl),
    };
    // Delete-then-set keeps Map iteration order as recency order for LRU eviction.
    this.entries.delete(plan.prefixKey);
    this.entries.set(plan.prefixKey, entry);
    if (this.entries.size > this.capacity) {
      const oldest = this.entries.keys().next();
      if (!oldest.done) {
        this.entries.delete(oldest.value);
      }
    }
  }

  /**
   * Returns every entry whose refresh touch is due at or before `now`, most overdue first,
   * ties broken by prefix key for deterministic output. Read-only: the host performs the
   * warming call and then reports it through {@link TtlKeeper.markRefreshed}.
   *
   * @param now - Milliseconds since the Unix epoch, from the injected engine clock.
   */
  due(now: number): RefreshEntry[] {
    const due: RefreshEntry[] = [];
    for (const entry of this.entries.values()) {
      if (entry.refreshAt <= now) {
        due.push(entry);
      }
    }
    due.sort((a, b) =>
      a.refreshAt === b.refreshAt
        ? a.prefixKey < b.prefixKey
          ? -1
          : a.prefixKey > b.prefixKey
            ? 1
            : 0
        : a.refreshAt - b.refreshAt,
    );
    return due;
  }

  /**
   * Slides the TTL window after the host touched the cache: `lastWriteAt` becomes `now`
   * and `refreshAt` moves to 90 percent of the entry's TTL after it. Unknown prefixes are
   * ignored, the host may legitimately refresh a prefix the keeper already evicted.
   *
   * @param prefixKey - The prefix the host kept warm.
   * @param now - Milliseconds since the Unix epoch of the touch.
   */
  markRefreshed(prefixKey: string, now: number): void {
    const entry = this.entries.get(prefixKey);
    if (entry === undefined) {
      return;
    }
    const updated: RefreshEntry = {
      ...entry,
      lastWriteAt: now,
      refreshAt: now + REFRESH_FRACTION * ttlToMillis(entry.ttl),
    };
    this.entries.delete(prefixKey);
    this.entries.set(prefixKey, updated);
  }

  /**
   * Drops the entry for a prefix, used when the host abandons a cache or a resource
   * directive deletes it. Unknown prefixes are ignored.
   */
  remove(prefixKey: string): void {
    this.entries.delete(prefixKey);
  }

  /**
   * Serializes every entry, least-recently-tracked first. Pure JSON data, round-trips
   * through {@link TtlKeeper.fromJSON}.
   */
  toJSON(): TtlKeeperJSON {
    return { capacity: this.capacity, entries: [...this.entries.values()] };
  }

  /**
   * Rebuilds a keeper from {@link TtlKeeper.toJSON} output, restoring entries and their
   * recency order.
   *
   * @param json - A previously serialized keeper.
   */
  static fromJSON(json: TtlKeeperJSON): TtlKeeper {
    const keeper = new TtlKeeper(json.capacity);
    for (const entry of json.entries) {
      keeper.entries.set(entry.prefixKey, entry);
    }
    return keeper;
  }
}
