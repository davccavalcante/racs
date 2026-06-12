/**
 * Deterministic structural linting of a {@link PlanInput} segment list, the documented
 * failure modes of production prefix caching caught before a single token is billed.
 *
 * Provider semantics this module leans on, researched June 2026:
 * - Prefix caches are strictly left-anchored on every provider family, so one volatile
 *   byte invalidates everything after it (Anthropic prompt caching docs, June 2026;
 *   OpenAI prompt caching guide, June 2026).
 * - Breakpoint providers hash tool definitions ahead of the message list, so a volatile
 *   `'tools'` segment defeats the cache for the whole request (Anthropic `cache_control`
 *   semantics, June 2026).
 * - Prefixes below the provider minimum are silently uncached, no error, no usage signal
 *   (1024 tokens on most Anthropic and OpenAI models as of June 2026); the minimum itself
 *   always comes from the {@link ProviderProfile}, never from constants here.
 *
 * Privacy contract: content heuristics run only on segments that carry `content`.
 * Hash-only segments (only `contentHash` present) are skipped by design, RACS never sees
 * their text so there is nothing to scan. Finding messages never embed matched substrings,
 * because findings travel inside persisted plans while segment content must never be
 * persisted; matches are referenced by a short content digest instead, which still lets
 * the owner locate the offending text in their own prompt source.
 *
 * Determinism: pure function of the input and profile, no clock, no randomness, findings
 * are emitted in a fixed order (structural lints, then per-segment scans in segment order,
 * then the prefix-level summary).
 */

import { fnv1a64 } from '../stats/hash.js';
import { tokensOf } from '../stats/tokens.js';
import type { LintFinding, PlanInput, PromptSegment, ProviderProfile } from '../types.js';

/** Result of one {@link PrefixAnalyzer.analyze} pass, pure data. */
export interface PrefixAnalysis {
  /** Lint findings in deterministic emission order. */
  findings: LintFinding[];
  /** Token total of the longest stable-or-semi run from the start, the cacheable prefix. */
  stableTokens: number;
  /** Token total of the whole prompt, exact or estimated per segment rules. */
  totalTokens: number;
  /** Index of the first volatile segment, `segments.length` when none is volatile. */
  orderedStableBoundary: number;
}

/** ISO-8601 datetime, date plus time with optional seconds, fraction, and offset. */
const ISO_8601_DATETIME =
  /\b\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:?\d{2})?\b/;

/** Unix epoch in seconds (10 digits) or milliseconds (13 digits), exact-length runs only. */
const UNIX_EPOCH = /\b(?:\d{13}|\d{10})\b/;

/**
 * The words 'today' or 'current time' within 32 characters of a digit on the same line,
 * the shape of an interpolated "Today is ..." or "current time: ..." system-prompt line.
 * Bounded quantifiers only, linear scan, no catastrophic backtracking.
 */
const RELATIVE_TIME_NEAR_DIGITS =
  /\b(?:today|current time)\b[^0-9\n\r]{0,32}[0-9]|[0-9][^0-9\n\r]{0,32}\b(?:today|current time)\b/i;

/** UUID v4 shape: version nibble 4, variant nibble 8 through b. */
const UUID_V4 = /\b[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/i;

/** Maximal run of 24 or more hex characters, the shape of request and trace ids. */
const HEX_RUN = /\b[0-9a-f]{24,}\b/i;

/**
 * Candidate base64-style run of 24 or more characters with optional padding. Greedy
 * matching makes each match maximal, candidates are then filtered in code to require at
 * least one digit and one letter, which excludes long prose words and long plain numbers.
 */
const BASE64_RUN = /[A-Za-z0-9+/]{24,}={0,2}/g;

/** Short digest of a matched substring, safe to persist where the substring is not. */
const digestOf = (match: string): string => fnv1a64(match).slice(0, 8);

/** First match of a non-global pattern, `undefined` when the pattern does not occur. */
const firstMatch = (pattern: RegExp, content: string): string | undefined => {
  const result = pattern.exec(content);
  return result ? result[0] : undefined;
};

/**
 * Structural linter over a segment list and one provider profile. Stateless, every call
 * is independent, safe to share one instance across plans.
 */
export class PrefixAnalyzer {
  /**
   * Runs every structural lint and computes the prefix geometry the planner needs.
   *
   * @param input - The plan input whose segments are analyzed, in request order.
   * @param profile - Effective provider profile, supplies `minCacheableTokens`.
   * @returns Findings plus the cacheable-prefix token counts and the volatile boundary.
   */
  analyze(input: PlanInput, profile: ProviderProfile): PrefixAnalysis {
    const segments = input.segments;

    let totalTokens = 0;
    let orderedStableBoundary = segments.length;
    let stableTokens = 0;
    for (const [index, segment] of segments.entries()) {
      const tokens = tokensOf(segment);
      totalTokens += tokens;
      if (index < orderedStableBoundary) {
        if (segment.stability === 'volatile') {
          orderedStableBoundary = index;
        } else {
          stableTokens += tokens;
        }
      }
    }

    const findings: LintFinding[] = [];
    this.lintSegmentOrder(segments, orderedStableBoundary, findings);
    this.lintVolatileEarly(
      segments,
      orderedStableBoundary,
      stableTokens,
      totalTokens,
      profile,
      findings,
    );
    for (const segment of segments) {
      this.lintSegment(segment, findings);
    }
    this.lintBelowMinimum(stableTokens, profile, findings);

    return { findings, stableTokens, totalTokens, orderedStableBoundary };
  }

  /** `'segment-order'`: the first volatile segment that precedes a cacheable one. */
  private lintSegmentOrder(
    segments: readonly PromptSegment[],
    orderedStableBoundary: number,
    findings: LintFinding[],
  ): void {
    const volatileSegment = segments[orderedStableBoundary];
    if (volatileSegment === undefined) {
      return;
    }
    for (let index = orderedStableBoundary + 1; index < segments.length; index += 1) {
      const later = segments[index];
      if (later !== undefined && later.stability !== 'volatile') {
        findings.push({
          severity: 'warning',
          code: 'segment-order',
          segmentId: volatileSegment.id,
          message:
            `Volatile segment '${volatileSegment.id}' precedes ${later.stability} segment ` +
            `'${later.id}'. Prefix caches are left-anchored, so every token after ` +
            `'${volatileSegment.id}' is unreachable for the cache. Reorder stable-first: move ` +
            `'${later.id}' and every other stable segment ahead of '${volatileSegment.id}'.`,
        });
        return;
      }
    }
  }

  /**
   * `'volatile-early'`: a volatile segment inside the first half of total tokens and
   * before any breakpoint-eligible boundary, the silent-cache-killer layout.
   *
   * A boundary is breakpoint-eligible only inside the leading stable run (a span that
   * contains volatile content can never be read back), so eligibility reduces to the
   * leading run reaching the provider minimum. The first volatile segment is reported, it
   * is the one that caps the run. Its start offset equals `stableTokens` by construction.
   */
  private lintVolatileEarly(
    segments: readonly PromptSegment[],
    orderedStableBoundary: number,
    stableTokens: number,
    totalTokens: number,
    profile: ProviderProfile,
    findings: LintFinding[],
  ): void {
    const volatileSegment = segments[orderedStableBoundary];
    if (volatileSegment === undefined || totalTokens === 0) {
      return;
    }
    const minimumEligible =
      profile.minCacheableTokens !== undefined && profile.minCacheableTokens > 0
        ? profile.minCacheableTokens
        : 1;
    const inFirstHalf = stableTokens * 2 < totalTokens;
    if (inFirstHalf && stableTokens < minimumEligible) {
      findings.push({
        severity: 'error',
        code: 'volatile-early',
        segmentId: volatileSegment.id,
        message:
          `Volatile segment '${volatileSegment.id}' sits inside the first half of the prompt ` +
          `(${stableTokens} of ${totalTokens} tokens precede it) and before any ` +
          `breakpoint-eligible boundary (provider minimum ${minimumEligible} tokens on ` +
          `'${profile.id}'). Nothing in this prompt can ever be cached. The usual culprits are ` +
          `timestamps or session metadata interpolated into the system prompt; move every ` +
          `per-call value to the end of the prompt and keep the opening segments byte-stable.`,
      });
    }
  }

  /** Per-segment lints: declaration checks always, content heuristics only with content. */
  private lintSegment(segment: PromptSegment, findings: LintFinding[]): void {
    if (segment.role === 'tools' && segment.stability === 'volatile') {
      findings.push({
        severity: 'error',
        code: 'unstable-tools',
        segmentId: segment.id,
        message:
          `Tools segment '${segment.id}' is declared volatile. Breakpoint providers hash tool ` +
          `definitions first, so volatile tools defeat the cache for the entire request. Tool ` +
          `instability is almost always a serialization bug, fix key ordering or remove ` +
          `timestamps from descriptions, then declare the segment stable.`,
      });
    }
    if (segment.role === 'dynamic' && segment.stability === 'stable') {
      findings.push({
        severity: 'info',
        code: 'missing-stability',
        segmentId: segment.id,
        message:
          `Segment '${segment.id}' has the dynamic role but is declared stable. Dynamic content ` +
          `is expected to differ on every call, which contradicts the declaration. Declare it ` +
          `volatile, or change the role if the content really is byte-stable.`,
      });
    }
    const content = segment.content;
    if (typeof content !== 'string') {
      return;
    }
    if (segment.stability === 'stable' || segment.stability === 'semi') {
      this.lintTimestamps(segment, content, findings);
    }
    if (segment.stability === 'stable') {
      this.lintIdentifiers(segment, content, findings);
    }
  }

  /** `'timestamp-in-stable'`: timestamp-like content inside a stable or semi segment. */
  private lintTimestamps(segment: PromptSegment, content: string, findings: LintFinding[]): void {
    const hits: string[] = [];
    const iso = firstMatch(ISO_8601_DATETIME, content);
    if (iso !== undefined) {
      hits.push(`an ISO-8601 datetime (digest ${digestOf(iso)})`);
    }
    const epoch = firstMatch(UNIX_EPOCH, content);
    if (epoch !== undefined) {
      hits.push(`a 10-or-13-digit unix epoch (digest ${digestOf(epoch)})`);
    }
    if (RELATIVE_TIME_NEAR_DIGITS.test(content)) {
      hits.push(`the words 'today' or 'current time' near digits`);
    }
    if (hits.length === 0) {
      return;
    }
    findings.push({
      severity: 'warning',
      code: 'timestamp-in-stable',
      segmentId: segment.id,
      message:
        `Segment '${segment.id}' is declared ${segment.stability} but contains ` +
        `${hits.join(', and ')}. A timestamp changes the prefix on every call and silently ` +
        `defeats the cache. Move live time values into a volatile segment at the prompt tail.`,
    });
  }

  /** `'identifier-in-stable'`: per-request identifier shapes inside a stable segment. */
  private lintIdentifiers(segment: PromptSegment, content: string, findings: LintFinding[]): void {
    let kind: string | undefined;
    let match = firstMatch(UUID_V4, content);
    if (match !== undefined) {
      kind = 'a UUID v4-like identifier';
    } else {
      match = firstMatch(HEX_RUN, content);
      if (match !== undefined) {
        kind = 'a hex run of 24 or more characters';
      } else {
        for (const candidate of content.matchAll(BASE64_RUN)) {
          const text = candidate[0];
          if (text !== undefined && /\d/.test(text) && /[a-z]/i.test(text)) {
            match = text;
            kind = 'a base64-like run of 24 or more characters';
            break;
          }
        }
      }
    }
    if (match === undefined || kind === undefined) {
      return;
    }
    findings.push({
      severity: 'warning',
      code: 'identifier-in-stable',
      segmentId: segment.id,
      message:
        `Segment '${segment.id}' is declared stable but contains ${kind} ` +
        `(digest ${digestOf(match)}). Session ids and request ids churn per call, the same ` +
        `failure mode as a timestamp. Move per-request identifiers into a volatile segment.`,
    });
  }

  /** `'below-minimum'`: the stable prefix is silently uncacheable on this provider. */
  private lintBelowMinimum(
    stableTokens: number,
    profile: ProviderProfile,
    findings: LintFinding[],
  ): void {
    const minimum = profile.minCacheableTokens;
    if (minimum === undefined || minimum <= 0 || stableTokens >= minimum) {
      return;
    }
    findings.push({
      severity: 'info',
      code: 'below-minimum',
      message:
        `The stable prefix totals ${stableTokens} tokens, below the ${minimum}-token minimum ` +
        `'${profile.id}' will cache. The provider would silently cache nothing. Lengthen the ` +
        `stable prefix, or accept that this prompt rides uncached on this provider.`,
    });
  }
}
