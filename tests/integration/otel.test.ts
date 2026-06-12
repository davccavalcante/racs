/**
 * Integration tests for the OpenTelemetry GenAI ingestion path: provider inference from
 * gen_ai.system spellings, model resolution order, cache counter fallback chains, OTLP
 * timestamp conversion, and the full loop from a finished span through RACS.record into
 * ledger statistics.
 *
 * Determinism: the only engine here runs with seed 7 and a fixed injected clock.
 */

import { describe, expect, it } from 'vitest';
import type { ProviderId, TelemetryEvent } from '../../src/index.js';
import { createRACS } from '../../src/index.js';
import type { GenAISpanLike } from '../../src/otel/index.js';
import { usageFromSpan } from '../../src/otel/index.js';

/** Fixed engine clock, milliseconds since the Unix epoch. */
const T0 = 1_750_000_000_000;

/** Builds a span around one attribute bag. */
const spanWith = (attributes: Record<string, unknown>): GenAISpanLike => ({
  name: 'chat claude-sonnet-4-5',
  attributes,
});

/** Resolves a usage record or fails the test, narrowing away undefined. */
function mustResolve(span: GenAISpanLike, fallback?: { provider?: ProviderId; model?: string }) {
  const usage = usageFromSpan(span, fallback);
  if (usage === undefined) {
    throw new Error('expected usageFromSpan to resolve a usage record');
  }
  return usage;
}

describe('provider inference', () => {
  const table: ReadonlyArray<readonly [string, ProviderId]> = [
    ['anthropic', 'anthropic'],
    ['openai', 'openai'],
    ['gcp.gemini', 'google'],
    ['aws.bedrock', 'bedrock'],
    ['mistral_ai', 'mistral'],
  ];

  it.each(table)('maps gen_ai.system %s to provider %s', (system, provider) => {
    const usage = mustResolve(spanWith({ 'gen_ai.system': system, 'gen_ai.request.model': 'm' }));
    expect(usage.provider).toBe(provider);
  });

  it('lowercases the spelling before the table lookup', () => {
    const usage = mustResolve(
      spanWith({ 'gen_ai.system': 'GCP.Gemini', 'gen_ai.request.model': 'm' }),
    );
    expect(usage.provider).toBe('google');
  });

  it('falls back to the caller-supplied provider for unknown spellings', () => {
    const usage = mustResolve(
      spanWith({ 'gen_ai.system': 'replicate', 'gen_ai.request.model': 'm' }),
      { provider: 'custom' },
    );
    expect(usage.provider).toBe('custom');
  });

  it('returns undefined for unknown spellings without a fallback', () => {
    expect(
      usageFromSpan(spanWith({ 'gen_ai.system': 'replicate', 'gen_ai.request.model': 'm' })),
    ).toBeUndefined();
  });

  it('returns undefined when the system attribute is missing and no fallback exists', () => {
    expect(usageFromSpan(spanWith({ 'gen_ai.request.model': 'm' }))).toBeUndefined();
  });
});

describe('model resolution order', () => {
  it('prefers gen_ai.request.model over gen_ai.response.model over the fallback', () => {
    const usage = mustResolve(
      spanWith({
        'gen_ai.system': 'anthropic',
        'gen_ai.request.model': 'requested-model',
        'gen_ai.response.model': 'served-model',
      }),
      { model: 'fallback-model' },
    );
    expect(usage.model).toBe('requested-model');
  });

  it('uses gen_ai.response.model when the request model is absent', () => {
    const usage = mustResolve(
      spanWith({ 'gen_ai.system': 'anthropic', 'gen_ai.response.model': 'served-model' }),
      { model: 'fallback-model' },
    );
    expect(usage.model).toBe('served-model');
  });

  it('uses the fallback model when the span names none', () => {
    const usage = mustResolve(spanWith({ 'gen_ai.system': 'anthropic' }), {
      model: 'fallback-model',
    });
    expect(usage.model).toBe('fallback-model');
  });

  it('returns undefined when the model is missing everywhere', () => {
    expect(usageFromSpan(spanWith({ 'gen_ai.system': 'anthropic' }))).toBeUndefined();
  });
});

describe('cache read fallbacks', () => {
  const base = { 'gen_ai.system': 'anthropic', 'gen_ai.request.model': 'm' };

  it('prefers cache_read_input_tokens over cached_tokens over input_cached_tokens', () => {
    const usage = mustResolve(
      spanWith({
        ...base,
        'gen_ai.usage.cache_read_input_tokens': 111,
        'gen_ai.usage.cached_tokens': 222,
        'gen_ai.usage.input_cached_tokens': 333,
      }),
    );
    expect(usage.cacheReadTokens).toBe(111);
  });

  it('falls to cached_tokens when the first spelling is absent', () => {
    const usage = mustResolve(
      spanWith({
        ...base,
        'gen_ai.usage.cached_tokens': 222,
        'gen_ai.usage.input_cached_tokens': 333,
      }),
    );
    expect(usage.cacheReadTokens).toBe(222);
  });

  it('falls to input_cached_tokens when only it is present', () => {
    const usage = mustResolve(spanWith({ ...base, 'gen_ai.usage.input_cached_tokens': 333 }));
    expect(usage.cacheReadTokens).toBe(333);
  });

  it('skips non-numeric values in the chain and accepts OTLP decimal strings', () => {
    const usage = mustResolve(
      spanWith({
        ...base,
        'gen_ai.usage.cache_read_input_tokens': 'not-a-count',
        'gen_ai.usage.cached_tokens': '222',
      }),
    );
    expect(usage.cacheReadTokens).toBe(222);
  });

  it('defaults to zero when no read spelling is present', () => {
    const usage = mustResolve(spanWith({ ...base, 'gen_ai.usage.input_tokens': 50 }));
    expect(usage.cacheReadTokens).toBe(0);
  });
});

describe('cache write fallbacks', () => {
  const base = { 'gen_ai.system': 'anthropic', 'gen_ai.request.model': 'm' };

  it('prefers cache_creation_input_tokens over cache_write_input_tokens', () => {
    const usage = mustResolve(
      spanWith({
        ...base,
        'gen_ai.usage.cache_creation_input_tokens': 400,
        'gen_ai.usage.cache_write_input_tokens': 500,
      }),
    );
    expect(usage.cacheWriteTokens5m).toBe(400);
  });

  it('falls to cache_write_input_tokens when the Anthropic spelling is absent', () => {
    const usage = mustResolve(spanWith({ ...base, 'gen_ai.usage.cache_write_input_tokens': 500 }));
    expect(usage.cacheWriteTokens5m).toBe(500);
  });

  it('omits the field entirely when no write spelling is present', () => {
    const usage = mustResolve(spanWith({ ...base }));
    expect('cacheWriteTokens5m' in usage).toBe(false);
  });
});

describe('all-in input normalization', () => {
  const base = { 'gen_ai.system': 'anthropic', 'gen_ai.request.model': 'm' };

  it('adds an Anthropic-flavored exclusive read count to input_tokens', () => {
    // Raw Anthropic counts are exclusive: input_tokens 200 carries only the fresh input,
    // so all-in = 200 fresh + 4000 cached reads = 4200.
    const usage = mustResolve(
      spanWith({
        ...base,
        'gen_ai.usage.input_tokens': 200,
        'gen_ai.usage.cache_read_input_tokens': 4000,
        'gen_ai.usage.cache_creation_input_tokens': 0,
      }),
    );
    expect(usage.inputTokens).toBe(4200);
    expect(usage.cacheReadTokens).toBe(4000);
  });

  it('adds an Anthropic-flavored exclusive write count to input_tokens', () => {
    // The write call of the same lineage: all-in = 200 fresh + 4000 written = 4200.
    const usage = mustResolve(
      spanWith({
        ...base,
        'gen_ai.usage.input_tokens': 200,
        'gen_ai.usage.cache_read_input_tokens': 0,
        'gen_ai.usage.cache_creation_input_tokens': 4000,
      }),
    );
    expect(usage.inputTokens).toBe(4200);
    expect(usage.cacheWriteTokens5m).toBe(4000);
  });

  it('adds the generic cache_write_input_tokens spelling likewise', () => {
    // Write counters only exist on providers whose raw input count excludes them, so the
    // generic spelling follows the exclusive convention: all-in = 200 + 4000 = 4200.
    const usage = mustResolve(
      spanWith({
        ...base,
        'gen_ai.usage.input_tokens': 200,
        'gen_ai.usage.cache_write_input_tokens': 4000,
      }),
    );
    expect(usage.inputTokens).toBe(4200);
  });

  it('never adds an OpenAI-flavored inclusive cached_tokens subset', () => {
    // OpenAI-style cached_tokens is an inclusive subset of input_tokens: 5000 already
    // contains the 4200 cached reads, so the all-in total stays 5000.
    const usage = mustResolve(
      spanWith({
        ...base,
        'gen_ai.usage.input_tokens': 5000,
        'gen_ai.usage.cached_tokens': 4200,
      }),
    );
    expect(usage.inputTokens).toBe(5000);
    expect(usage.cacheReadTokens).toBe(4200);
  });

  it('treats the input_cached_tokens semconv draft spelling as inclusive too', () => {
    const usage = mustResolve(
      spanWith({
        ...base,
        'gen_ai.usage.input_tokens': 5000,
        'gen_ai.usage.input_cached_tokens': 4200,
      }),
    );
    expect(usage.inputTokens).toBe(5000);
  });
});

describe('timestamps', () => {
  const base = { 'gen_ai.system': 'anthropic', 'gen_ai.request.model': 'm' };

  it('converts BigInt-sized OTLP decimal string nanoseconds to milliseconds', () => {
    // 1,750,000,000,123,456,789 ns exceeds 2^53, the BigInt path truncates to ms.
    const usage = mustResolve({
      ...spanWith(base),
      endTimeUnixNano: '1750000000123456789',
    });
    expect(usage.timestamp).toBe(1_750_000_000_123);
  });

  it('converts numeric nanoseconds to milliseconds', () => {
    const usage = mustResolve({
      ...spanWith(base),
      endTimeUnixNano: 1_700_000_000_000_000_000,
    });
    expect(usage.timestamp).toBe(1_700_000_000_000);
  });

  it('treats zero and missing end times as not set', () => {
    expect('timestamp' in mustResolve({ ...spanWith(base), endTimeUnixNano: '0' })).toBe(false);
    expect('timestamp' in mustResolve(spanWith(base))).toBe(false);
  });
});

describe('full loop: span into record into stats', () => {
  it('normalizes one span and aggregates it in the ledger', () => {
    const racs = createRACS({ seed: 7, clock: () => T0 });
    const events: TelemetryEvent[] = [];
    racs.on((event) => {
      events.push(event);
    });

    const span: GenAISpanLike = {
      name: 'chat claude-sonnet-4-5',
      attributes: {
        'gen_ai.system': 'anthropic',
        'gen_ai.request.model': 'claude-sonnet-4-5',
        'gen_ai.usage.input_tokens': 1800,
        'gen_ai.usage.cache_read_input_tokens': 4200,
      },
      endTimeUnixNano: '1750000000123456789',
    };

    // The Anthropic-flavored read spelling marks exclusive counts: 1800 fresh input plus
    // 4200 cached reads normalize to the all-in 6000.
    const usage = mustResolve(span);
    expect(usage).toEqual({
      provider: 'anthropic',
      model: 'claude-sonnet-4-5',
      inputTokens: 6000,
      cacheReadTokens: 4200,
      timestamp: 1_750_000_000_123,
    });

    racs.record(usage);

    // The span timestamp rides into the telemetry record verbatim.
    const recorded = events.flatMap((event) => (event.type === 'usage.recorded' ? [event] : []));
    expect(recorded.length).toBe(1);
    expect(recorded.map((event) => [event.hit, event.timestamp])).toEqual([
      [true, 1_750_000_000_123],
    ]);

    // Hand-computed under the all-in convention: reads 4200, uncached 6000 - 4200 =
    // 1800, no writes, so the hit ratio is 4200 / (4200 + 0 + 1800) = 0.7. The span
    // carries no prefix identity, so the aggregate keys under the synthetic
    // provider:model pair.
    const stats = racs.stats({ provider: 'anthropic' });
    expect(stats.calls).toBe(1);
    expect(stats.readTokens).toBe(4200);
    expect(stats.writeTokens).toBe(0);
    expect(stats.uncachedTokens).toBe(1800);
    expect(stats.hitRatio).toBe(0.7);
    expect(stats.prefixes.map((prefix) => prefix.prefixKey)).toEqual([
      'anthropic:claude-sonnet-4-5',
    ]);
  });
});
