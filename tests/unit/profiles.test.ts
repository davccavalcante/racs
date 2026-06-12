/**
 * Unit tests for the shipped provider profile table and the override merge.
 *
 * The expected families and numbers pin the June 2026 research snapshot documented in
 * src/providers/profiles.ts: breakpoint providers carry 4 breakpoints and the 5m/1h TTL
 * tiers, Anthropic multipliers are 1.25/2/0.1, Mistral caches in 64-token blocks, Google
 * is the resource family with per-token-hour storage, and local runtimes stay passive.
 */

import { describe, expect, it } from 'vitest';
import { RacsError } from '../../src/errors.js';
import { PROVIDER_PROFILES, resolveProfile } from '../../src/providers/profiles.js';
import type { AdapterFamily, ProviderId, RACSOptions } from '../../src/types.js';

const ALL_PROVIDERS: readonly ProviderId[] = [
  'anthropic',
  'openai',
  'google',
  'bedrock',
  'xai',
  'groq',
  'deepseek',
  'mistral',
  'openrouter',
  'moonshot',
  'ollama',
  'lmstudio',
  'huggingface',
  'microsoft-foundry',
  'hermes',
  'custom',
];

const BREAKPOINT_PROVIDERS: readonly ProviderId[] = [
  'anthropic',
  'bedrock',
  'hermes',
  'microsoft-foundry',
];

const ROUTING_KEY_PROVIDERS: readonly ProviderId[] = [
  'openai',
  'xai',
  'mistral',
  'moonshot',
  'openrouter',
];

const PASSIVE_PROVIDERS: readonly ProviderId[] = [
  'groq',
  'deepseek',
  'ollama',
  'lmstudio',
  'huggingface',
  'custom',
];

describe('PROVIDER_PROFILES', () => {
  it('ships exactly the 16 ProviderId members, each profile naming its own id', () => {
    expect(Object.keys(PROVIDER_PROFILES).sort()).toEqual([...ALL_PROVIDERS].sort());
    for (const id of ALL_PROVIDERS) {
      expect(PROVIDER_PROFILES[id].id).toBe(id);
    }
  });

  it('puts anthropic, bedrock, hermes, and microsoft-foundry on the breakpoint family', () => {
    for (const id of BREAKPOINT_PROVIDERS) {
      const profile = PROVIDER_PROFILES[id];
      expect(profile.family).toBe('breakpoint');
      expect(profile.maxBreakpoints).toBe(4);
      expect(profile.ttls).toEqual(['5m', '1h']);
      // Every breakpoint provider rides Anthropic cache_control semantics, hermes
      // included, so all four carry the 1024-token cacheable minimum.
      expect(profile.minCacheableTokens).toBe(1024);
    }
  });

  it('puts openai, xai, mistral, moonshot, and openrouter on the routing-key family', () => {
    for (const id of ROUTING_KEY_PROVIDERS) {
      expect(PROVIDER_PROFILES[id].family).toBe('routing-key');
    }
  });

  it('puts google on the resource family with per-token-hour storage pricing', () => {
    const google = PROVIDER_PROFILES.google;
    expect(google.family).toBe('resource');
    expect(google.storagePerMTokHour).toBe(1.0);
  });

  it('puts groq, deepseek, ollama, lmstudio, huggingface, and custom on the passive family', () => {
    for (const id of PASSIVE_PROVIDERS) {
      expect(PROVIDER_PROFILES[id].family).toBe('passive');
    }
  });

  it('ships the exact anthropic multipliers 1.25, 2, and 0.1', () => {
    const anthropic = PROVIDER_PROFILES.anthropic;
    expect(anthropic.writeMultiplier5m).toBe(1.25);
    expect(anthropic.writeMultiplier1h).toBe(2);
    expect(anthropic.readMultiplier).toBe(0.1);
  });

  it('ships the 64-token mistral cache block minimum', () => {
    expect(PROVIDER_PROFILES.mistral.minCacheableTokens).toBe(64);
  });
});

describe('resolveProfile', () => {
  it('returns the shipped profile when no override exists', () => {
    expect(resolveProfile('anthropic')).toEqual(PROVIDER_PROFILES.anthropic);
    expect(resolveProfile('google', {})).toEqual(PROVIDER_PROFILES.google);
  });

  it('merges overrides shallowly, replacing listed fields wholesale', () => {
    const merged = resolveProfile('anthropic', {
      anthropic: { minCacheableTokens: 512, ttls: ['1h'] },
    });
    expect(merged.minCacheableTokens).toBe(512);
    // ttls is replaced wholesale, not concatenated with the shipped tiers.
    expect(merged.ttls).toEqual(['1h']);
  });

  it('preserves every unspecified shipped field', () => {
    const merged = resolveProfile('anthropic', { anthropic: { minCacheableTokens: 512 } });
    expect(merged.family).toBe('breakpoint');
    expect(merged.maxBreakpoints).toBe(4);
    expect(merged.ttls).toEqual(['5m', '1h']);
    expect(merged.writeMultiplier5m).toBe(1.25);
    expect(merged.writeMultiplier1h).toBe(2);
    expect(merged.readMultiplier).toBe(0.1);
    expect(merged.notes).toBe(PROVIDER_PROFILES.anthropic.notes);
  });

  it('never lets an override change the profile id', () => {
    const merged = resolveProfile('anthropic', { anthropic: { id: 'openai' } });
    expect(merged.id).toBe('anthropic');
  });

  it('ignores override fields holding undefined at runtime', () => {
    // Untyped JavaScript callers can hand an explicit undefined, it must not clobber the
    // shipped value. The cast models exactly that untyped call site.
    const overrides = {
      anthropic: { minCacheableTokens: undefined },
    } as unknown as RACSOptions['profiles'];
    expect(resolveProfile('anthropic', overrides).minCacheableTokens).toBe(1024);
  });

  it('throws RacsError ERR_INVALID_INPUT on an unknown family override', () => {
    const badFamily = 'mesh' as unknown as AdapterFamily;
    let caught: unknown;
    try {
      resolveProfile('groq', { groq: { family: badFamily } });
    } catch (error: unknown) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(RacsError);
    if (caught instanceof RacsError) {
      expect(caught.code).toBe('ERR_INVALID_INPUT');
      expect(caught.message).toContain('mesh');
    }
  });

  it('throws RacsError ERR_INVALID_INPUT on an unknown provider id from untyped callers', () => {
    const badId = 'teleologhi' as unknown as ProviderId;
    let caught: unknown;
    try {
      resolveProfile(badId);
    } catch (error: unknown) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(RacsError);
    if (caught instanceof RacsError) {
      expect(caught.code).toBe('ERR_INVALID_INPUT');
    }
  });
});
