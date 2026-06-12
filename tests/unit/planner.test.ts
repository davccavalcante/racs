/**
 * Unit tests for the Planner directive mapping, one block per adapter family.
 *
 * Analyses are hand-built with explicit token counts so every break-even figure asserted
 * here is hand-computed from the profile multipliers, never recomputed from the
 * implementation. Anthropic numbers used below: write 1.25x (5m) and 2x (1h), read 0.1x,
 * minimum 1024 tokens, at most 4 breakpoints.
 */

import { describe, expect, it } from 'vitest';
import type { PlanAnalysis } from '../../src/plan/Planner.js';
import { Planner } from '../../src/plan/Planner.js';
import { resolveProfile } from '../../src/providers/profiles.js';
import type {
  CacheDirective,
  ExpectedReuse,
  PlanInput,
  Pricing,
  PromptSegment,
  ProviderId,
  ProviderProfile,
  SegmentRole,
  Stability,
} from '../../src/types.js';

const planner = new Planner();
const PREFIX_KEY = 'feedfacefeedface';

function seg(id: string, role: SegmentRole, stability: Stability, tokens: number): PromptSegment {
  return { id, role, stability, contentHash: `hash-${id}`, tokens };
}

function inputFor(
  provider: ProviderId,
  segments: readonly PromptSegment[],
  reuse?: ExpectedReuse,
): PlanInput {
  return {
    provider,
    model: 'model-under-test',
    segments,
    ...(reuse !== undefined ? { reuse } : {}),
  };
}

/** Hand-built analysis, the numbers are stated by the test, not derived. */
function analysisOf(stableTokens: number, totalTokens: number, boundary: number): PlanAnalysis {
  return { findings: [], stableTokens, totalTokens, orderedStableBoundary: boundary };
}

function at<T>(items: readonly T[], index: number): T {
  const item = items[index];
  if (item === undefined) {
    throw new Error(`expected an element at index ${index}`);
  }
  return item;
}

function asKind<K extends CacheDirective['kind']>(
  directive: CacheDirective,
  kind: K,
): Extract<CacheDirective, { kind: K }> {
  if (directive.kind !== kind) {
    throw new Error(`expected a '${kind}' directive, got '${directive.kind}'`);
  }
  return directive as Extract<CacheDirective, { kind: K }>;
}

describe('breakpoint family', () => {
  const anthropic = resolveProfile('anthropic');

  it('always marks the deepest stable boundary, then fills slots in role-weight order', () => {
    // Six stable spans, only four breakpoint slots. The deepest span (hist-b) is forced
    // because the LAST marker determines left-anchored coverage; the remaining three
    // slots go by role weight, tools over system over documents over history, with the
    // larger doc-a beating doc-b inside the documents role. The winners are emitted in
    // request order.
    const segments = [
      seg('sys', 'system', 'stable', 600),
      seg('tools', 'tools', 'stable', 500),
      seg('doc-a', 'documents', 'stable', 400),
      seg('hist-a', 'history', 'stable', 300),
      seg('doc-b', 'documents', 'stable', 200),
      seg('hist-b', 'history', 'stable', 100),
    ];
    const result = planner.plan(
      inputFor('anthropic', segments),
      anthropic,
      analysisOf(2100, 2100, 6),
      PREFIX_KEY,
    );
    expect(result.directives).toHaveLength(4);
    const ids = result.directives.map((directive) => asKind(directive, 'breakpoint').segmentId);
    expect(ids).toEqual(['sys', 'tools', 'doc-a', 'hist-b']);
    for (const directive of result.directives) {
      expect(asKind(directive, 'breakpoint').ttl).toBe('5m');
    }
    // Coverage runs to the forced deepest marker, so all 2100 stable tokens are covered
    // and the reasoning must say so honestly.
    expect(result.reasoning).toContain("deepest stable boundary 'hist-b'");
    expect(result.reasoning).toContain('covering 2100 of 2100 prompt tokens');
    // Hand math at 2100 covered tokens on the 5m tier: premium 2100 * 0.25 = 525 tokens,
    // each reuse recovers 2100 * 0.9 = 1890, so ceil(525 / 1890) = 1 reuse repays it.
    expect(result.breakEven).toBeDefined();
    expect(result.breakEven?.writePremiumTokens).toBe(525);
    expect(result.breakEven?.minReusesToProfit).toBe(1);
    expect(result.breakEven?.profitable).toBe(true);
  });

  it('budget 1 puts the single marker on the deepest boundary, not the heaviest role', () => {
    // The council probe: a small tools span ahead of a huge stable system span, with a
    // single breakpoint slot. Role weight alone would mark 'tools' and cover only 1100
    // of 51100 stable tokens while claiming full coverage; the forced deepest boundary
    // makes the single marker land at 'sys' so coverage and economics price the full
    // 51100 honestly.
    const budgetOne: ProviderProfile = { ...anthropic, maxBreakpoints: 1 };
    const segments = [
      seg('tools', 'tools', 'stable', 1100),
      seg('sys', 'system', 'stable', 50_000),
      seg('turn', 'dynamic', 'volatile', 100),
    ];
    const result = planner.plan(
      inputFor('anthropic', segments),
      budgetOne,
      analysisOf(51_100, 51_200, 2),
      PREFIX_KEY,
    );
    expect(result.directives).toHaveLength(1);
    expect(asKind(at(result.directives, 0), 'breakpoint').segmentId).toBe('sys');
    expect(result.reasoning).toContain('covering 51100 of 51200 prompt tokens');
    // Hand math: premium on the COVERED 51100 tokens at the 5m tier is
    // 51100 * 0.25 = 12775 base-token equivalents.
    expect(result.breakEven?.writePremiumTokens).toBe(12775);
  });

  it('never places a marker after a volatile segment', () => {
    const segments = [
      seg('sys', 'system', 'stable', 1500),
      seg('live', 'dynamic', 'volatile', 100),
      seg('docs', 'documents', 'stable', 800),
    ];
    const result = planner.plan(
      inputFor('anthropic', segments),
      anthropic,
      analysisOf(1500, 2400, 1),
      PREFIX_KEY,
    );
    expect(result.directives).toHaveLength(1);
    expect(asKind(at(result.directives, 0), 'breakpoint').segmentId).toBe('sys');
  });

  it('refuses a leading volatile segment and lints breakpoint-after-volatile', () => {
    // A minimum-free breakpoint profile, so the volatile-first guard itself is reached
    // instead of the below-minimum gate (every shipped breakpoint profile, hermes
    // included, now carries the 1024-token Anthropic minimum).
    const noMinimum: ProviderProfile = {
      id: 'custom',
      family: 'breakpoint',
      maxBreakpoints: 4,
      ttls: ['5m', '1h'],
      writeMultiplier5m: 1.25,
      writeMultiplier1h: 2,
      readMultiplier: 0.1,
    };
    const segments = [seg('live', 'dynamic', 'volatile', 100), seg('sys', 'system', 'stable', 900)];
    const result = planner.plan(
      inputFor('custom', segments),
      noMinimum,
      analysisOf(0, 1000, 0),
      PREFIX_KEY,
    );
    expect(asKind(at(result.directives, 0), 'none').reason).toContain('volatile');
    expect(result.extraFindings).toHaveLength(1);
    const finding = at(result.extraFindings, 0);
    expect(finding.code).toBe('breakpoint-after-volatile');
    expect(finding.severity).toBe('error');
    expect(finding.segmentId).toBe('live');
  });

  it('selects the 5m tier for a 120s reuse interval', () => {
    const segments = [seg('sys', 'system', 'stable', 2000)];
    const result = planner.plan(
      inputFor('anthropic', segments, { intervalSeconds: 120 }),
      anthropic,
      analysisOf(2000, 2000, 1),
      PREFIX_KEY,
    );
    expect(asKind(at(result.directives, 0), 'breakpoint').ttl).toBe('5m');
  });

  it('selects the 1h tier for an 1800s reuse interval', () => {
    const segments = [seg('sys', 'system', 'stable', 2000)];
    const result = planner.plan(
      inputFor('anthropic', segments, { intervalSeconds: 1800 }),
      anthropic,
      analysisOf(2000, 2000, 1),
      PREFIX_KEY,
    );
    expect(asKind(at(result.directives, 0), 'breakpoint').ttl).toBe('1h');
  });

  it('emits none plus the premium trap when reuse outruns every tier', () => {
    // 0.5 calls per hour is one reuse every 7200s, past the widest 1h window. Without a
    // read multiplier the planner cannot price keep-warm touches, so it declines AND
    // names the trap: any write here would never be repaid.
    const noReadMultiplier: ProviderProfile = {
      id: 'custom',
      family: 'breakpoint',
      maxBreakpoints: 4,
      ttls: ['5m', '1h'],
      writeMultiplier5m: 1.25,
      writeMultiplier1h: 2,
    };
    const segments = [seg('sys', 'system', 'stable', 2000)];
    const result = planner.plan(
      inputFor('custom', segments, { callsPerHour: 0.5 }),
      noReadMultiplier,
      analysisOf(2000, 2000, 1),
      PREFIX_KEY,
    );
    expect(asKind(at(result.directives, 0), 'none').reason).toContain('exceeds provider TTL');
    expect(result.reasoning).toContain('7200');
    const trap = result.extraFindings.find((finding) => finding.code === 'write-premium-trap');
    expect(trap).toBeDefined();
    expect(trap?.severity).toBe('warning');
  });

  it('keeps the 1h tier warm at 7200s reuse on anthropic with consistent touch-cost economics', () => {
    // With the 0.1 read multiplier one keep-warm touch per hour costs less than the 0.9
    // base-token equivalents per token that 0.5 calls per hour save, so the 1h tier stays
    // on, and the break-even now uses the SAME touch-cost model that justified keeping
    // it. Hand math at 2000 stable tokens: premium 2000 * (2 - 1) = 2000, each reuse
    // recovers 2000 * 0.9 = 1800 and carries (1 touch per hour / 0.5 calls per hour) *
    // 2000 * 0.1 = 400 of touch costs, netting 1400, so ceil(2000 / 1400) = 2 reuses
    // repay the single write and the kept tier is profitable, no trap.
    const segments = [seg('sys', 'system', 'stable', 2000)];
    const result = planner.plan(
      inputFor('anthropic', segments, { intervalSeconds: 7200 }),
      anthropic,
      analysisOf(2000, 2000, 1),
      PREFIX_KEY,
    );
    expect(asKind(at(result.directives, 0), 'breakpoint').ttl).toBe('1h');
    expect(result.breakEven?.writePremiumTokens).toBe(2000);
    expect(result.breakEven?.minReusesToProfit).toBe(2);
    expect(result.breakEven?.profitable).toBe(true);
    expect(result.reasoning).toContain('refresh-keeping profitable');
    expect(result.extraFindings).toEqual([]);
  });

  it('models refresh-on-use inside the 1h window: 2400s and 3300s reuse are profitable', () => {
    // Anthropic refreshes the TTL at no cost on every read, so reuse inside the window
    // keeps the cache alive indefinitely and the single premium is always repaid. Hand
    // math at 4000 stable tokens on the 1h tier: premium 4000 * (2 - 1) = 4000, each
    // reuse recovers 4000 * 0.9 = 3600, minReuses = ceil(4000 / 3600) = 2; at 2400s the
    // second repaying read arrives at 4800s, at 3300s at 6600s, both within the
    // refresh-extended lifetime, so both plans are profitable with zero trap findings.
    const segments = [seg('sys', 'system', 'stable', 4000)];
    for (const intervalSeconds of [2400, 3300]) {
      const result = planner.plan(
        inputFor('anthropic', segments, { intervalSeconds }),
        anthropic,
        analysisOf(4000, 4000, 1),
        PREFIX_KEY,
      );
      expect(asKind(at(result.directives, 0), 'breakpoint').ttl).toBe('1h');
      expect(result.breakEven?.writePremiumTokens).toBe(4000);
      expect(result.breakEven?.minReusesToProfit).toBe(2);
      expect(result.breakEven?.profitable).toBe(true);
      expect(
        result.extraFindings.filter((finding) => finding.code === 'write-premium-trap'),
      ).toEqual([]);
    }
  });

  it('emits none plus reasoning below the provider minimum, with no break-even', () => {
    const segments = [seg('sys', 'system', 'stable', 800)];
    const result = planner.plan(
      inputFor('anthropic', segments),
      anthropic,
      analysisOf(800, 800, 1),
      PREFIX_KEY,
    );
    const none = asKind(at(result.directives, 0), 'none');
    expect(none.reason).toContain('below the provider minimum');
    expect(result.reasoning).toContain('800');
    expect(result.reasoning).toContain('1024');
    expect(result.breakEven).toBeUndefined();
  });

  it('hermes mirrors the anthropic 1024-token minimum: a 200-token plan is none', () => {
    // hermes rides Anthropic cache_control semantics, so a 200-token stable prefix sits
    // below the same 1024-token minimum and the plan is identical to the anthropic one.
    const hermes = resolveProfile('hermes');
    const segments = [seg('sys', 'system', 'stable', 200)];
    const analysis = analysisOf(200, 200, 1);
    const hermesResult = planner.plan(inputFor('hermes', segments), hermes, analysis, PREFIX_KEY);
    const anthropicResult = planner.plan(
      inputFor('anthropic', segments),
      anthropic,
      analysis,
      PREFIX_KEY,
    );
    const none = asKind(at(hermesResult.directives, 0), 'none');
    expect(none.reason).toContain('below the provider minimum of 1024');
    expect(hermesResult.directives).toEqual(anthropicResult.directives);
    expect(hermesResult.breakEven).toBeUndefined();
  });

  it('computes the exact break-even for 4000 stable tokens at 1.25/0.1', () => {
    // Hand math: writePremiumTokens = 4000 * (1.25 - 1) = 1000, each reuse recovers
    // 4000 * (1 - 0.1) = 3600, minReusesToProfit = ceil(1000 / 3600) = 1, and the single
    // assumed reuse makes the plan profitable.
    const segments = [seg('sys', 'system', 'stable', 4000)];
    const result = planner.plan(
      inputFor('anthropic', segments),
      anthropic,
      analysisOf(4000, 4000, 1),
      PREFIX_KEY,
    );
    expect(result.breakEven).toBeDefined();
    expect(result.breakEven?.writePremiumTokens).toBe(1000);
    expect(result.breakEven?.minReusesToProfit).toBe(1);
    expect(result.breakEven?.profitable).toBe(true);
  });
});

describe('routing-key family', () => {
  const openai = resolveProfile('openai');
  const segments = [seg('sys', 'system', 'stable', 2000)];

  it('emits the prefix key it was handed, verbatim', () => {
    const result = planner.plan(
      inputFor('openai', segments),
      openai,
      analysisOf(2000, 2000, 1),
      PREFIX_KEY,
    );
    expect(result.directives).toHaveLength(1);
    const directive = asKind(at(result.directives, 0), 'routing-key');
    expect(directive.key).toBe(PREFIX_KEY);
    expect(directive.retention).toBeUndefined();
  });

  it('requests 24h retention when supported and the interval exceeds 3600s', () => {
    const result = planner.plan(
      inputFor('openai', segments, { intervalSeconds: 7200 }),
      openai,
      analysisOf(2000, 2000, 1),
      PREFIX_KEY,
    );
    expect(asKind(at(result.directives, 0), 'routing-key').retention).toBe('24h');
  });

  it('does not request retention at exactly 3600s', () => {
    const result = planner.plan(
      inputFor('openai', segments, { intervalSeconds: 3600 }),
      openai,
      analysisOf(2000, 2000, 1),
      PREFIX_KEY,
    );
    expect(asKind(at(result.directives, 0), 'routing-key').retention).toBeUndefined();
  });

  it('does not request retention when the profile lacks the tier', () => {
    const mistral = resolveProfile('mistral');
    const result = planner.plan(
      inputFor('mistral', segments, { intervalSeconds: 7200 }),
      mistral,
      analysisOf(2000, 2000, 1),
      PREFIX_KEY,
    );
    expect(asKind(at(result.directives, 0), 'routing-key').retention).toBeUndefined();
  });
});

describe('resource family', () => {
  const google = resolveProfile('google');
  const segments = [seg('kb', 'documents', 'stable', 100_000)];
  const analysis = analysisOf(100_000, 100_000, 1);

  it('creates the resource on first sight and reuses it when known', () => {
    const created = planner.plan(
      inputFor('google', segments, { intervalSeconds: 600 }),
      google,
      analysis,
      PREFIX_KEY,
    );
    const createDirective = asKind(at(created.directives, 0), 'resource');
    expect(createDirective.action).toBe('create');
    expect(createDirective.resourceKey).toBe(PREFIX_KEY);

    const reused = planner.plan(
      inputFor('google', segments, { intervalSeconds: 600 }),
      google,
      analysis,
      PREFIX_KEY,
      undefined,
      true,
    );
    expect(asKind(at(reused.directives, 0), 'resource').action).toBe('reuse');
  });

  it('clamps ttlSeconds to four reuse intervals within [300, 3600]', () => {
    // Hand-computed clamps: 30 * 4 = 120 floors at 300, 600 * 4 = 2400 passes through,
    // 2000 * 4 = 8000 ceils at 3600, and no declared reuse defaults to 3600.
    const cases: ReadonlyArray<{ interval?: number; expected: number }> = [
      { interval: 30, expected: 300 },
      { interval: 600, expected: 2400 },
      { interval: 2000, expected: 3600 },
      { expected: 3600 },
    ];
    for (const { interval, expected } of cases) {
      const result = planner.plan(
        inputFor(
          'google',
          segments,
          interval === undefined ? undefined : { intervalSeconds: interval },
        ),
        google,
        analysis,
        PREFIX_KEY,
      );
      expect(asKind(at(result.directives, 0), 'resource').ttlSeconds).toBe(expected);
    }
  });

  it('declines the storage trap at 0.5 calls per hour, naming storage', () => {
    // Google storage is 1.0 USD per MTok-hour. Hand math at 100000 resident tokens with
    // input 5 and cache read 0.5 USD per MTok: storage 0.1 USD per hour, each cached
    // read saves 0.45 USD, ceil(0.1 / 0.45) = 1 reuse per hour breaks even, 0.5 falls
    // short, so no resource is worth keeping alive.
    const pricing: Pricing = { inputPerMTok: 5, cacheReadPerMTok: 0.5 };
    const result = planner.plan(
      inputFor('google', segments, { callsPerHour: 0.5 }),
      google,
      analysis,
      PREFIX_KEY,
      pricing,
    );
    expect(asKind(at(result.directives, 0), 'none').reason).toContain('storage');
    expect(result.breakEven?.minReusesToProfit).toBe(1);
    expect(result.breakEven?.profitable).toBe(false);
    const trap = result.extraFindings.find((finding) => finding.code === 'write-premium-trap');
    expect(trap).toBeDefined();
    expect(trap?.severity).toBe('warning');
  });
});

describe('passive family', () => {
  it('emits none with the analytics reasoning', () => {
    const groq = resolveProfile('groq');
    const segments = [seg('sys', 'system', 'stable', 2000)];
    const result = planner.plan(
      inputFor('groq', segments),
      groq,
      analysisOf(2000, 2000, 1),
      PREFIX_KEY,
    );
    expect(result.directives).toHaveLength(1);
    const none = asKind(at(result.directives, 0), 'none');
    expect(none.reason).toContain('analytics');
    expect(result.reasoning).toContain('no cache control surface');
    expect(result.extraFindings).toEqual([]);
  });
});
