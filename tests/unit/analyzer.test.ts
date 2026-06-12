/**
 * Unit tests for the PrefixAnalyzer structural lints and prefix geometry.
 *
 * Each lint code gets one crafted PlanInput that isolates it as far as the lint
 * definitions allow, asserting code, severity, and segmentId. Token counts are explicit
 * so every geometry expectation (stableTokens, totalTokens, boundary) is hand-computed.
 */

import { describe, expect, it } from 'vitest';
import { PrefixAnalyzer } from '../../src/plan/PrefixAnalyzer.js';
import { resolveProfile } from '../../src/providers/profiles.js';
import type {
  LintCode,
  LintFinding,
  PlanInput,
  PromptSegment,
  ProviderProfile,
  SegmentRole,
  Stability,
} from '../../src/types.js';

const analyzer = new PrefixAnalyzer();

/** Anthropic profile: 1024-token minimum, the spec boundary for below-minimum. */
const anthropic = resolveProfile('anthropic');

/** Minimal profile without a cacheable minimum, so content lints appear in isolation. */
const bare: ProviderProfile = { id: 'custom', family: 'passive' };

function seg(
  id: string,
  role: SegmentRole,
  stability: Stability,
  tokens: number,
  content?: string,
): PromptSegment {
  return {
    id,
    role,
    stability,
    ...(content !== undefined ? { content } : { contentHash: `hash-${id}` }),
    ...(content !== undefined ? {} : { tokens }),
  };
}

function input(segments: readonly PromptSegment[]): PlanInput {
  return { provider: 'anthropic', model: 'claude-sonnet-4-5', segments };
}

function findingOf(findings: readonly LintFinding[], code: LintCode): LintFinding {
  const found = findings.find((finding) => finding.code === code);
  if (found === undefined) {
    throw new Error(`expected a '${code}' finding, got: ${JSON.stringify(findings)}`);
  }
  return found;
}

describe('PrefixAnalyzer lint codes', () => {
  it('segment-order: a volatile segment before a stable one warns on the volatile id', () => {
    // 3000 stable tokens lead, so neither volatile-early nor below-minimum can fire and
    // the segment-order warning stands alone.
    const result = analyzer.analyze(
      input([
        seg('sys', 'system', 'stable', 3000),
        seg('mid', 'dynamic', 'volatile', 10),
        seg('docs', 'documents', 'stable', 100),
      ]),
      anthropic,
    );
    expect(result.findings).toHaveLength(1);
    const finding = findingOf(result.findings, 'segment-order');
    expect(finding.severity).toBe('warning');
    expect(finding.segmentId).toBe('mid');
  });

  it('volatile-early: a volatile segment inside the first half is an error', () => {
    // 100 stable of 300 total tokens, under both the half mark and the 1024 minimum.
    const result = analyzer.analyze(
      input([seg('sys', 'system', 'stable', 100), seg('tail', 'dynamic', 'volatile', 200)]),
      anthropic,
    );
    const finding = findingOf(result.findings, 'volatile-early');
    expect(finding.severity).toBe('error');
    expect(finding.segmentId).toBe('tail');
  });

  it('timestamp-in-stable: an ISO-8601 datetime in a stable segment warns', () => {
    const result = analyzer.analyze(
      input([seg('sys', 'system', 'stable', 0, 'Policy updated 2026-06-11T10:30:00Z applies.')]),
      bare,
    );
    expect(result.findings).toHaveLength(1);
    const finding = findingOf(result.findings, 'timestamp-in-stable');
    expect(finding.severity).toBe('warning');
    expect(finding.segmentId).toBe('sys');
  });

  it('timestamp-in-stable: a 10-digit unix epoch in a stable segment warns', () => {
    const result = analyzer.analyze(
      input([seg('sys', 'system', 'stable', 0, 'Deployed at 1767225600 by the ops crew.')]),
      bare,
    );
    expect(result.findings).toHaveLength(1);
    const finding = findingOf(result.findings, 'timestamp-in-stable');
    expect(finding.severity).toBe('warning');
    expect(finding.segmentId).toBe('sys');
  });

  it('timestamp-in-stable: a 13-digit unix epoch in a stable segment warns', () => {
    const result = analyzer.analyze(
      input([seg('sys', 'system', 'stable', 0, 'Cache primed at 1767225600123 milliseconds.')]),
      bare,
    );
    expect(result.findings).toHaveLength(1);
    const finding = findingOf(result.findings, 'timestamp-in-stable');
    expect(finding.severity).toBe('warning');
    expect(finding.segmentId).toBe('sys');
  });

  it("timestamp-in-stable: 'current time' near digits in a stable segment warns", () => {
    const result = analyzer.analyze(
      input([seg('sys', 'system', 'stable', 0, 'Answer as of the current time, 11:45, please.')]),
      bare,
    );
    expect(result.findings).toHaveLength(1);
    const finding = findingOf(result.findings, 'timestamp-in-stable');
    expect(finding.severity).toBe('warning');
    expect(finding.segmentId).toBe('sys');
  });

  it('identifier-in-stable: a UUID v4 in a stable segment warns', () => {
    const result = analyzer.analyze(
      input([
        seg('sys', 'system', 'stable', 0, 'session 123e4567-e89b-42d3-a456-426614174000 end'),
      ]),
      bare,
    );
    expect(result.findings).toHaveLength(1);
    const finding = findingOf(result.findings, 'identifier-in-stable');
    expect(finding.severity).toBe('warning');
    expect(finding.segmentId).toBe('sys');
  });

  it('identifier-in-stable: a 32-character hex run in a stable segment warns', () => {
    const result = analyzer.analyze(
      input([seg('sys', 'system', 'stable', 0, 'trace 0123456789abcdef0123456789abcdef done')]),
      bare,
    );
    expect(result.findings).toHaveLength(1);
    const finding = findingOf(result.findings, 'identifier-in-stable');
    expect(finding.severity).toBe('warning');
    expect(finding.segmentId).toBe('sys');
  });

  it('unstable-tools: a tools segment declared volatile is an error', () => {
    // The stable anchor ahead keeps volatile-early and segment-order out of the result.
    const result = analyzer.analyze(
      input([seg('sys', 'system', 'stable', 100), seg('tools', 'tools', 'volatile', 50)]),
      bare,
    );
    expect(result.findings).toHaveLength(1);
    const finding = findingOf(result.findings, 'unstable-tools');
    expect(finding.severity).toBe('error');
    expect(finding.segmentId).toBe('tools');
  });

  it('below-minimum: fires at exactly minimum minus one stable token', () => {
    const result = analyzer.analyze(input([seg('sys', 'system', 'stable', 1023)]), anthropic);
    expect(result.findings).toHaveLength(1);
    const finding = findingOf(result.findings, 'below-minimum');
    expect(finding.severity).toBe('info');
    // The finding is prefix-level, it names no single segment.
    expect(finding.segmentId).toBeUndefined();
  });

  it('below-minimum: does not fire at exactly the minimum', () => {
    const result = analyzer.analyze(input([seg('sys', 'system', 'stable', 1024)]), anthropic);
    expect(result.findings).toHaveLength(0);
  });

  it('below-minimum: hermes fires identically to anthropic on a 200-token prefix', () => {
    // hermes rides Anthropic cache_control semantics, so its profile carries the same
    // 1024-token minimum and a 200-token prefix lints below-minimum on both.
    const segments = [seg('sys', 'system', 'stable', 200)];
    const hermesResult = analyzer.analyze(
      { provider: 'hermes', model: 'hermes-4-405b', segments },
      resolveProfile('hermes'),
    );
    const finding = findingOf(hermesResult.findings, 'below-minimum');
    expect(finding.severity).toBe('info');
    const anthropicResult = analyzer.analyze(input(segments), anthropic);
    expect(hermesResult.findings.map((entry) => entry.code)).toEqual(
      anthropicResult.findings.map((entry) => entry.code),
    );
  });

  it('missing-stability: a dynamic-role segment declared stable is flagged as info', () => {
    const result = analyzer.analyze(input([seg('live', 'dynamic', 'stable', 2000)]), anthropic);
    expect(result.findings).toHaveLength(1);
    const finding = findingOf(result.findings, 'missing-stability');
    expect(finding.severity).toBe('info');
    expect(finding.segmentId).toBe('live');
  });
});

describe('PrefixAnalyzer geometry and privacy', () => {
  it('produces zero findings for a clean stable-first prompt', () => {
    const result = analyzer.analyze(
      input([
        seg('sys', 'system', 'stable', 1200),
        seg('tools', 'tools', 'stable', 300),
        seg('kb', 'documents', 'semi', 500),
        seg('hist', 'history', 'semi', 400),
        seg('turn', 'dynamic', 'volatile', 100),
      ]),
      anthropic,
    );
    expect(result.findings).toEqual([]);
    // Hand-computed: 1200 + 300 + 500 + 400 = 2400 stable, 2500 total, volatile at 4.
    expect(result.stableTokens).toBe(2400);
    expect(result.totalTokens).toBe(2500);
    expect(result.orderedStableBoundary).toBe(4);
  });

  it('skips content heuristics for hash-only segments', () => {
    const timestampText = 'Deployed at 1767225600 by the ops crew.';
    // The same text as content fires the timestamp lint.
    const withContent = analyzer.analyze(
      input([seg('sys', 'system', 'stable', 0, timestampText)]),
      bare,
    );
    expect(findingOf(withContent.findings, 'timestamp-in-stable').segmentId).toBe('sys');
    // Hash-only mode: RACS never sees the text, so nothing can be scanned.
    const hashOnly = analyzer.analyze(
      input([{ id: 'sys', role: 'system', stability: 'stable', contentHash: 'feed', tokens: 10 }]),
      bare,
    );
    expect(hashOnly.findings).toEqual([]);
  });

  it('counts stableTokens as the longest stable-or-semi run from the start', () => {
    const result = analyzer.analyze(
      input([
        seg('a', 'system', 'stable', 100),
        seg('b', 'documents', 'semi', 200),
        seg('c', 'dynamic', 'volatile', 50),
        seg('d', 'documents', 'stable', 400),
      ]),
      bare,
    );
    // Hand-computed: the run stops at the volatile 'c', so 100 + 200 = 300 of 750 tokens.
    expect(result.stableTokens).toBe(300);
    expect(result.totalTokens).toBe(750);
    expect(result.orderedStableBoundary).toBe(2);
    // The stable 'd' stranded behind 'c' is exactly the segment-order hazard.
    expect(findingOf(result.findings, 'segment-order').segmentId).toBe('c');
  });
});
