/**
 * OpenTelemetry GenAI ingestion for RACS (Remote Agent Context Store): turns one finished
 * GenAI span into one normalized {@link CacheUsage} record for cache analytics.
 *
 * Structural by design. This module declares its own {@link GenAISpanLike} shape instead
 * of importing OpenTelemetry types, so the package keeps its zero-runtime-dependency
 * invariant: any span object that structurally matches works, whether it comes from the
 * OpenTelemetry JS SDK, an OTLP JSON payload, a collector processor, hermes-otel spans, or
 * the spans Vercel AI SDK telemetry emits with `experimental_telemetry` enabled.
 *
 * Privacy contract: {@link usageFromSpan} reads only the provider attribute, the model
 * attributes, the usage counters, and the span end time. It never reads prompt or
 * completion content attributes (`gen_ai.prompt`, `gen_ai.completion`, event bodies, or
 * any other content-bearing field), so wiring it into a span pipeline leaks nothing.
 *
 * @packageDocumentation
 */

import type { CacheUsage, ProviderId } from '../types.js';

/**
 * Minimal structural shape of one GenAI span, the subset {@link usageFromSpan} reads.
 *
 * Matches both live SDK spans (numeric attribute values) and OTLP JSON spans, where int64
 * values arrive as decimal strings, which is why the time fields and the numeric attribute
 * reads accept strings.
 */
export interface GenAISpanLike {
  /** Span name, unused by ingestion, present so real spans match without widening. */
  readonly name?: string;
  /** Flat attribute bag, GenAI semantic-convention keys, values of any wire type. */
  readonly attributes?: Readonly<Record<string, unknown>>;
  /** Span start in nanoseconds since the Unix epoch, number or OTLP decimal string. */
  readonly startTimeUnixNano?: number | string;
  /** Span end in nanoseconds since the Unix epoch, number or OTLP decimal string. */
  readonly endTimeUnixNano?: number | string;
}

/**
 * Mapping from `gen_ai.system` attribute values to RACS provider ids, per the
 * OpenTelemetry GenAI semantic conventions as of June 2026. Instrumentations disagree on
 * the Google and Mistral spellings, so every spelling seen in the wild maps here.
 * Lookup is case-insensitive, values are lowercased before the table is consulted.
 */
const GEN_AI_SYSTEM_TO_PROVIDER: Readonly<Record<string, ProviderId>> = {
  anthropic: 'anthropic',
  openai: 'openai',
  'gcp.gemini': 'google',
  gemini: 'google',
  google: 'google',
  'aws.bedrock': 'bedrock',
  groq: 'groq',
  deepseek: 'deepseek',
  mistral_ai: 'mistral',
  mistral: 'mistral',
  xai: 'xai',
};

/**
 * Token-count attribute names for cached reads, in lookup order. Instrumentations
 * disagree, so the first numeric value among them wins. Each spelling also pins the
 * input-token convention of its source, which decides the all-in normalization in
 * {@link usageFromSpan}:
 *
 * - `'gen_ai.usage.cache_read_input_tokens'`: Anthropic-flavored instrumentations,
 *   including hermes-otel, mirror the raw `usage.cache_read_input_tokens` response field
 *   under this name. EXCLUSIVE convention: the matching `gen_ai.usage.input_tokens`
 *   mirrors raw Anthropic `input_tokens`, which excludes cache reads and cache writes, so
 *   the read count is ADDED to reach the all-in total.
 * - `'gen_ai.usage.cached_tokens'`: OpenAI-flavored instrumentations in the OpenLLMetry
 *   lineage mirror `prompt_tokens_details.cached_tokens` under this name. INCLUSIVE
 *   convention: OpenAI `cached_tokens` is a subset of `prompt_tokens`, so nothing is
 *   added.
 * - `'gen_ai.usage.input_cached_tokens'`: the newer semantic-convention draft naming some
 *   collectors and SDK instrumentations have adopted, descending from the OpenAI detail
 *   shape. INCLUSIVE convention, nothing is added.
 */
const CACHE_READ_ATTRIBUTES: readonly string[] = [
  'gen_ai.usage.cache_read_input_tokens',
  'gen_ai.usage.cached_tokens',
  'gen_ai.usage.input_cached_tokens',
];

/**
 * The one read spelling whose source reports EXCLUSIVE input counts, see
 * {@link CACHE_READ_ATTRIBUTES} for the per-attribute convention catalog.
 */
const EXCLUSIVE_READ_ATTRIBUTE = 'gen_ai.usage.cache_read_input_tokens';

/**
 * Token-count attribute names for cache writes, in lookup order:
 *
 * - `'gen_ai.usage.cache_creation_input_tokens'`: Anthropic-flavored instrumentations
 *   mirror the raw `usage.cache_creation_input_tokens` response field. EXCLUSIVE
 *   convention: raw Anthropic `input_tokens` excludes written tokens, so the write count
 *   is ADDED to reach the all-in input total.
 * - `'gen_ai.usage.cache_write_input_tokens'`: the generic spelling other
 *   instrumentations use for the same quantity. Write counters exist only on
 *   breakpoint-family providers whose raw usage excludes them from the input count, so
 *   this spelling follows the same EXCLUSIVE convention and is ADDED likewise.
 *
 * TTL attribution convention: the GenAI semantic conventions carry no TTL split, a write
 * is just a write, so every written token is attributed to {@link CacheUsage.cacheWriteTokens5m},
 * the 5-minute tier, the conservative default because it is the cheaper write premium.
 * Hosts that know a span wrote a 1-hour span should move the count to
 * `cacheWriteTokens1h` before recording.
 */
const CACHE_WRITE_ATTRIBUTES: readonly string[] = [
  'gen_ai.usage.cache_creation_input_tokens',
  'gen_ai.usage.cache_write_input_tokens',
];

/** True for any non-null object, the first gate of every structural check. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/**
 * Reads one attribute as a finite non-negative token count. Accepts plain numbers and
 * OTLP JSON int64 values, which arrive as decimal strings, anything else is absent.
 */
function countOf(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
    return value;
  }
  if (typeof value === 'string' && /^\d+$/.test(value)) {
    return Number(value);
  }
  return undefined;
}

/** Reads one attribute as a non-empty string, anything else is absent. */
function stringOf(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

/**
 * Converts span end nanoseconds to milliseconds since the Unix epoch. OTLP decimal
 * strings go through BigInt so values above 2^53 nanoseconds, every realistic wall-clock
 * time, lose nothing before the division. Zero and negatives mean "not set" in OTLP and
 * come back absent.
 */
function endMillisOf(value: number | string | undefined): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    return Math.floor(value / 1_000_000);
  }
  if (typeof value === 'string' && /^\d+$/.test(value)) {
    const millis = Number(BigInt(value) / 1_000_000n);
    return millis > 0 ? millis : undefined;
  }
  return undefined;
}

/**
 * First numeric value among the named attributes, in order, with the attribute name that
 * supplied it, absent when none is numeric. The name matters: it pins which input-token
 * convention the source follows, see {@link CACHE_READ_ATTRIBUTES}.
 */
function firstCount(
  attributes: Readonly<Record<string, unknown>>,
  names: readonly string[],
): { readonly name: string; readonly count: number } | undefined {
  for (const name of names) {
    const count = countOf(attributes[name]);
    if (count !== undefined) {
      return { name, count };
    }
  }
  return undefined;
}

/**
 * Normalizes one finished GenAI span into one {@link CacheUsage} record, or `undefined`
 * when the span carries too little identity to account for.
 *
 * Field provenance, all reads structural and defensive:
 * - `provider`: inferred from the `gen_ai.system` attribute through the spelling table
 *   ({@link GEN_AI_SYSTEM_TO_PROVIDER}, case-insensitive). Unknown or missing spellings
 *   fall back to `fallback.provider`; with neither, the function returns `undefined`.
 * - `model`: `gen_ai.request.model`, then `gen_ai.response.model`, then `fallback.model`.
 *   A model is required for ledger attribution, without one the function returns
 *   `undefined`.
 * - `inputTokens`: `gen_ai.usage.input_tokens` (zero when absent), normalized to the
 *   ALL-IN convention {@link CacheUsage.inputTokens} documents. The matched cache
 *   attribute spellings decide the adjustment: an Anthropic-flavored read count
 *   (`cache_read_input_tokens`, EXCLUSIVE) is added, an OpenAI-flavored read count
 *   (`cached_tokens`, `input_cached_tokens`, INCLUSIVE subsets of `input_tokens`) is not,
 *   and any write count is added because write counters only exist on providers whose raw
 *   input count excludes them. Per-attribute conventions are documented on
 *   {@link CACHE_READ_ATTRIBUTES} and {@link CACHE_WRITE_ATTRIBUTES}.
 * - `cacheReadTokens`: the first numeric among the read spellings, see
 *   {@link CACHE_READ_ATTRIBUTES} for why three names exist. Zero when none is present.
 * - `cacheWriteTokens5m`: the first numeric among the write spellings, see
 *   {@link CACHE_WRITE_ATTRIBUTES} for the 5-minute attribution convention. Omitted when
 *   absent.
 * - `timestamp`: the span end time converted from nanoseconds, omitted when the span
 *   carries none, in which case {@link RACS.record} stamps it with the engine clock.
 *
 * `prefixKey` is never set here: the GenAI conventions carry no prefix identity, so spans
 * aggregate into ledger totals. Hosts that track the plan per call can spread one in
 * before recording: `racs.record({ ...usage, prefixKey: plan.prefixKey })`.
 *
 * Privacy: only provider, model, usage counters, and the end timestamp are read, never
 * `gen_ai.prompt`, `gen_ai.completion`, or any other content attribute.
 *
 * @param span - Any structurally matching span, see {@link GenAISpanLike}.
 * @param fallback - Provider and model to use when the span attributes lack them, the
 * usual case for telemetry pipelines that already know which client they instrument.
 * @returns A normalized usage record ready for {@link RACS.record}, or `undefined` when
 * neither the span nor the fallback yields a provider and a model.
 *
 * @example
 * Wiring span ingestion into a RACS engine. The same hook shape works for hermes-otel
 * spans and for the spans Vercel AI SDK telemetry emits with `experimental_telemetry`:
 * ```ts
 * import { createRACS } from '@takk/racs';
 * import { usageFromSpan, type GenAISpanLike } from '@takk/racs/otel';
 *
 * const racs = createRACS();
 *
 * // Inside a span processor's onEnd, an OTLP collector hook, or wherever finished
 * // spans surface in the host:
 * function onSpanEnd(span: GenAISpanLike): void {
 *   const usage = usageFromSpan(span, { provider: 'anthropic' });
 *   if (usage !== undefined) {
 *     racs.record(usage);
 *   }
 * }
 *
 * // Later, the same analytics as any other ingestion path:
 * const { hitRatio, savedUsd } = racs.stats();
 * ```
 */
export function usageFromSpan(
  span: GenAISpanLike,
  fallback?: { provider?: ProviderId; model?: string },
): CacheUsage | undefined {
  const attributes: Readonly<Record<string, unknown>> = isRecord(span.attributes)
    ? span.attributes
    : {};

  const system = stringOf(attributes['gen_ai.system']);
  const mapped = system === undefined ? undefined : GEN_AI_SYSTEM_TO_PROVIDER[system.toLowerCase()];
  const provider = mapped ?? fallback?.provider;
  if (provider === undefined) {
    return undefined;
  }

  const model =
    stringOf(attributes['gen_ai.request.model']) ??
    stringOf(attributes['gen_ai.response.model']) ??
    fallback?.model;
  if (model === undefined) {
    return undefined;
  }

  const rawInputTokens = countOf(attributes['gen_ai.usage.input_tokens']) ?? 0;
  const read = firstCount(attributes, CACHE_READ_ATTRIBUTES);
  const write = firstCount(attributes, CACHE_WRITE_ATTRIBUTES);
  const timestamp = endMillisOf(span.endTimeUnixNano);

  // All-in normalization, see CacheUsage.inputTokens: the Anthropic-flavored read
  // spelling marks an exclusive source whose input count omits cached reads, so the read
  // count is added back; the OpenAI-flavored spellings are inclusive subsets and add
  // nothing. Write counts are always added, both write spellings mirror raw counts that
  // their source excludes from the input count.
  const exclusiveRead = read !== undefined && read.name === EXCLUSIVE_READ_ATTRIBUTE;
  const inputTokens = rawInputTokens + (exclusiveRead ? read.count : 0) + (write?.count ?? 0);
  const cacheReadTokens = read?.count ?? 0;
  const cacheWriteTokens5m = write?.count;

  return {
    provider,
    model,
    inputTokens,
    cacheReadTokens,
    ...(cacheWriteTokens5m !== undefined ? { cacheWriteTokens5m } : {}),
    ...(timestamp !== undefined ? { timestamp } : {}),
  };
}
