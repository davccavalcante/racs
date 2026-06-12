/**
 * Shipped provider profiles for RACS (Remote Agent Context Store), the numbers the planner
 * reasons with.
 *
 * Every named provider is a thin parameterization of exactly one {@link AdapterFamily}, which
 * is why one table covers the whole provider landscape without per-provider code paths. The
 * values document provider semantics as researched in June 2026, each entry cites its source
 * and retrieval date in JSDoc. Providers change terms faster than packages release, so every
 * value is overridable per engine instance through {@link RACSOptions.profiles}, merged by
 * {@link resolveProfile}.
 *
 * @packageDocumentation
 */

import { RacsError } from '../errors.js';
import type { AdapterFamily, ProviderId, ProviderProfile, RACSOptions } from '../types.js';

/**
 * The four cache-control mechanisms RACS implements, used to validate profile overrides at
 * runtime on behalf of untyped JavaScript callers, see {@link AdapterFamily}.
 */
const ADAPTER_FAMILIES: readonly AdapterFamily[] = [
  'breakpoint',
  'routing-key',
  'resource',
  'passive',
];

/**
 * The shipped profile table, one entry per {@link ProviderId}, semantics as documented in
 * June 2026. Treat as read-only defaults: the planner must always go through
 * {@link resolveProfile} so per-engine overrides apply.
 */
export const PROVIDER_PROFILES: Readonly<Record<ProviderId, ProviderProfile>> = {
  /**
   * Anthropic Claude API, explicit `cache_control` breakpoints with two TTL tiers.
   *
   * Writes cost 1.25x base input on the 5-minute tier and 2x on the 1-hour tier, cached
   * reads cost 0.1x, at most 4 breakpoints per request. The 1024-token minimum is the
   * conservative common case: the newest frontier models cache from 512 tokens and the
   * small models require 4096, override per model through {@link RACSOptions.profiles}
   * when targeting those.
   *
   * Source: Anthropic prompt caching documentation,
   * https://docs.claude.com/en/docs/build-with-claude/prompt-caching, retrieved June 2026.
   */
  anthropic: {
    id: 'anthropic',
    family: 'breakpoint',
    minCacheableTokens: 1024,
    maxBreakpoints: 4,
    ttls: ['5m', '1h'],
    writeMultiplier5m: 1.25,
    writeMultiplier1h: 2,
    readMultiplier: 0.1,
    notes:
      'Explicit cache_control breakpoints, up to 4 per request, 5m and 1h TTL tiers. ' +
      'Minimum cacheable prefix is 1024 tokens in the common case, 512 on the newest ' +
      'frontier models, 4096 on small models, override per model via options.profiles.',
  },
  /**
   * OpenAI, automatic server-side prefix caching steered by `prompt_cache_key`.
   *
   * Caches in 128-token increments above a 1024-token minimum, no write counter and no
   * write premium. The cached-read discount varies between 50 and 90 percent by model, so
   * the 0.25 read multiplier is a conservative default, override per model when the exact
   * discount is known. Extended 24-hour retention attaches to `prompt_cache_key`, hence
   * `supportsRetention`.
   *
   * Source: OpenAI prompt caching guide,
   * https://platform.openai.com/docs/guides/prompt-caching, retrieved June 2026.
   */
  openai: {
    id: 'openai',
    family: 'routing-key',
    minCacheableTokens: 1024,
    readMultiplier: 0.25,
    supportsRetention: true,
    notes:
      'Automatic prefix caching in 128-token increments above 1024 tokens, ' +
      'prompt_cache_key routing, no write counter, read discount varies 50 to 90 percent ' +
      'by model so 0.25 is a conservative default.',
  },
  /**
   * Google Gemini, implicit caching on 2.5 and newer models plus the explicit
   * `cachedContents` resource lifecycle with caller-set TTL and per-token-hour storage
   * billing at 1.0 USD per million tokens per hour.
   *
   * Source: Google Gemini API context caching documentation,
   * https://ai.google.dev/gemini-api/docs/caching, retrieved June 2026.
   */
  google: {
    id: 'google',
    family: 'resource',
    minCacheableTokens: 2048,
    readMultiplier: 0.1,
    storagePerMTokHour: 1.0,
    notes:
      'Implicit caching on 2.5+ models plus explicit cachedContents lifecycle with TTL ' +
      'and per-token-hour storage billing.',
  },
  /**
   * Amazon Bedrock, `cachePoint` blocks on the Converse API, Anthropic-equivalent
   * breakpoint semantics and multipliers.
   *
   * Source: Amazon Bedrock prompt caching documentation,
   * https://docs.aws.amazon.com/bedrock/latest/userguide/prompt-caching.html, retrieved
   * June 2026.
   */
  bedrock: {
    id: 'bedrock',
    family: 'breakpoint',
    minCacheableTokens: 1024,
    maxBreakpoints: 4,
    ttls: ['5m', '1h'],
    writeMultiplier5m: 1.25,
    writeMultiplier1h: 2,
    readMultiplier: 0.1,
    notes: 'cachePoint blocks on the Converse API, Anthropic-equivalent breakpoint semantics.',
  },
  /**
   * xAI Grok, automatic prefix caching, steerable with the `x-grok-conv-id` header and
   * `prompt_cache_key`, cached reads at roughly 0.16x base input.
   *
   * Source: xAI API documentation, https://docs.x.ai/, retrieved June 2026.
   */
  xai: {
    id: 'xai',
    family: 'routing-key',
    minCacheableTokens: 1024,
    readMultiplier: 0.16,
    notes:
      'Automatic prefix caching, steerable via the x-grok-conv-id header and prompt_cache_key.',
  },
  /**
   * Groq, automatic prefix caching on gpt-oss models with no control surface, cached reads
   * at 0.5x base input, entries expire after roughly 2 hours idle.
   *
   * Source: Groq prompt caching documentation,
   * https://console.groq.com/docs/prompt-caching, retrieved June 2026.
   */
  groq: {
    id: 'groq',
    family: 'passive',
    minCacheableTokens: 128,
    readMultiplier: 0.5,
    notes: 'Automatic on gpt-oss models, no controls, entries expire after 2 hours idle.',
  },
  /**
   * DeepSeek, disk-based automatic context caching with cache hit and miss token
   * reporting, cached reads at 0.1x base input.
   *
   * Source: DeepSeek context caching documentation,
   * https://api-docs.deepseek.com/guides/kv_cache, retrieved June 2026.
   */
  deepseek: {
    id: 'deepseek',
    family: 'passive',
    readMultiplier: 0.1,
    notes: 'Disk-based automatic context caching with hit and miss token reporting.',
  },
  /**
   * Mistral, automatic caching in 64-token blocks with `prompt_cache_key` routing, cached
   * reads at 0.1x base input.
   *
   * Source: Mistral platform documentation, https://docs.mistral.ai/, retrieved June 2026.
   */
  mistral: {
    id: 'mistral',
    family: 'routing-key',
    minCacheableTokens: 64,
    readMultiplier: 0.1,
    notes: '64-token cache blocks, prompt_cache_key routing.',
  },
  /**
   * OpenRouter normalizes `cache_control` passthrough and `cached_tokens` reporting across
   * upstream providers. The numbers are conservative defaults because the effective
   * discount is whatever the routed upstream charges.
   *
   * Source: OpenRouter prompt caching documentation,
   * https://openrouter.ai/docs/features/prompt-caching, retrieved June 2026.
   */
  openrouter: {
    id: 'openrouter',
    family: 'routing-key',
    minCacheableTokens: 1024,
    readMultiplier: 0.25,
    notes:
      'Normalizes cache_control passthrough and cached_tokens reporting across upstreams, ' +
      'effective discount depends on the routed upstream.',
  },
  /**
   * Moonshot Kimi, platform caching reached through the OpenAI-compatible surface. The
   * public semantics are less documented than peers as of June 2026, so the profile
   * carries conservative defaults mirroring the OpenAI numbers.
   *
   * Source: Moonshot platform documentation, https://platform.moonshot.ai/docs, retrieved
   * June 2026.
   */
  moonshot: {
    id: 'moonshot',
    family: 'routing-key',
    minCacheableTokens: 1024,
    readMultiplier: 0.25,
    notes:
      'Kimi platform caching via the OpenAI-compatible surface, semantics less documented, ' +
      'conservative defaults.',
  },
  /**
   * Ollama, local runtime KV reuse with no billing dimension, analytics measure
   * latency-motivated reuse only.
   *
   * Source: Ollama documentation, https://docs.ollama.com/, retrieved June 2026.
   */
  ollama: {
    id: 'ollama',
    family: 'passive',
    notes: 'Local runtime KV reuse, no billing, analytics measure latency-motivated reuse only.',
  },
  /**
   * LM Studio, local runtime KV reuse with no billing dimension, same posture as Ollama.
   *
   * Source: LM Studio documentation, https://lmstudio.ai/docs, retrieved June 2026.
   */
  lmstudio: {
    id: 'lmstudio',
    family: 'passive',
    notes: 'Local runtime KV reuse, no billing, analytics measure latency-motivated reuse only.',
  },
  /**
   * Hugging Face Inference Endpoints expose no public prefix-cache controls as of
   * June 2026, so the profile is passive and carries no numbers.
   *
   * Source: Hugging Face Inference Endpoints documentation,
   * https://huggingface.co/docs/inference-endpoints, retrieved June 2026.
   */
  huggingface: {
    id: 'huggingface',
    family: 'passive',
    notes: 'Inference Endpoints without public prefix-cache controls as of June 2026.',
  },
  /**
   * Claude models on Microsoft Foundry honor `cache_control` unchanged, so the profile
   * mirrors the Anthropic numbers.
   *
   * Source: Microsoft Foundry documentation for Anthropic Claude models,
   * https://learn.microsoft.com/en-us/azure/ai-foundry/, retrieved June 2026.
   */
  'microsoft-foundry': {
    id: 'microsoft-foundry',
    family: 'breakpoint',
    minCacheableTokens: 1024,
    maxBreakpoints: 4,
    ttls: ['5m', '1h'],
    writeMultiplier5m: 1.25,
    writeMultiplier1h: 2,
    readMultiplier: 0.1,
    notes: 'Claude on Microsoft Foundry honors cache_control, Anthropic breakpoint semantics.',
  },
  /**
   * Nous Research Hermes Agent rides Anthropic `cache_control` semantics with its fixed
   * system_and_3 layout, the system prompt plus the last 3 messages, so the multipliers,
   * the 1024-token cacheable minimum, and the breakpoint budget are the Anthropic numbers
   * and RACS plans superior layouts for it.
   *
   * Sources: Hermes Agent system_and_3 cache layout, observed June 2026, and Anthropic
   * prompt caching documentation,
   * https://docs.claude.com/en/docs/build-with-claude/prompt-caching, retrieved June 2026.
   */
  hermes: {
    id: 'hermes',
    family: 'breakpoint',
    minCacheableTokens: 1024,
    maxBreakpoints: 4,
    ttls: ['5m', '1h'],
    writeMultiplier5m: 1.25,
    writeMultiplier1h: 2,
    readMultiplier: 0.1,
    notes:
      'Hermes Agent system_and_3 layout (system plus last 3 messages) rides Anthropic ' +
      'cache_control semantics, RACS plans superior layouts for it.',
  },
  /**
   * Escape hatch for providers RACS does not name yet, fully caller-defined through
   * {@link RACSOptions.profiles}. Defaults to passive so a bare 'custom' plan still orders
   * segments, lints, and accounts usage without inventing numbers.
   */
  custom: {
    id: 'custom',
    family: 'passive',
    notes: 'Fully caller-defined via the options.profiles override.',
  },
};

/**
 * Returns the effective profile for one provider: the shipped table entry shallow-merged
 * with the caller's per-engine override from {@link RACSOptions.profiles}.
 *
 * Merge rules:
 * - Shallow: every override field replaces the shipped field wholesale, `ttls` included.
 * - Override fields holding `undefined` at runtime (possible for untyped JavaScript
 *   callers) are ignored rather than clobbering shipped values.
 * - `id` is not overridable, the result always names the requested provider.
 *
 * @param id - Provider whose profile to resolve.
 * @param overrides - Per-provider override map, see {@link RACSOptions.profiles}.
 * @returns The merged profile the planner actually uses.
 * @throws RacsError code `'ERR_INVALID_INPUT'` when `id` names no shipped profile (only
 * reachable from untyped callers) or when the merged `family` is not a known
 * {@link AdapterFamily}.
 */
export function resolveProfile(
  id: ProviderId,
  overrides?: RACSOptions['profiles'],
): ProviderProfile {
  const base: ProviderProfile | undefined = PROVIDER_PROFILES[id];
  if (base === undefined) {
    throw RacsError.invalid(
      `Unknown provider id '${String(id)}', expected one of: ` +
        `${Object.keys(PROVIDER_PROFILES).join(', ')}.`,
    );
  }
  const override = overrides?.[id];
  if (override === undefined) {
    return base;
  }
  const merged: ProviderProfile = {
    ...base,
    ...(override.family !== undefined ? { family: override.family } : {}),
    ...(override.minCacheableTokens !== undefined
      ? { minCacheableTokens: override.minCacheableTokens }
      : {}),
    ...(override.maxBreakpoints !== undefined ? { maxBreakpoints: override.maxBreakpoints } : {}),
    ...(override.ttls !== undefined ? { ttls: override.ttls } : {}),
    ...(override.writeMultiplier5m !== undefined
      ? { writeMultiplier5m: override.writeMultiplier5m }
      : {}),
    ...(override.writeMultiplier1h !== undefined
      ? { writeMultiplier1h: override.writeMultiplier1h }
      : {}),
    ...(override.readMultiplier !== undefined ? { readMultiplier: override.readMultiplier } : {}),
    ...(override.supportsRetention !== undefined
      ? { supportsRetention: override.supportsRetention }
      : {}),
    ...(override.storagePerMTokHour !== undefined
      ? { storagePerMTokHour: override.storagePerMTokHour }
      : {}),
    ...(override.notes !== undefined ? { notes: override.notes } : {}),
    id: base.id,
  };
  if (!ADAPTER_FAMILIES.includes(merged.family)) {
    throw RacsError.invalid(
      `Profile override for '${id}' sets family '${String(merged.family)}', expected one ` +
        `of: ${ADAPTER_FAMILIES.join(', ')}.`,
    );
  }
  return merged;
}
