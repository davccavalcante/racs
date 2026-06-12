/**
 * otel-ingest.ts: feeding RACS (Remote Agent Context Store) from
 * OpenTelemetry GenAI spans. `usageFromSpan` is structural: any object
 * matching the span shape works, whether it comes from the OpenTelemetry JS
 * SDK, an OTLP JSON payload, a collector processor, hermes-otel spans, or
 * the spans Vercel AI SDK telemetry emits with `experimental_telemetry`.
 *
 * Privacy contract: only provider, model, token counters, and the end
 * timestamp are read. `gen_ai.prompt`, `gen_ai.completion`, and every other
 * content attribute are never touched.
 *
 * Run from the repository root:
 *   node --import tsx examples/otel-ingest.ts
 */

import { createRACS } from '@takk/racs';
import { usageFromSpan, type GenAISpanLike } from '@takk/racs/otel';

const racs = createRACS({
  seed: 7,
  pricing: {
    'claude-sonnet-4-5': { inputPerMTok: 3, cacheReadPerMTok: 0.3, cacheWrite5mPerMTok: 3.75 },
  },
});

// An Anthropic-flavored span, the spelling hermes-otel and most Anthropic
// instrumentations use. Numeric attribute values, SDK-style.
const anthropicSpan: GenAISpanLike = {
  name: 'chat claude-sonnet-4-5',
  attributes: {
    'gen_ai.system': 'anthropic',
    'gen_ai.request.model': 'claude-sonnet-4-5',
    'gen_ai.usage.input_tokens': 5200,
    'gen_ai.usage.cache_read_input_tokens': 4600,
    'gen_ai.usage.cache_creation_input_tokens': 0,
    // Content attributes exist on real spans; RACS never reads them:
    'gen_ai.prompt': '[REDACTED BY DESIGN, NEVER READ]',
  },
  endTimeUnixNano: 1_750_000_000_000_000_000,
};

// An OpenAI-flavored OTLP JSON span: int64 values arrive as decimal strings,
// and the cached-read counter uses the OpenLLMetry spelling.
const openaiSpan: GenAISpanLike = {
  name: 'chat gpt-bench',
  attributes: {
    'gen_ai.system': 'openai',
    'gen_ai.response.model': 'gpt-bench',
    'gen_ai.usage.input_tokens': '3100',
    'gen_ai.usage.cached_tokens': '2048',
  },
  endTimeUnixNano: '1750000060000000000',
};

// The ingestion hook: wherever finished spans surface in your host
// (a span processor's onEnd, an OTLP collector pipeline, a log tailer).
function onSpanEnd(span: GenAISpanLike): void {
  const usage = usageFromSpan(span);
  if (usage !== undefined) {
    racs.record(usage);
  }
}

onSpanEnd(anthropicSpan);
onSpanEnd(openaiSpan);

// A span with no resolvable provider and model is skipped, never guessed:
const unusable = usageFromSpan({ attributes: { 'gen_ai.usage.input_tokens': 10 } });
console.log('span without identity ->', unusable);

// Spans carry no prefix identity (the GenAI conventions have none), so they
// aggregate into ledger totals. Hosts that track the plan per call spread the
// prefix key in before recording: racs.record({ ...usage, prefixKey }).
const stats = racs.stats();
console.log('calls    :', stats.calls);
console.log('hit ratio:', stats.hitRatio.toFixed(3));
console.log('saved USD:', stats.savedUsd?.toFixed(6), '(anthropic model only; gpt-bench has no price card)');

await racs.close();
