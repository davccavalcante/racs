/**
 * Unit tests for the usage Ledger: hit-ratio definition, USD savings and write premium
 * math, pricing coverage rules, per-prefix aggregation, LRU eviction, and serialization.
 *
 * Every USD and ratio expectation is hand-computed from the documented formulas:
 * hitRatio = readTokens / (readTokens + writeTokens + uncachedTokens),
 * uncached per call = max(0, inputTokens - cacheReadTokens - writes of both tiers),
 * because CacheUsage.inputTokens is the ALL-IN billed input including reads and writes,
 * savedUsd = readTokens / 1e6 * (inputPerMTok - cacheReadPerMTok),
 * writeSpendUsd = sum over tiers of writeTokens / 1e6 * max(0, writePrice - inputPrice).
 */

import { describe, expect, it } from 'vitest';
import { Ledger } from '../../src/ledger/Ledger.js';
import type { CacheUsage, PricingTable, ProviderId } from '../../src/types.js';

function usage(
  model: string,
  inputTokens: number,
  cacheReadTokens: number,
  extra?: {
    prefixKey?: string;
    write5m?: number;
    write1h?: number;
    provider?: ProviderId;
  },
): CacheUsage {
  return {
    provider: extra?.provider ?? 'anthropic',
    model,
    inputTokens,
    cacheReadTokens,
    ...(extra?.prefixKey !== undefined ? { prefixKey: extra.prefixKey } : {}),
    ...(extra?.write5m !== undefined ? { cacheWriteTokens5m: extra.write5m } : {}),
    ...(extra?.write1h !== undefined ? { cacheWriteTokens1h: extra.write1h } : {}),
  };
}

describe('hit ratio', () => {
  it('computes readTokens / (read + write + uncached) over a 3-call stream', () => {
    const ledger = new Ledger();
    // Call 1 writes the cache: all-in input 2000 = 1000 uncached fresh input + a
    // 1000-token 5m write, so uncached = 2000 - 0 - 1000 = 1000.
    expect(ledger.record(usage('m', 2000, 0, { prefixKey: 'p', write5m: 1000 })).hit).toBe(false);
    // Call 2 reads 800 of 1000 all-in input tokens from cache, 200 stay uncached.
    expect(ledger.record(usage('m', 1000, 800, { prefixKey: 'p' })).hit).toBe(true);
    // Call 3 reads 600 of 1000, 400 uncached.
    expect(ledger.record(usage('m', 1000, 600, { prefixKey: 'p' })).hit).toBe(true);

    const stats = ledger.stats();
    // Hand-computed totals: read 1400, write 1000, uncached 1000 + 200 + 400 = 1600.
    expect(stats.calls).toBe(3);
    expect(stats.readTokens).toBe(1400);
    expect(stats.writeTokens).toBe(1000);
    expect(stats.uncachedTokens).toBe(1600);
    // hitRatio = 1400 / (1400 + 1000 + 1600) = 1400 / 4000 = 0.35.
    expect(stats.hitRatio).toBe(0.35);
  });

  it('subtracts cache writes from the uncached remainder under the all-in convention', () => {
    // The council workload: one write call of 4000 stable + 200 fresh, then nine read
    // calls of 4000 cached + 200 fresh, every inputTokens all-in at 4200.
    const ledger = new Ledger();
    ledger.record(usage('m', 4200, 0, { prefixKey: 'p', write5m: 4000 }));
    for (let call = 0; call < 9; call += 1) {
      ledger.record(usage('m', 4200, 4000, { prefixKey: 'p' }));
    }
    const stats = ledger.stats();
    // Hand-computed: read 9 * 4000 = 36000, write 4000, uncached 10 * 200 = 2000,
    // ground-truth hitRatio = 36000 / (36000 + 4000 + 2000) = 36000 / 42000 = 6/7.
    expect(stats.readTokens).toBe(36000);
    expect(stats.writeTokens).toBe(4000);
    expect(stats.uncachedTokens).toBe(2000);
    expect(Math.abs(stats.hitRatio - 6 / 7)).toBeLessThan(1e-9);
  });

  it('clamps the uncached remainder at zero when cached counts exceed billed input', () => {
    // A source reporting more cached traffic than billed input is a reporting artifact
    // that must not drive the aggregate negative.
    const ledger = new Ledger();
    ledger.record(usage('m', 100, 800, { prefixKey: 'p', write5m: 500 }));
    const stats = ledger.stats();
    expect(stats.uncachedTokens).toBe(0);
    // hitRatio = 800 / (800 + 500 + 0).
    expect(stats.hitRatio).toBe(800 / 1300);
  });

  it('reports a zero ratio on an empty ledger instead of dividing by zero', () => {
    expect(new Ledger().stats().hitRatio).toBe(0);
  });
});

describe('USD math', () => {
  it('computes savedUsd exactly: 1e6 read tokens at input 5 and read 0.5 saves 4.5', () => {
    const pricing: PricingTable = { m: { inputPerMTok: 5, cacheReadPerMTok: 0.5 } };
    const ledger = new Ledger(pricing);
    ledger.record(usage('m', 1_000_000, 1_000_000, { prefixKey: 'p' }));
    const stats = ledger.stats();
    // savedUsd = 1.0 MTok * (5 - 0.5) = 4.5 USD, and nothing was written so net equals it.
    expect(stats.savedUsd).toBe(4.5);
    expect(stats.netUsd).toBe(4.5);
  });

  it('computes the write premium for both TTL tiers', () => {
    const pricing: PricingTable = {
      m: {
        inputPerMTok: 5,
        cacheReadPerMTok: 0.5,
        cacheWrite5mPerMTok: 6.25,
        cacheWrite1hPerMTok: 10,
      },
    };
    const ledger = new Ledger(pricing);
    // All-in input 3 MTok = the two written tiers, nothing fresh and nothing read.
    ledger.record(
      usage('m', 3_000_000, 0, { prefixKey: 'p', write5m: 2_000_000, write1h: 1_000_000 }),
    );
    const stats = ledger.stats();
    // Premiums over base input: 2 MTok * (6.25 - 5) = 2.5 plus 1 MTok * (10 - 5) = 5.
    expect(stats.savedUsd).toBe(0);
    expect(stats.netUsd).toBe(-7.5);
    const prefix = stats.prefixes.find((entry) => entry.prefixKey === 'p');
    expect(prefix?.writeSpendUsd).toBe(7.5);
  });

  it('clamps a mispriced negative tier premium at zero', () => {
    // A write price below base input would make the premium negative and silently
    // inflate savings, so the tier term must clamp to zero.
    const pricing: PricingTable = {
      m: { inputPerMTok: 5, cacheReadPerMTok: 0.5, cacheWrite5mPerMTok: 4 },
    };
    const ledger = new Ledger(pricing);
    ledger.record(usage('m', 1_000_000, 0, { prefixKey: 'p', write5m: 1_000_000 }));
    const prefix = ledger.stats().prefixes.find((entry) => entry.prefixKey === 'p');
    expect(prefix?.writeSpendUsd).toBe(0);
  });

  it('omits every USD field for a model the pricing table does not cover', () => {
    const pricing: PricingTable = { priced: { inputPerMTok: 5, cacheReadPerMTok: 0.5 } };
    const ledger = new Ledger(pricing);
    ledger.record(usage('unpriced', 1000, 800, { prefixKey: 'p' }));
    const stats = ledger.stats();
    expect(stats).not.toHaveProperty('savedUsd');
    expect(stats).not.toHaveProperty('netUsd');
    const prefix = stats.prefixes.find((entry) => entry.prefixKey === 'p');
    expect(prefix).not.toHaveProperty('savedUsd');
    expect(prefix).not.toHaveProperty('writeSpendUsd');
    // Token statistics are always reported regardless of pricing coverage.
    expect(stats.readTokens).toBe(800);
  });
});

describe('per-prefix aggregation', () => {
  it('aggregates per prefix, keys plan-less usage by provider:model, and sorts output', () => {
    const ledger = new Ledger();
    ledger.record(usage('m', 1000, 0, { prefixKey: 'pb' }));
    ledger.record(usage('m', 1000, 500, { prefixKey: 'pa' }));
    ledger.record(usage('m', 1000, 250, { prefixKey: 'pa' }));
    ledger.record(usage('gpt', 400, 100, { provider: 'openai' }));

    const stats = ledger.stats();
    expect(stats.prefixes.map((entry) => entry.prefixKey)).toEqual(['openai:gpt', 'pa', 'pb']);

    const pa = stats.prefixes.find((entry) => entry.prefixKey === 'pa');
    // Hand-computed for pa: read 750, uncached 500 + 750 = 1250, ratio 750 / 2000.
    expect(pa?.calls).toBe(2);
    expect(pa?.readTokens).toBe(750);
    expect(pa?.uncachedTokens).toBe(1250);
    expect(pa?.hitRatio).toBe(0.375);

    const byPrefix = ledger.stats({ prefixKey: 'pa' });
    expect(byPrefix.calls).toBe(2);
    expect(byPrefix.prefixes.map((entry) => entry.prefixKey)).toEqual(['pa']);

    const byProvider = ledger.stats({ provider: 'openai' });
    expect(byProvider.calls).toBe(1);
    expect(byProvider.prefixes.map((entry) => entry.prefixKey)).toEqual(['openai:gpt']);
  });
});

describe('LRU eviction', () => {
  it('evicts the least-recently-used prefix at the cap, returning the evicted key', () => {
    const ledger = new Ledger(undefined, 2);
    expect(ledger.record(usage('m', 100, 0, { prefixKey: 'p1' })).evicted).toBeUndefined();
    expect(ledger.record(usage('m', 100, 0, { prefixKey: 'p2' })).evicted).toBeUndefined();
    // Touch p1 so p2 becomes the least recently used.
    expect(ledger.record(usage('m', 100, 0, { prefixKey: 'p1' })).evicted).toBeUndefined();
    const third = ledger.record(usage('m', 100, 0, { prefixKey: 'p3' }));
    expect(third.evicted).toBe('p2');
    expect(ledger.stats().prefixes.map((entry) => entry.prefixKey)).toEqual(['p1', 'p3']);
  });
});

describe('serialization', () => {
  it('round-trips through toJSON and fromJSON, preserving aggregates and order', () => {
    const pricing: PricingTable = { m: { inputPerMTok: 5, cacheReadPerMTok: 0.5 } };
    const ledger = new Ledger(pricing, 50);
    // All-in convention: the first call's 2000 input = 1000 fresh + the 1000-token write.
    ledger.record(usage('m', 2000, 0, { prefixKey: 'p1', write5m: 1000 }));
    ledger.record(usage('m', 1000, 800, { prefixKey: 'p2' }));
    ledger.record(usage('m', 1000, 600, { prefixKey: 'p1' }));

    const json = ledger.toJSON();
    expect(json.maxPrefixes).toBe(50);
    // p2 was touched before p1's second record, so p2 serializes first (LRU first).
    expect(json.entries.map((entry) => entry.key)).toEqual(['p2', 'p1']);

    const revived = Ledger.fromJSON(json, pricing);
    expect(revived.toJSON()).toEqual(json);
    expect(revived.stats()).toEqual(ledger.stats());
  });
});
