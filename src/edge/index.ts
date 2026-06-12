/**
 * Edge runtime entry point of RACS (Remote Agent Context Store), for Cloudflare Workers,
 * Vercel Edge Functions, Deno Deploy, and every other worker-shaped runtime.
 *
 * Re-exports the full public surface EXCEPT the Node-only file state backend, so edge
 * bundles never advertise `fileState`. Persist through `kvState` over the platform
 * key-value store (Cloudflare KV, Upstash, Redis), or `memoryState` per isolate.
 *
 * @packageDocumentation
 */

export { createRACS } from '../core/createRACS.js';
export { RacsError } from '../errors.js';
export type { LedgerEntryJSON, LedgerJSON } from '../ledger/Ledger.js';
export { Ledger } from '../ledger/Ledger.js';
export type { PlanAnalysis, PlannerResult } from '../plan/Planner.js';
export { Planner } from '../plan/Planner.js';
export type { PrefixAnalysis } from '../plan/PrefixAnalyzer.js';
export { PrefixAnalyzer } from '../plan/PrefixAnalyzer.js';
export { PROVIDER_PROFILES, resolveProfile } from '../providers/profiles.js';
export { kvState } from '../state/kv.js';
export { memoryState } from '../state/memory.js';
export { combineKeys, fnv1a64 } from '../stats/hash.js';
export { estimateTokens } from '../stats/tokens.js';
export type {
  AdapterFamily,
  BreakEven,
  CacheDirective,
  CachePlan,
  CacheTtl,
  CacheUsage,
  DriftReport,
  ExpectedReuse,
  KvLike,
  LedgerStats,
  LintCode,
  LintFinding,
  PlanInput,
  PrefixStats,
  Pricing,
  PricingTable,
  PromptSegment,
  ProviderId,
  ProviderProfile,
  RACS,
  RACSOptions,
  RefreshEntry,
  SegmentRole,
  Stability,
  StateBackend,
  StateSnapshot,
  TelemetryEvent,
  TelemetryListener,
} from '../types.js';
