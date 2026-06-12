/**
 * Token estimation helpers for RACS (Remote Agent Context Store).
 *
 * Estimates exist to gate minimum-token planning decisions (is this prefix long enough to
 * cache at all, does the write premium pay back), never to bill anyone. Exact counts come
 * from provider usage reports recorded after the fact, and callers with a real tokenizer
 * should pass explicit token counts, which always win, see {@link tokensOf}.
 *
 * Pure module: no dependencies, no randomness, no clock, runs everywhere.
 *
 * @packageDocumentation
 */

/**
 * Characters per token in the industry rule-of-thumb heuristic for English-leaning text,
 * "1 token ~= 4 characters" as published in OpenAI's tokenizer guidance and echoed across
 * provider documentation (retrieved June 2026). Real ratios vary by language, code
 * density, and tokenizer, which is why this number only feeds planning thresholds.
 */
const CHARS_PER_TOKEN = 4;

/**
 * Estimates the token count of `content` as the ceiling of its UTF-16 length divided by
 * 4, the industry characters-per-token heuristic (see {@link CHARS_PER_TOKEN}).
 *
 * Accuracy contract: this is a planning estimate, not a measurement. It is typically
 * within tens of percent for English prose and can be off by more for CJK text or dense
 * code. Exact counts come from provider usage reports; estimates only gate minimum-token
 * planning such as the `'below-minimum'` lint and break-even math. Pass exact counts from
 * a provider tokenizer whenever precision matters.
 *
 * @param content - The text to estimate, measured by UTF-16 length, no normalization.
 * @returns Non-negative integer estimate, 0 for the empty string.
 */
export function estimateTokens(content: string): number {
  return Math.ceil(content.length / CHARS_PER_TOKEN);
}

/**
 * Resolves the token count of one segment-shaped value, preferring an explicit `tokens`
 * field over the {@link estimateTokens} heuristic on `content`.
 *
 * Resolution order:
 * 1. `tokens` when present, the caller measured it with a real tokenizer, trust it.
 * 2. `estimateTokens(content)` when only `content` is present.
 * 3. 0 when neither is present, which is the hash-only privacy mode without a declared
 *    count: the segment deliberately contributes nothing to break-even math.
 *
 * @param segment - Any object carrying optional `content` and `tokens` fields.
 * @returns Explicit count, estimate, or 0, in that order of preference.
 */
export function tokensOf(segment: { content?: string; tokens?: number }): number {
  if (typeof segment.tokens === 'number') {
    return segment.tokens;
  }
  if (typeof segment.content === 'string') {
    return estimateTokens(segment.content);
  }
  return 0;
}
