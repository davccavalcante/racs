/**
 * Integration tests for the RACS engine core: deterministic planning, input validation,
 * lint purity, drift detection end to end, resource lifecycle timing, the invalidate
 * matrix, degraded mode at the prefix cap, telemetry mechanics, and state persistence
 * round trips with defensive restore.
 *
 * Determinism: every engine here runs with seed 7 and an injected clock. No test reads
 * the wall clock or the global random generator.
 */

import { describe, expect, it } from 'vitest';
import type {
  DriftReport,
  PlanInput,
  RACS,
  RACSOptions,
  StateBackend,
  StateSnapshot,
  TelemetryEvent,
} from '../../src/index.js';
import { createRACS, memoryState, RacsError } from '../../src/index.js';

/** Fixed origin of every simulated timeline, milliseconds since the Unix epoch. */
const T0 = 1_750_000_000_000;

/** Indexes into an array without non-null assertions, supports negative indexes. */
function at<T>(items: readonly T[], index: number): T {
  const item = items.at(index);
  if (item === undefined) {
    throw new Error(`expected an element at index ${index}, found none`);
  }
  return item;
}

/** Runs `run`, returns what it threw, fails the test when it returned normally. */
function captureError(run: () => unknown): unknown {
  try {
    run();
  } catch (error) {
    return error;
  }
  throw new Error('expected the call to throw, it returned normally');
}

/** Asserts one RacsError with the stable ERR_INVALID_INPUT code. */
function expectInvalidInput(run: () => unknown): void {
  const caught = captureError(run);
  expect(caught).toBeInstanceOf(RacsError);
  expect(caught).toMatchObject({ name: 'RacsError', code: 'ERR_INVALID_INPUT' });
}

/** Drift reports carried by 'prefix.drifted' events, in emission order. */
const driftReports = (events: readonly TelemetryEvent[]): DriftReport[] =>
  events.flatMap((event) => (event.type === 'prefix.drifted' ? [event.report] : []));

/** Resource directives carried by 'resource.action' events, with their timestamps. */
const resourceActions = (
  events: readonly TelemetryEvent[],
): Array<{ action: string; resourceKey: string; ttlSeconds: number; timestamp: number }> =>
  events.flatMap((event) =>
    event.type === 'resource.action'
      ? [
          {
            action: event.directive.action,
            resourceKey: event.directive.resourceKey,
            ttlSeconds: event.directive.ttlSeconds,
            timestamp: event.timestamp,
          },
        ]
      : [],
  );

/** 'limit.reached' events in emission order. */
const limitEvents = (
  events: readonly TelemetryEvent[],
): Array<{ scope: string; detail: string; timestamp: number }> =>
  events.flatMap((event) =>
    event.type === 'limit.reached'
      ? [{ scope: event.scope, detail: event.detail, timestamp: event.timestamp }]
      : [],
  );

/** Count of events of one type. */
const countOf = (events: readonly TelemetryEvent[], type: TelemetryEvent['type']): number =>
  events.filter((event) => event.type === type).length;

interface Harness {
  readonly racs: RACS;
  readonly events: TelemetryEvent[];
  setNow(value: number): void;
}

/** One engine with seed 7, an injected mutable clock starting at T0, and a tap on telemetry. */
function harness(overrides: RACSOptions = {}): Harness {
  let now = T0;
  const racs = createRACS({ seed: 7, clock: () => now, ...overrides });
  const events: TelemetryEvent[] = [];
  racs.on((event) => {
    events.push(event);
  });
  return {
    racs,
    events,
    setNow: (value: number): void => {
      now = value;
    },
  };
}

/**
 * Anthropic breakpoint input. Token geometry, hand-computed at 4 characters per token:
 * sys 4096 chars -> 1024 tokens, tools 2048 chars -> 512 tokens, turn 11 chars -> 3
 * tokens, so stableTokens 1536 and totalTokens 1539.
 */
const anthropicInput = (model = 'claude-sonnet-4-5'): PlanInput => ({
  provider: 'anthropic',
  model,
  segments: [
    { id: 'sys', role: 'system', stability: 'stable', content: 'a'.repeat(4096) },
    { id: 'tools', role: 'tools', stability: 'stable', content: 'b'.repeat(2048) },
    { id: 'turn', role: 'dynamic', stability: 'volatile', content: 'hello world' },
  ],
  reuse: { intervalSeconds: 60 },
});

/**
 * Google resource input. Reuse every 600s yields ttlSeconds min(3600, max(300, 600 * 4))
 * = 2400, a 2,400,000 ms window whose last 10 percent starts 2,160,000 ms after a write.
 */
const googleInput = (): PlanInput => ({
  provider: 'google',
  model: 'gemini-2.5-pro',
  segments: [
    { id: 'kb', role: 'documents', stability: 'stable', content: 'k'.repeat(800), tokens: 4096 },
    { id: 'turn', role: 'dynamic', stability: 'volatile', content: 'question' },
  ],
  reuse: { intervalSeconds: 600 },
});

/** Stable-only OpenAI routing-key input, 4096 chars -> 1024 stable tokens. */
const openaiInput = (): PlanInput => ({
  provider: 'openai',
  model: 'gpt-5-codex',
  segments: [{ id: 'sys', role: 'system', stability: 'stable', content: 'o'.repeat(4096) }],
});

/** Versioned lineage input for drift tests: the stable segment carries 1200 exact tokens. */
const driftInput = (version: number): PlanInput => ({
  agentId: 'drift-agent',
  provider: 'anthropic',
  model: 'claude-sonnet-4-5',
  segments: [
    {
      id: 'sys',
      role: 'system',
      stability: 'stable',
      content: `system-prompt-v${version}`,
      tokens: 1200,
    },
    { id: 'turn', role: 'dynamic', stability: 'volatile', content: 'turn' },
  ],
});

describe('plan determinism', () => {
  it('produces the same prefixKey, distinct planIds, and zero drift for identical input', () => {
    const { racs, events } = harness();

    const first = racs.plan(anthropicInput());
    const second = racs.plan(anthropicInput());

    expect(second.prefixKey).toBe(first.prefixKey);
    expect(first.planId).toMatch(/^rx-1-[0-9a-z]+$/);
    expect(second.planId).toMatch(/^rx-2-[0-9a-z]+$/);
    expect(second.planId).not.toBe(first.planId);
    // Apart from the plan identity, the two plans are byte-identical data.
    expect({ ...second, planId: '' }).toEqual({ ...first, planId: '' });

    // Hand-computed geometry: 1024 + 512 stable tokens, plus the 3-token volatile turn.
    expect(first.stableTokens).toBe(1536);
    expect(first.totalTokens).toBe(1539);
    expect(first.family).toBe('breakpoint');
    expect(first.directives).toEqual([
      { kind: 'breakpoint', segmentId: 'sys', ttl: '5m' },
      { kind: 'breakpoint', segmentId: 'tools', ttl: '5m' },
    ]);
    // Break-even by hand: premium 1536 * (1.25 - 1) = 384 base-token equivalents, each
    // reuse recovers 1536 * (1 - 0.1) = 1382.4, so ceil(384 / 1382.4) = 1 reuse repays it.
    expect(first.breakEven).toMatchObject({
      writePremiumTokens: 384,
      minReusesToProfit: 1,
      profitable: true,
    });

    // Zero drift: same lineage, same hashes, same key.
    expect(racs.drifts()).toEqual([]);
    expect(driftReports(events)).toEqual([]);
    expect(countOf(events, 'plan.created')).toBe(2);

    // A second engine with the same seed reproduces the same deterministic identifiers.
    const twin = harness();
    const twinPlan = twin.racs.plan(anthropicInput());
    expect(twinPlan.planId).toBe(first.planId);
    expect(twinPlan.prefixKey).toBe(first.prefixKey);
  });
});

describe('input validation', () => {
  it('rejects empty segment lists with ERR_INVALID_INPUT', () => {
    const { racs } = harness();
    expectInvalidInput(() =>
      racs.plan({ provider: 'anthropic', model: 'claude-sonnet-4-5', segments: [] }),
    );
  });

  it('rejects duplicate segment ids with ERR_INVALID_INPUT', () => {
    const { racs } = harness();
    expectInvalidInput(() =>
      racs.plan({
        provider: 'anthropic',
        model: 'claude-sonnet-4-5',
        segments: [
          { id: 'sys', role: 'system', stability: 'stable', content: 'one' },
          { id: 'sys', role: 'system', stability: 'stable', content: 'two' },
        ],
      }),
    );
  });

  it('rejects segments carrying neither content nor contentHash with ERR_INVALID_INPUT', () => {
    const { racs } = harness();
    expectInvalidInput(() =>
      racs.plan({
        provider: 'anthropic',
        model: 'claude-sonnet-4-5',
        segments: [{ id: 'sys', role: 'system', stability: 'stable' }],
      }),
    );
  });
});

describe('lint purity', () => {
  it('emits no telemetry and mutates no fingerprints', () => {
    const { racs, events } = harness();

    // Lint alone produces findings without any telemetry.
    const findings = racs.lint({
      provider: 'anthropic',
      model: 'claude-sonnet-4-5',
      segments: [{ id: 'tools', role: 'tools', stability: 'volatile', content: 'tool defs' }],
    });
    expect(findings.some((finding) => finding.code === 'unstable-tools')).toBe(true);
    expect(events).toEqual([]);

    // Establish a fingerprint lineage, then lint a mutated input. If lint fingerprinted,
    // the mutation would replace the baseline and the replan below would report drift.
    racs.plan(driftInput(0));
    const lengthAfterPlan = events.length;
    racs.lint(driftInput(99));
    expect(events.length).toBe(lengthAfterPlan);

    racs.plan(driftInput(0));
    expect(driftReports(events)).toEqual([]);
    expect(racs.drifts()).toEqual([]);
  });
});

describe('drift flow end to end', () => {
  it('reports a mutated stable segment with full lineage detail', () => {
    const { racs, events, setNow } = harness();

    const baseline = racs.plan(driftInput(0));
    expect(driftReports(events)).toEqual([]);

    setNow(T0 + 1000);
    const drifted = racs.plan(driftInput(1));
    expect(drifted.prefixKey).not.toBe(baseline.prefixKey);

    const expected: DriftReport = {
      agentId: 'drift-agent',
      prefixKey: drifted.prefixKey,
      previousKey: baseline.prefixKey,
      changedSegmentIds: ['sys'],
      // The previous stable prefix carried exactly 1200 declared tokens, all now dead.
      invalidatedTokens: 1200,
      timestamp: T0 + 1000,
    };
    expect(driftReports(events)).toEqual([expected]);
    expect(racs.drifts()).toEqual([expected]);
  });

  it('bounds the ring at 200 reports, newest last, and honors the limit argument', () => {
    const { racs, events, setNow } = harness();

    // Plan 0 is the baseline, plans 1..205 each mutate the stable segment: 205 drifts.
    for (let version = 0; version <= 205; version += 1) {
      setNow(T0 + version * 1000);
      racs.plan(driftInput(version));
    }
    expect(countOf(events, 'prefix.drifted')).toBe(205);

    const ring = racs.drifts();
    expect(ring.length).toBe(200);
    // The five oldest reports (timestamps T0+1000 .. T0+5000) fell off the ring.
    expect(at(ring, 0).timestamp).toBe(T0 + 6_000);
    expect(at(ring, -1).timestamp).toBe(T0 + 205_000);
    expect(
      ring.every(
        (report, index) => index === 0 || report.timestamp > at(ring, index - 1).timestamp,
      ),
    ).toBe(true);

    const lastTen = racs.drifts(10);
    expect(lastTen.length).toBe(10);
    expect(at(lastTen, 0).timestamp).toBe(T0 + 196_000);
    expect(at(lastTen, -1).timestamp).toBe(T0 + 205_000);
    expect(racs.drifts(0)).toEqual([]);
  });
});

describe('resource lifecycle', () => {
  it('walks create, reuse, refresh inside the last 10 percent, and create after expiry', () => {
    const { racs, events, setNow } = harness();

    // t = T0: first sight creates the resource. Window: 2,400,000 ms from T0.
    const created = racs.plan(googleInput());
    expect(created.directives).toEqual([
      { kind: 'resource', action: 'create', resourceKey: created.prefixKey, ttlSeconds: 2400 },
    ]);

    // t = T0 + 1,000,000: well inside the window and before its last 10 percent -> reuse.
    setNow(T0 + 1_000_000);
    expect(at(racs.plan(googleInput()).directives, 0)).toMatchObject({ action: 'reuse' });

    // t = T0 + 2,200,000: past the 90 percent boundary at T0 + 2,160,000 -> refresh,
    // which restarts the window from this moment.
    setNow(T0 + 2_200_000);
    expect(at(racs.plan(googleInput()).directives, 0)).toMatchObject({ action: 'refresh' });

    // t = T0 + 3,200,000: only 1,000,000 ms into the renewed window -> reuse again.
    setNow(T0 + 3_200_000);
    expect(at(racs.plan(googleInput()).directives, 0)).toMatchObject({ action: 'reuse' });

    // t = T0 + 4,600,000: the full 2,400,000 ms since the refresh elapsed, the server
    // already expired the resource, so the next directive is a create, not a dead reuse.
    setNow(T0 + 4_600_000);
    expect(at(racs.plan(googleInput()).directives, 0)).toMatchObject({ action: 'create' });

    expect(resourceActions(events)).toEqual([
      { action: 'create', resourceKey: created.prefixKey, ttlSeconds: 2400, timestamp: T0 },
      {
        action: 'reuse',
        resourceKey: created.prefixKey,
        ttlSeconds: 2400,
        timestamp: T0 + 1_000_000,
      },
      {
        action: 'refresh',
        resourceKey: created.prefixKey,
        ttlSeconds: 2400,
        timestamp: T0 + 2_200_000,
      },
      {
        action: 'reuse',
        resourceKey: created.prefixKey,
        ttlSeconds: 2400,
        timestamp: T0 + 3_200_000,
      },
      {
        action: 'create',
        resourceKey: created.prefixKey,
        ttlSeconds: 2400,
        timestamp: T0 + 4_600_000,
      },
    ]);
  });
});

describe('invalidate matrix', () => {
  it('by prefixKey: returns 1, drops the schedule entry, prunes lineage, recreates the resource', () => {
    const { racs, events } = harness();

    const google = racs.plan(googleInput());
    const claude = racs.plan(anthropicInput());

    // Both keep-warm entries are due by T0 + 2,160,000 (anthropic 5m at +270,000,
    // google resource at +2,160,000).
    const dueBefore = racs.schedule(T0 + 2_160_000);
    expect(dueBefore.map((entry) => entry.prefixKey).sort()).toEqual(
      [claude.prefixKey, google.prefixKey].sort(),
    );

    expect(racs.invalidate({ prefixKey: google.prefixKey })).toBe(1);

    // The resource registry entry was dropped with a delete event for the host to mirror.
    const deletes = resourceActions(events).filter((action) => action.action === 'delete');
    expect(deletes).toEqual([
      { action: 'delete', resourceKey: google.prefixKey, ttlSeconds: 2400, timestamp: T0 },
    ]);

    // The schedule lost exactly the invalidated entry.
    const dueAfter = racs.schedule(T0 + 2_160_000);
    expect(dueAfter.map((entry) => entry.prefixKey)).toEqual([claude.prefixKey]);

    // The next identical plan reports no drift, its lineage was pruned, and it emits a
    // resource create again because the registry no longer knows the resource.
    const driftsBefore = driftReports(events).length;
    const replanned = racs.plan(googleInput());
    expect(replanned.prefixKey).toBe(google.prefixKey);
    expect(driftReports(events).length).toBe(driftsBefore);
    expect(at(replanned.directives, 0)).toMatchObject({ kind: 'resource', action: 'create' });
  });

  it('by prefixKey: a mutated replan after invalidation does not drift, proving the prune', () => {
    const { racs, events } = harness();

    const baseline = racs.plan(driftInput(0));
    expect(racs.invalidate({ prefixKey: baseline.prefixKey })).toBe(1);

    // Without the prune this mutation would report drift against version 0.
    racs.plan(driftInput(1));
    expect(driftReports(events)).toEqual([]);
    expect(racs.drifts()).toEqual([]);
  });

  it('by provider: counts only matching prefixes', () => {
    const { racs, events } = harness();

    const google = racs.plan(googleInput());
    racs.plan(anthropicInput());
    racs.plan(openaiInput());

    expect(racs.invalidate({ provider: 'google' })).toBe(1);
    const deletes = resourceActions(events).filter((action) => action.action === 'delete');
    expect(deletes.map((action) => action.resourceKey)).toEqual([google.prefixKey]);

    expect(racs.invalidate({ provider: 'openai' })).toBe(1);
    expect(racs.invalidate({ provider: 'google' })).toBe(0);
    // Only the anthropic prefix remains, an unfiltered clear finds exactly it.
    expect(racs.invalidate()).toBe(1);
  });

  it('without a filter: clears everything once, then nothing remains', () => {
    const { racs } = harness();

    racs.plan(anthropicInput('claude-sonnet-4-5'));
    racs.plan(anthropicInput('claude-haiku-4-5'));
    racs.plan(googleInput());

    expect(racs.invalidate()).toBe(3);
    expect(racs.invalidate()).toBe(0);
    expect(racs.schedule(T0 + 1_000_000_000)).toEqual([]);
  });
});

describe('maxPrefixes degraded mode', () => {
  it('serves the overflow plan, emits limit.reached, and skips registration', () => {
    const { racs, events } = harness({ maxPrefixes: 2 });

    racs.plan(anthropicInput('model-one'));
    racs.plan(anthropicInput('model-two'));
    expect(limitEvents(events)).toEqual([]);

    const overflow = racs.plan(googleInput());

    const limits = limitEvents(events);
    expect(limits.length).toBe(1);
    expect(at(limits, 0).scope).toBe('prefixes');
    expect(at(limits, 0).detail).toContain(overflow.prefixKey);

    // The plan itself is served in full, directives included.
    expect(overflow.directives).toEqual([
      { kind: 'resource', action: 'create', resourceKey: overflow.prefixKey, ttlSeconds: 2400 },
    ]);
    // Resource bookkeeping was skipped: no 'resource.action' telemetry mirrored the create.
    expect(resourceActions(events)).toEqual([]);
    // Keep-warm tracking was skipped: the overflow key is never due.
    const due = racs.schedule(T0 + 1_000_000_000);
    expect(due.map((entry) => entry.prefixKey)).not.toContain(overflow.prefixKey);
    expect(due.length).toBe(2);
    // Drift lineage tracking deliberately survives the cap, so invalidation by the
    // overflow key still prunes that lineage and reports it.
    expect(racs.invalidate({ prefixKey: overflow.prefixKey })).toBe(1);
  });

  it('the ledger applies its own LRU cap at recording time', () => {
    const { racs, events } = harness({ maxPrefixes: 2 });

    for (const key of ['prefix-1', 'prefix-2', 'prefix-3']) {
      racs.record({
        provider: 'anthropic',
        model: 'claude-sonnet-4-5',
        prefixKey: key,
        inputTokens: 100,
        cacheReadTokens: 50,
      });
    }

    const limits = limitEvents(events);
    expect(limits.length).toBe(1);
    expect(at(limits, 0).scope).toBe('ledger');
    expect(at(limits, 0).detail).toContain('prefix-1');
    expect(racs.stats().prefixes.map((prefix) => prefix.prefixKey)).toEqual([
      'prefix-2',
      'prefix-3',
    ]);
  });
});

describe('telemetry mechanics', () => {
  it('matches event counts to call counts, unsubscribes cleanly, and swallows throwers', () => {
    let now = T0;
    const racs = createRACS({ seed: 7, clock: () => now });

    const seen: TelemetryEvent[] = [];
    const off = racs.on((event) => {
      seen.push(event);
    });

    racs.plan(anthropicInput());
    racs.plan(anthropicInput());
    racs.plan(googleInput());
    racs.record({
      provider: 'anthropic',
      model: 'claude-sonnet-4-5',
      inputTokens: 100,
      cacheReadTokens: 60,
    });
    racs.record({
      provider: 'anthropic',
      model: 'claude-sonnet-4-5',
      inputTokens: 100,
      cacheReadTokens: 0,
    });

    expect(countOf(seen, 'plan.created')).toBe(3);
    expect(countOf(seen, 'usage.recorded')).toBe(2);
    const hits = seen.flatMap((event) => (event.type === 'usage.recorded' ? [event.hit] : []));
    expect(hits).toEqual([true, false]);
    // The google resource create was mirrored exactly once.
    expect(countOf(seen, 'resource.action')).toBe(1);

    // Unsubscribe stops delivery and is idempotent.
    const lengthAtUnsubscribe = seen.length;
    off();
    off();
    racs.plan(anthropicInput());
    expect(seen.length).toBe(lengthAtUnsubscribe);

    // A throwing listener never breaks the engine or starves later listeners.
    now = T0 + 5_000;
    racs.on(() => {
      throw new Error('listener boom');
    });
    const afterThrower: TelemetryEvent[] = [];
    racs.on((event) => {
      afterThrower.push(event);
    });
    const plan = racs.plan(anthropicInput());
    expect(plan.prefixKey).not.toBe('');
    expect(countOf(afterThrower, 'plan.created')).toBe(1);
  });
});

describe('state persistence', () => {
  const pricing = {
    'claude-sonnet-4-5': { inputPerMTok: 3, cacheReadPerMTok: 0.3 },
  } as const;

  it('round-trips stats, fingerprints, keeper entries, and the resource registry', async () => {
    const backend = memoryState();
    let now = T0;
    const clock = (): number => now;

    const engineA = createRACS({ seed: 7, clock, state: backend, pricing });

    // Lineage input with an agentId so fingerprints persist a named lineage.
    const planInput: PlanInput = {
      agentId: 'roundtrip-agent',
      provider: 'anthropic',
      model: 'claude-sonnet-4-5',
      segments: [
        { id: 'sys', role: 'system', stability: 'stable', content: 'a'.repeat(4096) },
        { id: 'turn', role: 'dynamic', stability: 'volatile', content: 'hello world' },
      ],
      reuse: { intervalSeconds: 60 },
    };
    const planA = engineA.plan(planInput);

    now = T0 + 10_000;
    const googleA = engineA.plan(googleInput());

    now = T0 + 20_000;
    engineA.plan(openaiInput());
    expect(engineA.invalidate({ provider: 'openai' })).toBe(1);

    engineA.record({
      provider: 'anthropic',
      model: 'claude-sonnet-4-5',
      prefixKey: planA.prefixKey,
      inputTokens: 5000,
      cacheReadTokens: 4200,
      timestamp: T0 + 30_000,
    });
    engineA.record({
      provider: 'anthropic',
      model: 'claude-sonnet-4-5',
      inputTokens: 1000,
      cacheReadTokens: 0,
      timestamp: T0 + 31_000,
    });

    const statsA = engineA.stats();
    // Hand-computed: reads 4200, uncached (5000 - 4200) + 1000 = 1800, no writes, so the
    // hit ratio is 4200 / 6000 = 0.7 and savedUsd is 4200 / 1e6 * (3 - 0.3) = 0.01134.
    expect(statsA.calls).toBe(2);
    expect(statsA.readTokens).toBe(4200);
    expect(statsA.writeTokens).toBe(0);
    expect(statsA.uncachedTokens).toBe(1800);
    expect(statsA.hitRatio).toBe(0.7);
    expect(statsA.savedUsd).toBeCloseTo(0.01134, 9);
    expect(statsA.netUsd).toBe(statsA.savedUsd);

    now = T0 + 40_000;
    await engineA.flush();

    // Second engine restores from the same backend; flush awaits the restore.
    now = T0 + 50_000;
    const engineB = createRACS({ seed: 7, clock, state: backend, pricing });
    await engineB.flush();
    const eventsB: TelemetryEvent[] = [];
    engineB.on((event) => {
      eventsB.push(event);
    });

    // Stats totals restored exactly.
    expect(engineB.stats()).toEqual(statsA);

    // Keeper entries restored: the anthropic 5m entry is due at T0 + 270,000, while the
    // google resource entry is due only at T0 + 10,000 + 2,160,000.
    const due = engineB.schedule(T0 + 270_000);
    expect(due.map((entry) => entry.prefixKey)).toEqual([planA.prefixKey]);
    expect(at(due, 0)).toMatchObject({
      provider: 'anthropic',
      ttl: '5m',
      lastWriteAt: T0,
      refreshAt: T0 + 270_000,
    });

    // Fingerprints restored: an identical replan reports no spurious drift.
    now = T0 + 60_000;
    engineB.plan(planInput);
    expect(driftReports(eventsB)).toEqual([]);

    // Resource registry restored: the google resource planned at T0 + 10,000 is still
    // live inside its 2,400,000 ms window, so the replan reuses instead of creating.
    now = T0 + 70_000;
    const googleB = engineB.plan(googleInput());
    expect(googleB.prefixKey).toBe(googleA.prefixKey);
    expect(at(googleB.directives, 0)).toMatchObject({ kind: 'resource', action: 'reuse' });

    // Provider attribution restored with the registry: provider-scoped invalidation
    // finds the google prefix and mirrors the delete.
    expect(engineB.invalidate({ provider: 'google' })).toBe(1);
    const deletes = resourceActions(eventsB).filter((action) => action.action === 'delete');
    expect(deletes.map((action) => action.resourceKey)).toEqual([googleA.prefixKey]);

    // The openai prefix invalidated before the flush stayed invalidated.
    expect(engineB.invalidate({ provider: 'openai' })).toBe(0);
  });

  it('skips a corrupted snapshot section without failing construction', async () => {
    const sourceBackend = memoryState();
    let now = T0;
    const clock = (): number => now;

    const engineA = createRACS({ seed: 7, clock, state: sourceBackend });
    const planA = engineA.plan(driftInput(0));
    engineA.record({
      provider: 'anthropic',
      model: 'claude-sonnet-4-5',
      inputTokens: 100,
      cacheReadTokens: 50,
    });
    await engineA.flush();

    const saved = await sourceBackend.load();
    if (saved === undefined) {
      throw new Error('expected a saved snapshot after flush');
    }
    // The ledger section passes the structural gate but its entries explode inside
    // Ledger.fromJSON, exercising the per-section try/catch.
    const corrupted: StateSnapshot = {
      ...saved,
      data: { ...saved.data, ledger: { maxPrefixes: 4, entries: [null] } },
    };
    const tamperedBackend: StateBackend = {
      load: (): Promise<StateSnapshot | undefined> => Promise.resolve(corrupted),
      save: (): Promise<void> => Promise.resolve(),
    };

    now = T0 + 5_000;
    const engineB = createRACS({ seed: 7, clock, state: tamperedBackend });
    await engineB.flush();

    // The corrupt ledger section degraded to an empty ledger.
    expect(engineB.stats().calls).toBe(0);

    // Sibling sections survived: the keeper still schedules the persisted prefix.
    const due = engineB.schedule(T0 + 270_000);
    expect(due.map((entry) => entry.prefixKey)).toEqual([planA.prefixKey]);

    // And the fingerprints survived: a mutated replan drifts against the restored baseline.
    const eventsB: TelemetryEvent[] = [];
    engineB.on((event) => {
      eventsB.push(event);
    });
    now = T0 + 6_000;
    engineB.plan(driftInput(1));
    const reports = driftReports(eventsB);
    expect(reports.length).toBe(1);
    expect(at(reports, 0)).toMatchObject({
      previousKey: planA.prefixKey,
      changedSegmentIds: ['sys'],
      invalidatedTokens: 1200,
    });
  });
});
