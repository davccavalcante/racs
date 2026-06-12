/**
 * The PERMANENT planning-quality benchmark of RACS: ten labeled scenarios with hard bounds
 * pinning provider-faithful planner behavior in CI forever. A regression on any bound must
 * fail this file. Every bound was calibrated by running the real engine, and every number
 * asserted is hand-computed in a comment next to its assertion.
 *
 * Determinism: every scenario runs on an injected simulated clock and a fixed seed, P10
 * spawns the CLI whose timeline is itself fully simulated. Nothing here reads the wall
 * clock or the global random generator.
 */

import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import type {
  CacheDirective,
  CachePlan,
  PlanInput,
  PricingTable,
  PromptSegment,
  RACS,
  SegmentRole,
  Stability,
  TelemetryEvent,
} from '../../src/index.js';
import { createRACS } from '../../src/index.js';

vi.setConfig({ testTimeout: 60_000 });

/** Fixed start of every simulated timeline, milliseconds since the Unix epoch. */
const BENCH_EPOCH_MS = 1_750_000_000_000;

/** One running scenario: the engine, its mutable timeline, and its telemetry capture. */
interface Scenario {
  readonly engine: RACS;
  readonly timeline: { now: number };
  readonly events: TelemetryEvent[];
}

/** Builds one engine on an injected simulated clock with a fixed seed. */
function scenario(options?: { seed?: number; pricing?: PricingTable }): Scenario {
  const timeline = { now: BENCH_EPOCH_MS };
  const engine = createRACS({
    seed: options?.seed ?? 7,
    clock: () => timeline.now,
    ...(options?.pricing !== undefined ? { pricing: options.pricing } : {}),
  });
  const events: TelemetryEvent[] = [];
  engine.on((event) => {
    events.push(event);
  });
  return { engine, timeline, events };
}

/** Shorthand for one hash-keyed segment with an explicit token count. */
function seg(
  id: string,
  role: SegmentRole,
  stability: Stability,
  tokens: number,
  hash: string,
): PromptSegment {
  return { id, role, stability, contentHash: hash, tokens };
}

/** The directive at `index`, throwing instead of returning undefined under strict mode. */
function directiveAt(plan: CachePlan, index: number): CacheDirective {
  const directive = plan.directives[index];
  if (directive === undefined) {
    throw new Error(`plan ${plan.planId} has no directive at index ${index}`);
  }
  return directive;
}

/** Narrows to the 'none' directive kind or fails loudly. */
function asNone(directive: CacheDirective): Extract<CacheDirective, { kind: 'none' }> {
  if (directive.kind !== 'none') {
    throw new Error(`expected a 'none' directive, got '${directive.kind}'`);
  }
  return directive;
}

/** Narrows to the 'breakpoint' directive kind or fails loudly. */
function asBreakpoint(directive: CacheDirective): Extract<CacheDirective, { kind: 'breakpoint' }> {
  if (directive.kind !== 'breakpoint') {
    throw new Error(`expected a 'breakpoint' directive, got '${directive.kind}'`);
  }
  return directive;
}

/** Narrows to the 'routing-key' directive kind or fails loudly. */
function asRoutingKey(directive: CacheDirective): Extract<CacheDirective, { kind: 'routing-key' }> {
  if (directive.kind !== 'routing-key') {
    throw new Error(`expected a 'routing-key' directive, got '${directive.kind}'`);
  }
  return directive;
}

describe('planning-quality benchmark', () => {
  it('P1 breakpoint-fidelity: exactly 4 breakpoints on sys, tools, kb, kb2 in role-weight order, none after the volatile tail', () => {
    const { engine } = scenario();
    // Six segments, five stable spans competing for 4 anthropic breakpoint slots. The
    // deepest stable span (kb2, ending the left-anchored prefix) is ALWAYS marked because
    // the last marker determines actual coverage; the remaining 3 slots go by role
    // weight, tools(4) > system(3) > documents(2) > history(1), so the history span is
    // the one dropped, and the volatile tail can never carry a marker. Coverage therefore
    // honestly reaches all 5000 stable tokens up to the kb2 marker.
    const plan = engine.plan({
      provider: 'anthropic',
      model: 'claude-sonnet-4-5',
      segments: [
        seg('sys', 'system', 'stable', 1200, 'sys-v1'),
        seg('tools', 'tools', 'stable', 1100, 'tools-v1'),
        seg('kb', 'documents', 'stable', 1000, 'kb-v1'),
        seg('hist', 'history', 'stable', 900, 'hist-v1'),
        seg('kb2', 'documents', 'semi', 800, 'kb2-v1'),
        seg('turn', 'dynamic', 'volatile', 100, 'turn-1'),
      ],
      reuse: { intervalSeconds: 60 },
    });
    expect(plan.findings).toEqual([]);
    // Chosen spans re-sorted into request order for application: sys, tools, kb, kb2.
    expect(plan.directives).toEqual([
      { kind: 'breakpoint', segmentId: 'sys', ttl: '5m' },
      { kind: 'breakpoint', segmentId: 'tools', ttl: '5m' },
      { kind: 'breakpoint', segmentId: 'kb', ttl: '5m' },
      { kind: 'breakpoint', segmentId: 'kb2', ttl: '5m' },
    ]);
    const markedIds = plan.directives.map((directive) => asBreakpoint(directive).segmentId);
    expect(markedIds).not.toContain('turn');
    expect(markedIds).not.toContain('hist');
  });

  it('P2 volatile-early-trap: timestamp-in-stable warning plus volatile-early error on the naive layout, plan still emitted', () => {
    const { engine } = scenario();
    // The naive production layout: a timestamped tiny "stable" system prompt followed by
    // the volatile turn ahead of the remaining stable segments.
    const plan = engine.plan({
      provider: 'anthropic',
      model: 'claude-sonnet-4-5',
      segments: [
        {
          id: 'sys',
          role: 'system',
          stability: 'stable',
          content: 'You are the deploy assistant. Today is 2026-06-11T09:30:00Z, mind the clock.',
        },
        {
          id: 'turn',
          role: 'dynamic',
          stability: 'volatile',
          content: 'What changed since the last deploy?',
        },
        seg('tools', 'tools', 'stable', 1500, 'tools-v1'),
        seg('docs', 'documents', 'semi', 1000, 'docs-v1'),
      ],
    });
    // Pinned engine contract: the analyzer reports the error severity on 'volatile-early'
    // (the early volatile segment makes the whole prompt uncacheable), while
    // 'timestamp-in-stable' is the warning naming the root cause. Exact emission order:
    // structural lints first, then per-segment scans, then the prefix-level summary.
    expect(plan.findings.map((finding) => finding.code)).toEqual([
      'segment-order',
      'volatile-early',
      'timestamp-in-stable',
      'below-minimum',
    ]);
    expect(plan.findings.map((finding) => finding.severity)).toEqual([
      'warning',
      'error',
      'warning',
      'info',
    ]);
    const errorFindings = plan.findings.filter((finding) => finding.severity === 'error');
    expect(errorFindings).toHaveLength(1);
    expect(errorFindings[0]?.code).toBe('volatile-early');
    expect(errorFindings[0]?.segmentId).toBe('turn');
    // The plan is still emitted, with an explicit reasoned no-op directive.
    expect(asNone(directiveAt(plan, 0)).reason).toContain('below the provider minimum');
  });

  it('P3 minimum-boundary: 1023 estimated tokens yields none plus below-minimum, exactly 1024 yields a breakpoint', () => {
    const { engine } = scenario();
    // The 4-chars-per-token estimator: ceil(4092 / 4) = 1023 and ceil(4096 / 4) = 1024,
    // one estimated token below and exactly at the anthropic 1024-token minimum. The
    // letter 'z' is outside [0-9a-f] and carries no digits, so no identifier lint fires.
    const inputOf = (chars: number): PlanInput => ({
      provider: 'anthropic',
      model: 'claude-sonnet-4-5',
      segments: [
        { id: 'sys', role: 'system', stability: 'stable', content: 'z'.repeat(chars) },
        seg('turn', 'dynamic', 'volatile', 50, 'turn-1'),
      ],
      reuse: { intervalSeconds: 60 },
    });

    const below = engine.plan(inputOf(4092));
    expect(below.stableTokens).toBe(1023);
    expect(asNone(directiveAt(below, 0)).reason).toContain('below the provider minimum');
    expect(below.findings.some((finding) => finding.code === 'below-minimum')).toBe(true);

    const exact = engine.plan(inputOf(4096));
    expect(exact.stableTokens).toBe(1024);
    expect(exact.directives).toEqual([{ kind: 'breakpoint', segmentId: 'sys', ttl: '5m' }]);
    expect(exact.findings.some((finding) => finding.code === 'below-minimum')).toBe(false);
  });

  it('P4 ttl-economics: 120s reuse maps to 5m, 1800s/2400s/3300s to a profitable 1h, 0.1 calls per hour to none plus the trap, break-even exactly 1000 premium tokens and 1 reuse', () => {
    const { engine } = scenario();
    const inputOf = (reuse: PlanInput['reuse']): PlanInput => ({
      provider: 'anthropic',
      model: 'claude-sonnet-4-5',
      segments: [
        seg('sys', 'system', 'stable', 4000, 'sys-v1'),
        seg('turn', 'dynamic', 'volatile', 100, 'turn-1'),
      ],
      ...(reuse !== undefined ? { reuse } : {}),
    });

    // 120s <= the 240s ceiling: the 5m tier holds with refresh headroom.
    const fiveMinute = engine.plan(inputOf({ intervalSeconds: 120 }));
    expect(asBreakpoint(directiveAt(fiveMinute, 0)).ttl).toBe('5m');
    // Hand-computed BreakEven for 4000 stable tokens at write multiplier 1.25 and read
    // multiplier 0.1: writePremiumTokens = 4000 * (1.25 - 1) = 1000, savings per reuse =
    // 4000 * (1 - 0.1) = 3600, minReusesToProfit = ceil(1000 / 3600) = 1. Reads refresh
    // the window at no cost (refresh-on-use), so reuse every 120s keeps the entry alive
    // indefinitely and the single repaying read arrives at 120s, profitable.
    if (fiveMinute.breakEven === undefined) {
      throw new Error('anthropic plan must carry break-even economics');
    }
    expect(fiveMinute.breakEven.writePremiumTokens).toBe(1000);
    expect(fiveMinute.breakEven.minReusesToProfit).toBe(1);
    expect(fiveMinute.breakEven.profitable).toBe(true);

    // 1800s overruns the 5m tier (240s ceiling) but fits the 1h tier (3300s ceiling).
    const oneHour = engine.plan(inputOf({ intervalSeconds: 1800 }));
    expect(asBreakpoint(directiveAt(oneHour, 0)).ttl).toBe('1h');
    // 1h tier: premium = 4000 * (2 - 1) = 4000, minReuses = ceil(4000 / 3600) = 2, and
    // under refresh-on-use the second repaying read arrives at 3600s on a window the
    // first read renewed at 1800s, so profitable.
    if (oneHour.breakEven === undefined) {
      throw new Error('anthropic plan must carry break-even economics');
    }
    expect(oneHour.breakEven.writePremiumTokens).toBe(4000);
    expect(oneHour.breakEven.minReusesToProfit).toBe(2);
    expect(oneHour.breakEven.profitable).toBe(true);

    // Council acceptance pins for the refresh-on-use band (1800, 3300]: at 2400s (1.5
    // calls per hour) the second repaying read lands at 4800s, at 3300s (about 1.09
    // calls per hour) at 6600s, both on windows each read renews at no cost, so both
    // plans are profitable with ZERO write-premium-trap findings. Before the
    // refresh-on-use model these emitted a correct 1h directive plus a false trap.
    for (const intervalSeconds of [2400, 3300]) {
      const inBand = engine.plan(inputOf({ intervalSeconds }));
      expect(asBreakpoint(directiveAt(inBand, 0)).ttl).toBe('1h');
      if (inBand.breakEven === undefined) {
        throw new Error('anthropic plan must carry break-even economics');
      }
      expect(inBand.breakEven.writePremiumTokens).toBe(4000);
      expect(inBand.breakEven.minReusesToProfit).toBe(2);
      expect(inBand.breakEven.profitable).toBe(true);
      expect(inBand.findings.filter((finding) => finding.code === 'write-premium-trap')).toEqual(
        [],
      );
    }

    // Calibration note, pinned by running the engine: keeping a 1h cache warm costs one
    // scheduled read per hour (0.1x of the stable tokens) while each real call saves
    // 0.9x, so refresh-keeping stays viable strictly above callsPerHour = 1/9 (about
    // 0.112). At intervalSeconds 7200 the effective rate is 0.5 calls per hour
    // (intervalSeconds wins per the ExpectedReuse contract) and at callsPerHour 0.2 it is
    // 0.2, both above the cutoff, so both stay on the 1h tier with keep-warm touches, and
    // the break-even uses the SAME touch-cost model that justified keeping the tier.
    // Hand math at 0.5 calls per hour: premium 4000, savings 3600 per reuse, touch cost
    // (1 / 0.5) * 4000 * 0.1 = 800 per reuse, net 2800, minReuses = ceil(4000 / 2800) =
    // 2, profitable.
    const sparseInterval = engine.plan(inputOf({ intervalSeconds: 7200, callsPerHour: 0.2 }));
    expect(asBreakpoint(directiveAt(sparseInterval, 0)).ttl).toBe('1h');
    if (sparseInterval.breakEven === undefined) {
      throw new Error('anthropic plan must carry break-even economics');
    }
    expect(sparseInterval.breakEven.writePremiumTokens).toBe(4000);
    expect(sparseInterval.breakEven.minReusesToProfit).toBe(2);
    expect(sparseInterval.breakEven.profitable).toBe(true);
    expect(
      sparseInterval.findings.filter((finding) => finding.code === 'write-premium-trap'),
    ).toEqual([]);
    // Hand math at 0.2 calls per hour: touch cost (1 / 0.2) * 4000 * 0.1 = 2000 per
    // reuse, net 3600 - 2000 = 1600, minReuses = ceil(4000 / 1600) = 3, profitable.
    const sparseCalls = engine.plan(inputOf({ callsPerHour: 0.2 }));
    expect(asBreakpoint(directiveAt(sparseCalls, 0)).ttl).toBe('1h');
    if (sparseCalls.breakEven === undefined) {
      throw new Error('anthropic plan must carry break-even economics');
    }
    expect(sparseCalls.breakEven.minReusesToProfit).toBe(3);
    expect(sparseCalls.breakEven.profitable).toBe(true);

    // callsPerHour 0.1: 0.1 * 0.9 = 0.09 saved per hour against 0.1 spent on keep-warm
    // touches, below break-even, so the planner refuses with the TTL-limit reason AND
    // fires the write-premium-trap on the genuinely unprofitable case.
    const beyondTtl = engine.plan(inputOf({ callsPerHour: 0.1 }));
    expect(asNone(directiveAt(beyondTtl, 0)).reason).toBe(
      'reuse interval exceeds provider TTL, caching would re-write every call',
    );
    const trap = beyondTtl.findings.find((finding) => finding.code === 'write-premium-trap');
    expect(trap).toBeDefined();
    expect(trap?.severity).toBe('warning');
  });

  it('P5 routing-key-stability: 50 openai plans share one prefixKey, retention 24h only above 3600s reuse', () => {
    const { engine } = scenario();
    const inputOf = (intervalSeconds: number): PlanInput => ({
      provider: 'openai',
      model: 'gpt-bench',
      segments: [
        seg('sys', 'system', 'stable', 2000, 'sys-v1'),
        seg('turn', 'dynamic', 'volatile', 100, 'turn-1'),
      ],
      reuse: { intervalSeconds },
    });

    const keys = new Set<string>();
    for (let call = 0; call < 50; call += 1) {
      const plan = engine.plan(inputOf(60));
      keys.add(plan.prefixKey);
      const directive = asRoutingKey(directiveAt(plan, 0));
      expect(directive.key).toBe(plan.prefixKey);
      expect(directive.retention).toBeUndefined();
    }
    expect(keys.size).toBe(1);

    // Retention is requested only when the declared interval EXCEEDS 3600 seconds.
    const atBoundary = engine.plan(inputOf(3600));
    expect(asRoutingKey(directiveAt(atBoundary, 0)).retention).toBeUndefined();
    const aboveBoundary = engine.plan(inputOf(3601));
    expect(asRoutingKey(directiveAt(aboveBoundary, 0)).retention).toBe('24h');
    keys.add(atBoundary.prefixKey);
    keys.add(aboveBoundary.prefixKey);
    // Reuse declarations never reach the prefix key, one distinct key in total.
    expect(keys.size).toBe(1);
  });

  it('P6 resource-lifecycle: action sequence create, reuse, refresh, delete exactly, storage-trap none at 0.5 calls per hour', () => {
    // Storage comes from the google profile (1.0 USD per MTok-hour), reads from pricing.
    const pricing: PricingTable = {
      'gemini-bench': { inputPerMTok: 5, cacheReadPerMTok: 0.5 },
    };
    const { engine, timeline, events } = scenario({ pricing });
    const inputOf = (call: number): PlanInput => ({
      agentId: 'lifecycle',
      provider: 'google',
      model: 'gemini-bench',
      segments: [
        seg('sys', 'system', 'stable', 4000, 'g-sys-v1'),
        seg('turn', 'dynamic', 'volatile', 120, `g-turn-${call}`),
      ],
      reuse: { intervalSeconds: 600 },
    });

    // t0: first sight creates the resource. TTL = clamp(600 * 4, [300, 3600]) = 2400s.
    const created = engine.plan(inputOf(1));
    expect(directiveAt(created, 0)).toEqual({
      kind: 'resource',
      action: 'create',
      resourceKey: created.prefixKey,
      ttlSeconds: 2400,
    });

    // t0 + 10min: well inside the window (600s < 90 percent of 2400s), a plain reuse.
    timeline.now = BENCH_EPOCH_MS + 600_000;
    const reused = engine.plan(inputOf(2));
    expect(directiveAt(reused, 0)).toEqual({
      kind: 'resource',
      action: 'reuse',
      resourceKey: created.prefixKey,
      ttlSeconds: 2400,
    });

    // t0 + 2200s sits inside the final 10 percent of the TTL window (2160s..2400s), so
    // the core swaps the planner's reuse for a refresh before the server expires it.
    timeline.now = BENCH_EPOCH_MS + 2_200_000;
    const refreshed = engine.plan(inputOf(3));
    expect(directiveAt(refreshed, 0)).toEqual({
      kind: 'resource',
      action: 'refresh',
      resourceKey: created.prefixKey,
      ttlSeconds: 2400,
    });

    // The storage trap on its own lineage: at 0.5 reuses per hour the per-token-hour
    // storage bill outruns the read savings, so no resource directive is emitted.
    // Hand-computed: storage per hour = 4000 / 1e6 * 1.0 = 0.004 USD, savings per call =
    // 4000 / 1e6 * (5 - 0.5) = 0.018 USD, minReusesToProfit = ceil(0.004 / 0.018) = 1,
    // and 0.5 calls per hour < 1, so not profitable; writePremiumTokens = 0.004 / 5 * 1e6
    // = 800 base-token equivalents.
    const trapped = engine.plan({
      agentId: 'storage-trap',
      provider: 'google',
      model: 'gemini-bench',
      segments: [
        seg('sys', 'system', 'stable', 4000, 'g-sys-v1'),
        seg('turn', 'dynamic', 'volatile', 120, 'g-turn-trap'),
      ],
      reuse: { callsPerHour: 0.5 },
    });
    expect(asNone(directiveAt(trapped, 0)).reason).toContain('storage');
    if (trapped.breakEven === undefined) {
      throw new Error('priced google plan must carry storage break-even economics');
    }
    expect(trapped.breakEven.profitable).toBe(false);
    expect(trapped.breakEven.minReusesToProfit).toBe(1);
    expect(trapped.breakEven.writePremiumTokens).toBeCloseTo(800, 6);
    expect(trapped.findings.some((finding) => finding.code === 'write-premium-trap')).toBe(true);

    // Invalidation deletes the live resource and reports exactly one cleared prefix.
    expect(engine.invalidate({ prefixKey: created.prefixKey })).toBe(1);

    // The full lifecycle as observed through telemetry, in exact order.
    const actions = events
      .filter(
        (event): event is Extract<TelemetryEvent, { type: 'resource.action' }> =>
          event.type === 'resource.action',
      )
      .filter((event) => event.directive.resourceKey === created.prefixKey)
      .map((event) => event.directive.action);
    expect(actions).toEqual(['create', 'reuse', 'refresh', 'delete']);
  });

  it('P7 ledger-exactness: hitRatio 3500/8000 and savedUsd 0.01575, netUsd 0.006625 to 1e-9', () => {
    const pricing: PricingTable = {
      'bench-model': {
        inputPerMTok: 5,
        cacheReadPerMTok: 0.5,
        cacheWrite5mPerMTok: 6.25,
        cacheWrite1hPerMTok: 10,
      },
    };
    const { engine, timeline } = scenario({ pricing });
    const record = (
      prefixKey: string,
      inputTokens: number,
      cacheReadTokens: number,
      writes?: { w5m?: number; w1h?: number },
    ): void => {
      timeline.now += 1000;
      engine.record({
        provider: 'anthropic',
        model: 'bench-model',
        prefixKey,
        inputTokens,
        cacheReadTokens,
        ...(writes?.w5m !== undefined ? { cacheWriteTokens5m: writes.w5m } : {}),
        ...(writes?.w1h !== undefined ? { cacheWriteTokens1h: writes.w1h } : {}),
        timestamp: timeline.now,
      });
    };

    // Scripted stream over three prefixes. CacheUsage.inputTokens is the ALL-IN billed
    // input (fresh + reads + writes), so per-record uncached = input - reads - writes.
    // pa: read 1600, write5m 800, uncached (1000-800) + 200 + 200 = 600.
    record('pa', 1000, 0, { w5m: 800 });
    record('pa', 1000, 800);
    record('pa', 1000, 800);
    // pb: read 1500, write1h 1500, uncached (2000-1500) + 500 = 1000.
    record('pb', 2000, 0, { w1h: 1500 });
    record('pb', 2000, 1500);
    // pc: read 400, write5m 400 + 100 = 500, uncached (500-400) + (500-400-100) = 100.
    record('pc', 500, 0, { w5m: 400 });
    record('pc', 500, 400, { w5m: 100 });

    // Ledger-wide hand computation under the all-in convention:
    //   read = 1600 + 1500 + 400 = 3500
    //   writes = 800 + 1500 + 500 = 2800
    //   uncached = 600 + 1000 + 100 = 1700
    //   hitRatio = 3500 / (3500 + 2800 + 1700) = 3500 / 8000 = 0.4375
    //   savedUsd = 3500 / 1e6 * (5 - 0.5) = 0.01575
    //   writeSpendUsd = 1300 / 1e6 * (6.25 - 5) + 1500 / 1e6 * (10 - 5)
    //                 = 0.001625 + 0.0075 = 0.009125
    //   netUsd = 0.01575 - 0.009125 = 0.006625
    const stats = engine.stats();
    expect(stats.calls).toBe(7);
    expect(stats.readTokens).toBe(3500);
    expect(stats.writeTokens).toBe(2800);
    expect(stats.uncachedTokens).toBe(1700);
    expect(Math.abs(stats.hitRatio - 0.4375)).toBeLessThan(1e-9);
    if (stats.savedUsd === undefined || stats.netUsd === undefined) {
      throw new Error('priced ledger must report USD figures');
    }
    expect(Math.abs(stats.savedUsd - 0.01575)).toBeLessThan(1e-9);
    expect(Math.abs(stats.netUsd - 0.006625)).toBeLessThan(1e-9);

    // Per-prefix spot check, pa: hitRatio = 1600 / (1600 + 800 + 600) = 1600 / 3000,
    // savedUsd = 1600 / 1e6 * 4.5 = 0.0072, writeSpend = 800 / 1e6 * 1.25 = 0.001, so
    // net = 0.0062.
    const pa = engine.stats({ prefixKey: 'pa' });
    expect(pa.calls).toBe(3);
    expect(Math.abs(pa.hitRatio - 1600 / 3000)).toBeLessThan(1e-9);
    if (pa.savedUsd === undefined || pa.netUsd === undefined) {
      throw new Error('priced prefix must report USD figures');
    }
    expect(Math.abs(pa.savedUsd - 0.0072)).toBeLessThan(1e-9);
    expect(Math.abs(pa.netUsd - 0.0062)).toBeLessThan(1e-9);
  });

  it('P8 drift-precision: zero reports across 100 volatile-churn plans, one exact report per stable mutation and per A/B flip', () => {
    const { engine, timeline } = scenario();
    const inputOf = (systemHash: string, call: number): PlanInput => ({
      agentId: 'churn-agent',
      provider: 'anthropic',
      model: 'claude-sonnet-4-5',
      segments: [
        seg('system', 'system', 'stable', 2000, systemHash),
        seg('turn', 'dynamic', 'volatile', 100, `turn-${call}`),
      ],
      reuse: { intervalSeconds: 60 },
    });

    // 100 plans whose only churn is the volatile turn: declared-volatile churn is
    // expected behavior, never drift.
    let firstKey = '';
    for (let call = 1; call <= 100; call += 1) {
      timeline.now += 60_000;
      firstKey = engine.plan(inputOf('sys-v1', call)).prefixKey;
    }
    expect(engine.drifts()).toEqual([]);

    // One stable mutation: exactly one report, invalidating exactly the 2000 stable
    // tokens the previous prefix had cached.
    timeline.now += 60_000;
    const mutated = engine.plan(inputOf('sys-v2', 101));
    const drifts = engine.drifts();
    expect(drifts).toHaveLength(1);
    expect(drifts[0]).toEqual({
      agentId: 'churn-agent',
      prefixKey: mutated.prefixKey,
      previousKey: firstKey,
      changedSegmentIds: ['system'],
      invalidatedTokens: 2000,
      timestamp: timeline.now,
    });

    // Alternating A/B stable contents on a fresh lineage: lineage follows the latest
    // plan, so every flip is one report, alternating between exactly two prefix keys.
    const flip = scenario();
    const flipInput = (hash: string, call: number): PlanInput => ({
      agentId: 'flip-agent',
      provider: 'anthropic',
      model: 'claude-sonnet-4-5',
      segments: [
        seg('system', 'system', 'stable', 2000, hash),
        seg('turn', 'dynamic', 'volatile', 100, `turn-${call}`),
      ],
    });
    const keyA = flip.engine.plan(flipInput('sys-A', 1)).prefixKey;
    let keyB = '';
    for (let call = 2; call <= 11; call += 1) {
      flip.timeline.now += 60_000;
      const hash = call % 2 === 0 ? 'sys-B' : 'sys-A';
      const plan = flip.engine.plan(flipInput(hash, call));
      if (call === 2) {
        keyB = plan.prefixKey;
      }
    }
    const flipDrifts = flip.engine.drifts();
    // Plans 2 through 11 each flip the stable hash: exactly 10 reports.
    expect(flipDrifts).toHaveLength(10);
    for (const [index, report] of flipDrifts.entries()) {
      expect(report.changedSegmentIds).toEqual(['system']);
      expect(report.invalidatedTokens).toBe(2000);
      // Even indexes flipped A -> B, odd indexes flipped B -> A.
      expect(report.prefixKey).toBe(index % 2 === 0 ? keyB : keyA);
      expect(report.previousKey).toBe(index % 2 === 0 ? keyA : keyB);
    }
  });

  it('P9 cross-engine determinism: same seed and sequence give identical planIds, prefixKeys, and directives', () => {
    const buildCalls = (): readonly PlanInput[] => [
      {
        agentId: 'det-anthropic',
        provider: 'anthropic',
        model: 'claude-sonnet-4-5',
        segments: [
          seg('sys', 'system', 'stable', 2000, 'sys-v1'),
          seg('tools', 'tools', 'stable', 1500, 'tools-v1'),
          seg('turn', 'dynamic', 'volatile', 100, 'turn-1'),
        ],
        reuse: { intervalSeconds: 60 },
      },
      {
        agentId: 'det-anthropic',
        provider: 'anthropic',
        model: 'claude-sonnet-4-5',
        segments: [
          seg('sys', 'system', 'stable', 2000, 'sys-v1'),
          seg('tools', 'tools', 'stable', 1500, 'tools-v1'),
          seg('turn', 'dynamic', 'volatile', 100, 'turn-2'),
        ],
        reuse: { intervalSeconds: 60 },
      },
      {
        // A stable mutation, so the drift path is exercised identically on both engines.
        agentId: 'det-anthropic',
        provider: 'anthropic',
        model: 'claude-sonnet-4-5',
        segments: [
          seg('sys', 'system', 'stable', 2000, 'sys-v2'),
          seg('tools', 'tools', 'stable', 1500, 'tools-v1'),
          seg('turn', 'dynamic', 'volatile', 100, 'turn-3'),
        ],
        reuse: { intervalSeconds: 60 },
      },
      {
        agentId: 'det-openai',
        provider: 'openai',
        model: 'gpt-bench',
        segments: [
          seg('sys', 'system', 'stable', 1800, 'o-sys-v1'),
          seg('turn', 'dynamic', 'volatile', 100, 'o-turn-1'),
        ],
        reuse: { intervalSeconds: 7200 },
      },
      {
        agentId: 'det-google',
        provider: 'google',
        model: 'gemini-bench',
        segments: [
          seg('sys', 'system', 'stable', 4000, 'g-sys-v1'),
          seg('turn', 'dynamic', 'volatile', 100, 'g-turn-1'),
        ],
        reuse: { intervalSeconds: 600 },
      },
      {
        agentId: 'det-google',
        provider: 'google',
        model: 'gemini-bench',
        segments: [
          seg('sys', 'system', 'stable', 4000, 'g-sys-v1'),
          seg('turn', 'dynamic', 'volatile', 100, 'g-turn-2'),
        ],
        reuse: { intervalSeconds: 600 },
      },
      {
        agentId: 'det-passive',
        provider: 'deepseek',
        model: 'deepseek-bench',
        segments: [
          seg('sys', 'system', 'stable', 1200, 'd-sys-v1'),
          seg('turn', 'dynamic', 'volatile', 100, 'd-turn-1'),
        ],
      },
    ];
    const run = (seed: number): CachePlan[] => {
      const { engine, timeline } = scenario({ seed });
      const plans: CachePlan[] = [];
      for (const input of buildCalls()) {
        timeline.now += 60_000;
        plans.push(engine.plan(input));
      }
      return plans;
    };

    const plansA = run(123);
    const plansB = run(123);
    expect(plansA.map((plan) => plan.planId)).toEqual(plansB.map((plan) => plan.planId));
    expect(plansA.map((plan) => plan.prefixKey)).toEqual(plansB.map((plan) => plan.prefixKey));
    expect(plansA.map((plan) => plan.directives)).toEqual(plansB.map((plan) => plan.directives));
    // The full plans, identity included, are deeply identical.
    expect(plansA).toEqual(plansB);
  });

  it('P10 simulate-parity: structured hit ratio above 0.85, naive exactly 0, structured net savings positive, naive premium loss positive', async () => {
    // HARD-LEARNED HARNESS RULE (see tests/integration/cli.test.ts): never spawn the tsx
    // wrapper binary for exit-code assertions, spawn the real Node binary with the loader.
    const ROOT = fileURLToPath(new URL('../..', import.meta.url));
    const CLI = join(ROOT, 'src', 'cli', 'index.ts');
    const NODE = process.execPath;
    const LOADER = ['--import', 'tsx'] as const;
    const result = await new Promise<{ code: number | null; stdout: string; stderr: string }>(
      (resolve, reject) => {
        const child = spawn(NODE, [...LOADER, CLI, 'simulate', '--calls', '300', '--seed', '11'], {
          cwd: ROOT,
        });
        let stdout = '';
        let stderr = '';
        child.stdout.setEncoding('utf8');
        child.stderr.setEncoding('utf8');
        child.stdout.on('data', (chunk: string) => {
          stdout += chunk;
        });
        child.stderr.on('data', (chunk: string) => {
          stderr += chunk;
        });
        child.once('error', reject);
        child.once('close', (code) => {
          resolve({ code, stdout, stderr });
        });
      },
    );
    expect(result.code).toBe(0);

    const structured = /structured: hit ratio (\d+\.\d+), net savings (-?\d+\.\d+) USD/.exec(
      result.stdout,
    );
    const naive = /naive: hit ratio (\d+\.\d+), write-premium loss (-?\d+\.\d+) USD/.exec(
      result.stdout,
    );
    if (structured === null || naive === null) {
      throw new Error(`simulate summary lines missing from output:\n${result.stdout}`);
    }
    expect(Number(structured[1])).toBeGreaterThan(0.85);
    expect(Number(structured[2])).toBeGreaterThan(0);
    expect(Number(naive[1])).toBe(0);
    expect(Number(naive[2])).toBeGreaterThan(0);
  });
});
