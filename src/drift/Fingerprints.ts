/**
 * Drift detection of RACS (Remote Agent Context Store): per-lineage fingerprints of plan
 * segment hashes, compared across consecutive plans to catch the silent cache killer, a
 * "stable" prefix that quietly changed and invalidated every cached token after the change.
 *
 * Fingerprints hold segment ids, content hashes, and declared stabilities only, never
 * prompt content, so serialized fingerprints leak nothing.
 *
 * @packageDocumentation
 */

import type { DriftReport, PlanInput, Stability } from '../types.js';

/** Hash and declared stability of one segment at observation time. */
interface SegmentFingerprint {
  hash: string;
  stability: Stability;
}

/** Everything remembered about the latest plan of one lineage. */
interface LineageRecord {
  prefixKey: string;
  /** Token count of the stable prefix behind `prefixKey`, reported on later drift. */
  tokens: number;
  segments: Map<string, SegmentFingerprint>;
}

/** One serialized segment fingerprint, see {@link FingerprintsJSON}. */
export interface FingerprintSegmentJSON {
  /** Segment id, see {@link PlanInput} segment identity rules. */
  readonly id: string;
  /** Caller- or engine-computed content hash observed for the segment. */
  readonly hash: string;
  /** Stability the segment was declared with at observation time. */
  readonly stability: Stability;
}

/** One serialized lineage record, see {@link FingerprintsJSON}. */
export interface FingerprintEntryJSON {
  /** Lineage key: `agentId` when given, otherwise `provider:model`. */
  readonly key: string;
  /** Prefix key the lineage produced last. */
  readonly prefixKey: string;
  /** Token count of the stable prefix behind that key. */
  readonly tokens: number;
  /** Segment fingerprints of the last observed plan. */
  readonly segments: readonly FingerprintSegmentJSON[];
}

/**
 * Serialized fingerprint state, produced by {@link Fingerprints.toJSON} and consumed by
 * {@link Fingerprints.fromJSON}. Entries are ordered least-recently-observed first, so a
 * round trip preserves eviction order exactly.
 */
export interface FingerprintsJSON {
  /** The eviction cap the store was running with. */
  readonly capacity: number;
  /** Lineage records, least-recently-observed first. */
  readonly entries: readonly FingerprintEntryJSON[];
}

/**
 * Bounded, LRU-evicting store of per-lineage plan fingerprints.
 *
 * Lineage key: `agentId` when the input carries one, otherwise the `provider:model` pair,
 * matching the drift contract on {@link DriftReport}, the same agent and model lineage is
 * compared against itself across plans.
 *
 * Change semantics: only stable and semi segments count. A volatile segment is DECLARED to
 * differ on every call, so its churn, including its appearance or disappearance, is
 * expected behavior and never drift. For a segment present in both plans the current
 * declaration decides, a segment the caller re-declared volatile has opted out of drift
 * tracking from that plan onward. For a removed segment only the previous declaration
 * exists and is used.
 */
export class Fingerprints {
  private readonly capacity: number;
  /** Map iteration order doubles as recency order, oldest lineage first. */
  private readonly records = new Map<string, LineageRecord>();

  /**
   * @param capacity - Cap on distinct tracked lineages before LRU eviction.
   */
  constructor(capacity = 1000) {
    this.capacity = capacity;
  }

  /**
   * Records the fingerprint of one plan and compares it with the previous plan of the same
   * lineage.
   *
   * @param input - The plan input, provides the lineage key and segment stabilities.
   * @param prefixKey - Deterministic prefix key the plan produced.
   * @param segmentHashes - Segment id to content hash, as the planner derived them.
   * @param totalTokens - Token count of the stable prefix behind `prefixKey`. Stored, and
   *   reported as `invalidatedTokens` if a later plan drifts to a different key, because
   *   those are exactly the previously cached tokens the drift killed.
   * @param now - Milliseconds since the Unix epoch, from the injected engine clock.
   * @returns `undefined` on the first observation of a lineage and when nothing relevant
   *   changed. Otherwise a {@link DriftReport} naming the changed, added, or removed
   *   stable and semi segments, with `invalidatedTokens` equal to the previous stable
   *   prefix size when the prefix key changed, and zero when the key survived.
   */
  observe(
    input: PlanInput,
    prefixKey: string,
    segmentHashes: ReadonlyMap<string, string>,
    totalTokens: number,
    now: number,
  ): DriftReport | undefined {
    const key = input.agentId ?? `${input.provider}:${input.model}`;

    const stabilityOf = new Map<string, Stability>();
    for (const segment of input.segments) {
      stabilityOf.set(segment.id, segment.stability);
    }
    const next = new Map<string, SegmentFingerprint>();
    for (const [id, hash] of segmentHashes) {
      // A hash without a matching segment declaration cannot prove instability, so it is
      // treated as volatile and excluded from drift rather than reported on a guess.
      next.set(id, { hash, stability: stabilityOf.get(id) ?? 'volatile' });
    }

    const previous = this.records.get(key);
    // Delete-then-set keeps Map iteration order as recency order for LRU eviction.
    this.records.delete(key);
    this.records.set(key, { prefixKey, tokens: totalTokens, segments: next });
    if (this.records.size > this.capacity) {
      const oldest = this.records.keys().next();
      if (!oldest.done) {
        this.records.delete(oldest.value);
      }
    }

    if (previous === undefined) {
      return undefined;
    }

    const changed = new Set<string>();
    for (const [id, fingerprint] of next) {
      if (fingerprint.stability === 'volatile') {
        continue;
      }
      const before = previous.segments.get(id);
      if (before === undefined || before.hash !== fingerprint.hash) {
        changed.add(id);
      }
    }
    for (const [id, fingerprint] of previous.segments) {
      if (!next.has(id) && fingerprint.stability !== 'volatile') {
        changed.add(id);
      }
    }

    if (changed.size === 0 && prefixKey === previous.prefixKey) {
      return undefined;
    }
    return {
      ...(input.agentId !== undefined ? { agentId: input.agentId } : {}),
      prefixKey,
      previousKey: previous.prefixKey,
      changedSegmentIds: [...changed].sort(),
      invalidatedTokens: prefixKey === previous.prefixKey ? 0 : previous.tokens,
      timestamp: now,
    };
  }

  /**
   * Removes every lineage record whose latest prefix key satisfies `predicate` and returns
   * the distinct prefix keys removed. Engine-level invalidation calls this when the host
   * clears prefixes, for example on credential rotation: a removed lineage simply restarts
   * drift tracking at its next plan, and first observations never report drift.
   */
  prune(predicate: (prefixKey: string) => boolean): readonly string[] {
    const removed = new Set<string>();
    for (const [key, record] of [...this.records]) {
      if (predicate(record.prefixKey)) {
        this.records.delete(key);
        removed.add(record.prefixKey);
      }
    }
    return [...removed];
  }

  /**
   * Serializes every lineage record, least-recently-observed first. Pure JSON data, no
   * prompt content, round-trips through {@link Fingerprints.fromJSON}.
   */
  toJSON(): FingerprintsJSON {
    const entries: FingerprintEntryJSON[] = [];
    for (const [key, record] of this.records) {
      const segments: FingerprintSegmentJSON[] = [];
      for (const [id, fingerprint] of record.segments) {
        segments.push({ id, hash: fingerprint.hash, stability: fingerprint.stability });
      }
      entries.push({ key, prefixKey: record.prefixKey, tokens: record.tokens, segments });
    }
    return { capacity: this.capacity, entries };
  }

  /**
   * Rebuilds a fingerprint store from {@link Fingerprints.toJSON} output, restoring
   * lineage records, their segment maps, and their recency order.
   *
   * @param json - A previously serialized store.
   */
  static fromJSON(json: FingerprintsJSON): Fingerprints {
    const store = new Fingerprints(json.capacity);
    for (const entry of json.entries) {
      const segments = new Map<string, SegmentFingerprint>();
      for (const segment of entry.segments) {
        segments.set(segment.id, { hash: segment.hash, stability: segment.stability });
      }
      store.records.set(entry.key, {
        prefixKey: entry.prefixKey,
        tokens: entry.tokens,
        segments,
      });
    }
    return store;
  }
}
