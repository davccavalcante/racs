/**
 * Unit tests for the deterministic hashing and token estimation primitives.
 *
 * Every expected value is hand-computed: the FNV-1a 64-bit offset basis for the empty
 * string, ceil(length / 4) for token estimates, and structural properties (shape,
 * distinctness, order sensitivity, separator safety) where a full digest is opaque.
 */

import { describe, expect, it } from 'vitest';
import { combineKeys, fnv1a64, shortId } from '../../src/stats/hash.js';
import { estimateTokens, tokensOf } from '../../src/stats/tokens.js';

/** Local deterministic float generator in [0, 1), the global random source stays unused. */
function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe('fnv1a64', () => {
  it('hashes the empty string to the FNV-1a 64-bit offset basis', () => {
    // With zero input units the loop never runs, so the digest is the published offset
    // basis 0xcbf29ce484222325 rendered as 16 lowercase hex characters.
    expect(fnv1a64('')).toBe('cbf29ce484222325');
  });

  it('is deterministic, the same input always yields the same digest', () => {
    expect(fnv1a64('racs')).toBe(fnv1a64('racs'));
    expect(fnv1a64('system prompt v3')).toBe(fnv1a64('system prompt v3'));
  });

  it('always returns exactly 16 lowercase hex characters', () => {
    const samples = ['', 'a', 'racs', 'x'.repeat(1000), '\u001f', '\u00e9\u4e16\u754c'];
    for (const text of samples) {
      expect(fnv1a64(text)).toMatch(/^[0-9a-f]{16}$/);
    }
  });

  it('maps 200 distinct seeded inputs to 200 distinct digests', () => {
    const random = mulberry32(7);
    const inputs: string[] = [];
    for (let index = 0; index < 200; index += 1) {
      // The index prefix guarantees input distinctness, the seeded suffix adds variety.
      inputs.push(`sample-${index}-${Math.floor(random() * 1e9).toString(36)}`);
    }
    expect(new Set(inputs).size).toBe(200);
    const digests = new Set(inputs.map((text) => fnv1a64(text)));
    expect(digests.size).toBe(200);
  });
});

describe('combineKeys', () => {
  it('is order-sensitive', () => {
    expect(combineKeys(['alpha', 'beta'])).not.toBe(combineKeys(['beta', 'alpha']));
  });

  it('keeps part boundaries, ["ab","c"] and ["a","bc"] do not collide', () => {
    expect(combineKeys(['ab', 'c'])).not.toBe(combineKeys(['a', 'bc']));
  });

  it('hashes a single part exactly like fnv1a64 of that part', () => {
    // Joining one part with any separator is the part itself, so the digests must match.
    expect(combineKeys(['ab'])).toBe(fnv1a64('ab'));
  });

  it('differs from the plain concatenation digest because the separator contributes', () => {
    expect(combineKeys(['ab', 'c'])).not.toBe(fnv1a64('abc'));
  });

  it('preserves empty parts, ["", "x"] and ["x"] differ', () => {
    expect(combineKeys(['', 'x'])).not.toBe(combineKeys(['x']));
  });
});

describe('shortId', () => {
  it('is deterministic per (counter, salt) pair', () => {
    expect(shortId(1, 'seed-7')).toBe(shortId(1, 'seed-7'));
    expect(shortId(42, 'engine')).toBe(shortId(42, 'engine'));
  });

  it('changes when the counter changes', () => {
    expect(shortId(1, 'seed-7')).not.toBe(shortId(2, 'seed-7'));
  });

  it('changes when the salt changes', () => {
    expect(shortId(1, 'seed-7')).not.toBe(shortId(1, 'seed-8'));
  });

  it('emits 1 to 13 lowercase base36 characters', () => {
    for (const counter of [0, 1, 2, 999, 1_000_000]) {
      expect(shortId(counter, 'salt')).toMatch(/^[0-9a-z]{1,13}$/);
    }
  });
});

describe('estimateTokens', () => {
  it('returns 0 for the empty string', () => {
    expect(estimateTokens('')).toBe(0);
  });

  it('returns ceil(length / 4) exactly', () => {
    // Hand-computed: 1/4 -> 1, 3/4 -> 1, 4/4 -> 1, 5/4 -> 2, 8/4 -> 2, 9/4 -> 3.
    expect(estimateTokens('a')).toBe(1);
    expect(estimateTokens('abc')).toBe(1);
    expect(estimateTokens('abcd')).toBe(1);
    expect(estimateTokens('abcde')).toBe(2);
    expect(estimateTokens('abcdefgh')).toBe(2);
    expect(estimateTokens('abcdefghi')).toBe(3);
    // 4096/4 = 1024 and 4097/4 ceils to 1025.
    expect(estimateTokens('x'.repeat(4096))).toBe(1024);
    expect(estimateTokens('x'.repeat(4097))).toBe(1025);
  });
});

describe('tokensOf', () => {
  it('prefers an explicit tokens field over the content estimate', () => {
    // The estimate for 8 characters would be 2, the explicit count must win.
    expect(tokensOf({ content: 'abcdefgh', tokens: 99 })).toBe(99);
  });

  it('respects an explicit zero token count', () => {
    expect(tokensOf({ content: 'abcdefgh', tokens: 0 })).toBe(0);
  });

  it('falls back to the ceil(length / 4) estimate when only content exists', () => {
    expect(tokensOf({ content: 'abcdefghi' })).toBe(3);
  });

  it('returns 0 when neither tokens nor content is present', () => {
    expect(tokensOf({})).toBe(0);
  });
});
