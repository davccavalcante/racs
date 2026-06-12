/**
 * Integration tests for the packaged Vercel AI SDK middleware: transformParams directive
 * application per provider family, the always-present RACS stash, no in-place parameter
 * mutation, the default segmenter's anatomy verified through plan geometry, custom
 * segmenter override, and usage recording through wrapGenerate and wrapStream.
 *
 * Determinism: every engine here runs with seed 7 and a fixed injected clock.
 */

import { describe, expect, it } from 'vitest';
import type { CachePlan, RACS, RACSOptions, TelemetryEvent } from '../../src/index.js';
import { createRACS } from '../../src/index.js';
import type { CallOptionsLike } from '../../src/vercel/index.js';
import { racsMiddleware } from '../../src/vercel/index.js';

/** Fixed engine clock, milliseconds since the Unix epoch. */
const T0 = 1_750_000_000_000;

/** Indexes into an array without non-null assertions, supports negative indexes. */
function at<T>(items: readonly T[], index: number): T {
  const item = items.at(index);
  if (item === undefined) {
    throw new Error(`expected an element at index ${index}, found none`);
  }
  return item;
}

interface Harness {
  readonly racs: RACS;
  readonly events: TelemetryEvent[];
  readonly plans: CachePlan[];
}

/** One engine with seed 7 and a fixed clock, tapping telemetry and created plans. */
function harness(overrides: RACSOptions = {}): Harness {
  const racs = createRACS({ seed: 7, clock: () => T0, ...overrides });
  const events: TelemetryEvent[] = [];
  const plans: CachePlan[] = [];
  racs.on((event) => {
    events.push(event);
    if (event.type === 'plan.created') {
      plans.push(event.plan);
    }
  });
  return { racs, events, plans };
}

/** Reads one provider-namespaced option bag or fails the test. */
function bagOf(params: CallOptionsLike, namespace: string): Record<string, unknown> {
  const bag = params.providerOptions?.[namespace];
  if (bag === undefined) {
    throw new Error(`expected providerOptions.${namespace} to be present`);
  }
  return bag;
}

/** Usage records carried by 'usage.recorded' events, with their hit flags. */
const recordedUsages = (events: readonly TelemetryEvent[]) =>
  events.flatMap((event) =>
    event.type === 'usage.recorded' ? [{ usage: event.usage, hit: event.hit }] : [],
  );

/** A long stable system prompt: 6000 chars, 1500 estimated tokens, above every minimum. */
const longSystem = 's'.repeat(6000);

/** Base params shared by the transform tests: one system string, one live user turn. */
const baseParams = (): CallOptionsLike => ({
  system: longSystem,
  prompt: [{ role: 'user', content: 'hi' }],
});

/** Wraps a list of parts into a ReadableStream that closes after the last one. */
const sourceStream = (parts: readonly unknown[]): ReadableStream<unknown> =>
  new ReadableStream<unknown>({
    start(controller): void {
      for (const part of parts) {
        controller.enqueue(part);
      }
      controller.close();
    },
  });

/** Drains a stream and returns every part in arrival order. */
async function readAll(stream: ReadableStream<unknown>): Promise<unknown[]> {
  const reader = stream.getReader();
  const parts: unknown[] = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      return parts;
    }
    parts.push(value);
  }
}

describe('transformParams', () => {
  it('anthropic: sets cacheControl without ttl when the plan chose the 5m tier', async () => {
    const { racs, plans } = harness();
    const middleware = racsMiddleware(racs, {
      provider: 'anthropic',
      model: 'claude-sonnet-4-5',
    });

    const result = await middleware.transformParams({ params: baseParams() });

    // No declared reuse means the planner defaults to the cheaper 5m tier.
    expect(at(plans, 0).directives).toEqual([
      { kind: 'breakpoint', segmentId: 'system', ttl: '5m' },
    ]);
    expect(bagOf(result, 'anthropic').cacheControl).toEqual({ type: 'ephemeral' });
  });

  it('anthropic: sets cacheControl with ttl 1h only when a 1h breakpoint exists', async () => {
    // A profile offering only the 1h tier forces every breakpoint onto it.
    const { racs, plans } = harness({ profiles: { anthropic: { ttls: ['1h'] } } });
    const middleware = racsMiddleware(racs, {
      provider: 'anthropic',
      model: 'claude-sonnet-4-5',
    });

    const result = await middleware.transformParams({ params: baseParams() });

    expect(at(plans, 0).directives).toEqual([
      { kind: 'breakpoint', segmentId: 'system', ttl: '1h' },
    ]);
    expect(bagOf(result, 'anthropic').cacheControl).toEqual({ type: 'ephemeral', ttl: '1h' });
  });

  it('openai: sets promptCacheKey and retention exactly as the plan directed', async () => {
    const { racs, plans } = harness();
    const middleware = racsMiddleware(racs, { provider: 'openai', model: 'gpt-5-codex' });

    const result = await middleware.transformParams({ params: baseParams() });

    const plan = at(plans, 0);
    expect(plan.directives).toEqual([{ kind: 'routing-key', key: plan.prefixKey }]);
    const openaiBag = bagOf(result, 'openai');
    expect(openaiBag.promptCacheKey).toBe(plan.prefixKey);
    // The plan requested no extended retention (the middleware declares no reuse
    // pattern), so the retention option must not appear.
    expect('promptCacheRetention' in openaiBag).toBe(false);
    // For openai itself no routing mirror is duplicated into the stash.
    expect('routingKey' in bagOf(result, 'racs')).toBe(false);
  });

  it('mirrors the routing key under racs for routing-key providers other than openai', async () => {
    const { racs, plans } = harness();
    const middleware = racsMiddleware(racs, { provider: 'mistral', model: 'mistral-large' });

    const result = await middleware.transformParams({ params: baseParams() });

    expect(bagOf(result, 'racs').routingKey).toBe(at(plans, 0).prefixKey);
  });

  it('always stashes the plan identity, even for passive providers', async () => {
    const { racs, plans } = harness();
    const middleware = racsMiddleware(racs, { provider: 'groq', model: 'gpt-oss-120b' });

    const result = await middleware.transformParams({ params: baseParams() });

    const plan = at(plans, 0);
    expect(bagOf(result, 'racs')).toEqual({
      prefixKey: plan.prefixKey,
      planId: plan.planId,
      provider: 'groq',
      model: 'gpt-oss-120b',
    });
    // A passive plan changes no provider parameters.
    expect(result.providerOptions !== undefined && 'anthropic' in result.providerOptions).toBe(
      false,
    );
    expect(result.providerOptions !== undefined && 'openai' in result.providerOptions).toBe(false);
  });

  it('never mutates the params in place', async () => {
    const { racs } = harness();
    const middleware = racsMiddleware(racs, {
      provider: 'anthropic',
      model: 'claude-sonnet-4-5',
    });

    const params: CallOptionsLike = {
      ...baseParams(),
      providerOptions: { other: { keep: 1 } },
    };
    const original = structuredClone(params);
    const originalOptions = params.providerOptions;

    const result = await middleware.transformParams({ params });

    expect(params).toEqual(original);
    expect(params.providerOptions).toBe(originalOptions);
    expect(result).not.toBe(params);
    expect(result.providerOptions).not.toBe(originalOptions);
    // Foreign provider options ride through into the result untouched.
    expect(bagOf(result, 'other')).toEqual({ keep: 1 });
  });
});

describe('default segmenter', () => {
  it('maps system, tools, history, and the live turn onto plan geometry', async () => {
    const { racs, plans } = harness();
    const middleware = racsMiddleware(racs, {
      provider: 'anthropic',
      model: 'claude-sonnet-4-5',
    });

    // Hand-computed content lengths at 4 chars per token:
    // - system: 4800 chars -> 1200 tokens.
    // - tools JSON: {"lookup":{"description":"<100 d>"}} is 26 + 100 + 3 = 129 chars
    //   -> ceil(129 / 4) = 33 tokens.
    // - history JSON of the first two messages: [ + 68 + , + 73 + ] = 144 chars
    //   ({"role":"user","content":"<40 x>"} is 68, the assistant variant is 73)
    //   -> 36 tokens.
    // - dynamic JSON of the final message: 68 chars -> 17 tokens.
    const params: CallOptionsLike = {
      system: 's'.repeat(4800),
      tools: { lookup: { description: 'd'.repeat(100) } },
      prompt: [
        { role: 'user', content: 'x'.repeat(40) },
        { role: 'assistant', content: 'y'.repeat(40) },
        { role: 'user', content: 'z'.repeat(40) },
      ],
    };
    await middleware.transformParams({ params });

    const plan = at(plans, 0);
    expect(plan.stableTokens).toBe(1200 + 33 + 36);
    expect(plan.totalTokens).toBe(1200 + 33 + 36 + 17);
    // The breakpoints land at the ends of the segments the segmenter derived, in
    // request order, confirming the segment ids and roles it assigned.
    expect(plan.directives).toEqual([
      { kind: 'breakpoint', segmentId: 'system', ttl: '5m' },
      { kind: 'breakpoint', segmentId: 'tools', ttl: '5m' },
      { kind: 'breakpoint', segmentId: 'history', ttl: '5m' },
    ]);
  });

  it('a custom segmenter overrides the default entirely', async () => {
    const { racs, plans } = harness();
    const seen: CallOptionsLike[] = [];
    const middleware = racsMiddleware(racs, {
      provider: 'anthropic',
      model: 'claude-sonnet-4-5',
      segmenter: (params) => {
        seen.push(params);
        return [
          {
            id: 'pinned',
            role: 'system',
            stability: 'stable',
            contentHash: 'feedface',
            tokens: 2000,
          },
          { id: 'live', role: 'dynamic', stability: 'volatile', content: 'q' },
        ];
      },
    });

    const params = baseParams();
    await middleware.transformParams({ params });

    expect(seen.length).toBe(1);
    expect(at(seen, 0)).toBe(params);
    const plan = at(plans, 0);
    // The declared 2000 exact tokens prove the default segmenter never ran.
    expect(plan.stableTokens).toBe(2000);
    expect(plan.directives).toEqual([{ kind: 'breakpoint', segmentId: 'pinned', ttl: '5m' }]);
  });
});

describe('wrapGenerate', () => {
  it('records attributed usage with the hit flag from cachedInputTokens', async () => {
    const { racs, events } = harness();
    const middleware = racsMiddleware(racs, {
      provider: 'anthropic',
      model: 'claude-sonnet-4-5',
    });
    const params = await middleware.transformParams({ params: baseParams() });
    const prefixKey = bagOf(params, 'racs').prefixKey;

    const generateResult = { usage: { inputTokens: 5000, cachedInputTokens: 4200 } };
    const result = await middleware.wrapGenerate({
      doGenerate: () => Promise.resolve(generateResult),
      params,
    });
    expect(result).toBe(generateResult);

    const recorded = recordedUsages(events);
    expect(recorded.length).toBe(1);
    expect(at(recorded, 0).hit).toBe(true);
    expect(at(recorded, 0).usage).toMatchObject({
      provider: 'anthropic',
      model: 'claude-sonnet-4-5',
      prefixKey,
      inputTokens: 5000,
      cacheReadTokens: 4200,
    });
    expect('cacheWriteTokens5m' in at(recorded, 0).usage).toBe(false);

    // Hand-computed prefix stats: reads 4200, uncached 5000 - 4200 = 800, hit ratio
    // 4200 / (4200 + 0 + 800) = 0.84.
    if (typeof prefixKey !== 'string') {
      throw new Error('expected the stash to carry a string prefixKey');
    }
    const stats = racs.stats({ prefixKey });
    expect(stats.calls).toBe(1);
    expect(stats.hitRatio).toBe(0.84);
  });

  it('prefers inputTokenDetails and falls back to anthropic provider metadata', async () => {
    const { racs, events } = harness();
    const middleware = racsMiddleware(racs, {
      provider: 'anthropic',
      model: 'claude-sonnet-4-5',
    });
    const params = await middleware.transformParams({ params: baseParams() });

    // The nested detail spelling wins over the flattened cachedInputTokens.
    await middleware.wrapGenerate({
      doGenerate: () =>
        Promise.resolve({
          usage: {
            inputTokens: 100,
            cachedInputTokens: 4200,
            inputTokenDetails: { cacheReadTokens: 70, cacheWriteTokens: 30 },
          },
        }),
      params,
    });
    // With no usage counters at all, the anthropic provider metadata fills both counts.
    await middleware.wrapGenerate({
      doGenerate: () =>
        Promise.resolve({
          providerMetadata: {
            anthropic: { cacheReadInputTokens: 999, cacheCreationInputTokens: 111 },
          },
        }),
      params,
    });

    const recorded = recordedUsages(events);
    expect(recorded.length).toBe(2);
    // 100 >= 70 + 30, so the counts pass for all-in and ride through unadjusted.
    expect(at(recorded, 0).usage).toMatchObject({
      inputTokens: 100,
      cacheReadTokens: 70,
      cacheWriteTokens5m: 30,
    });
    // The raw Anthropic metadata counts are exclusive (input 0 < 999 + 111 proves it),
    // so the all-in input is hand-computed as 0 + 999 + 111 = 1110.
    expect(at(recorded, 1).usage).toMatchObject({
      inputTokens: 1110,
      cacheReadTokens: 999,
      cacheWriteTokens5m: 111,
    });
  });

  it('normalizes exclusive raw Anthropic counts to the all-in input convention', async () => {
    const { racs, events } = harness();
    const middleware = racsMiddleware(racs, {
      provider: 'anthropic',
      model: 'claude-sonnet-4-5',
    });
    const params = await middleware.transformParams({ params: baseParams() });

    // The write call of the council workload: 200 fresh + 4000 written. The raw
    // Anthropic counters are exclusive, detected because 200 < 0 + 4000, so the
    // recorded all-in input is 200 + 4000 = 4200.
    await middleware.wrapGenerate({
      doGenerate: () =>
        Promise.resolve({
          usage: { inputTokens: 200 },
          providerMetadata: {
            anthropic: { cacheReadInputTokens: 0, cacheCreationInputTokens: 4000 },
          },
        }),
      params,
    });
    // A read call: 200 fresh + 4000 cached reads, 200 < 4000 + 0, all-in 4200.
    await middleware.wrapGenerate({
      doGenerate: () =>
        Promise.resolve({
          usage: { inputTokens: 200 },
          providerMetadata: {
            anthropic: { cacheReadInputTokens: 4000, cacheCreationInputTokens: 0 },
          },
        }),
      params,
    });
    // An already-all-in SDK shape: 4200 >= 4000, nothing is added.
    await middleware.wrapGenerate({
      doGenerate: () => Promise.resolve({ usage: { inputTokens: 4200, cachedInputTokens: 4000 } }),
      params,
    });

    const recorded = recordedUsages(events);
    expect(recorded.length).toBe(3);
    expect(at(recorded, 0).usage).toMatchObject({
      inputTokens: 4200,
      cacheReadTokens: 0,
      cacheWriteTokens5m: 4000,
    });
    expect(at(recorded, 1).usage).toMatchObject({
      inputTokens: 4200,
      cacheReadTokens: 4000,
      cacheWriteTokens5m: 0,
    });
    expect(at(recorded, 2).usage).toMatchObject({
      inputTokens: 4200,
      cacheReadTokens: 4000,
    });
  });

  it('records unattributed usage under provider:model when the stash is stripped', async () => {
    const { racs, events } = harness();
    const middleware = racsMiddleware(racs, {
      provider: 'anthropic',
      model: 'claude-sonnet-4-5',
    });

    // The host skipped transformParams entirely, so no RACS stash exists.
    await middleware.wrapGenerate({
      doGenerate: () => Promise.resolve({ usage: { inputTokens: 1000, cachedInputTokens: 0 } }),
      params: baseParams(),
    });

    const recorded = recordedUsages(events);
    expect(recorded.length).toBe(1);
    expect(at(recorded, 0).hit).toBe(false);
    expect('prefixKey' in at(recorded, 0).usage).toBe(false);
    // The ledger aggregates the plan-less call under the synthetic provider:model key.
    expect(racs.stats().prefixes.map((prefix) => prefix.prefixKey)).toEqual([
      'anthropic:claude-sonnet-4-5',
    ]);
  });

  it('rethrows a doGenerate failure without recording anything', async () => {
    const { racs, events } = harness();
    const middleware = racsMiddleware(racs, {
      provider: 'anthropic',
      model: 'claude-sonnet-4-5',
    });
    const params = await middleware.transformParams({ params: baseParams() });
    const eventsBefore = events.length;

    await expect(
      middleware.wrapGenerate({
        doGenerate: () => Promise.reject(new Error('generate exploded')),
        params,
      }),
    ).rejects.toThrow('generate exploded');

    expect(events.length).toBe(eventsBefore);
    expect(racs.stats().calls).toBe(0);
  });
});

describe('wrapStream', () => {
  it('tees the stream untouched and records from the finish part inputTokenDetails', async () => {
    const { racs, events } = harness();
    const middleware = racsMiddleware(racs, {
      provider: 'anthropic',
      model: 'claude-sonnet-4-5',
    });
    const params = await middleware.transformParams({ params: baseParams() });
    const prefixKey = bagOf(params, 'racs').prefixKey;

    const parts: unknown[] = [
      { type: 'text-delta', delta: 'Hello' },
      { type: 'text-delta', delta: ' world' },
      {
        type: 'finish',
        usage: {
          inputTokens: 3000,
          inputTokenDetails: { cacheReadTokens: 2500, cacheWriteTokens: 200 },
        },
      },
    ];
    const result = await middleware.wrapStream({
      doStream: () => Promise.resolve({ stream: sourceStream(parts), request: { marker: 7 } }),
      params,
    });

    // Sibling result fields ride through untouched.
    expect(result.request).toEqual({ marker: 7 });

    // Nothing is recorded until the stream has fully drained.
    expect(recordedUsages(events)).toEqual([]);

    const received = await readAll(result.stream);
    expect(received.length).toBe(3);
    // Every part arrives downstream by reference, in order, untouched.
    received.forEach((part, index) => {
      expect(part).toBe(at(parts, index));
    });

    const recorded = recordedUsages(events);
    expect(recorded.length).toBe(1);
    expect(at(recorded, 0).hit).toBe(true);
    expect(at(recorded, 0).usage).toMatchObject({
      prefixKey,
      inputTokens: 3000,
      cacheReadTokens: 2500,
      cacheWriteTokens5m: 200,
    });
  });

  it('falls back to the finish part totalUsage when usage is absent', async () => {
    const { racs, events } = harness();
    const middleware = racsMiddleware(racs, {
      provider: 'anthropic',
      model: 'claude-sonnet-4-5',
    });
    const params = await middleware.transformParams({ params: baseParams() });

    const parts: unknown[] = [
      { type: 'text-delta', delta: 'chunk' },
      { type: 'finish', totalUsage: { inputTokens: 1000, cachedInputTokens: 800 } },
    ];
    const result = await middleware.wrapStream({
      doStream: () => Promise.resolve({ stream: sourceStream(parts) }),
      params,
    });
    await readAll(result.stream);

    const recorded = recordedUsages(events);
    expect(recorded.length).toBe(1);
    expect(at(recorded, 0).usage).toMatchObject({
      inputTokens: 1000,
      cacheReadTokens: 800,
    });
    expect(at(recorded, 0).hit).toBe(true);
  });
});
