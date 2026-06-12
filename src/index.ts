/**
 * Public surface of RACS (Remote Agent Context Store), provider-faithful prefix-cache
 * management for Massive Intelligence (IM) agent workloads.
 *
 * This entry point exports everything, including the Node-only file state backend. The
 * `./web` and `./edge` entry points export the same surface without `fileState`, so
 * browser and edge bundles never advertise a backend they cannot run.
 *
 * @packageDocumentation
 */

export { createRACS } from './core/createRACS.js';
export { RacsError } from './errors.js';
export type { LedgerEntryJSON, LedgerJSON } from './ledger/Ledger.js';
export { Ledger } from './ledger/Ledger.js';
export type { PlanAnalysis, PlannerResult } from './plan/Planner.js';
export { Planner } from './plan/Planner.js';
export type { PrefixAnalysis } from './plan/PrefixAnalyzer.js';
export { PrefixAnalyzer } from './plan/PrefixAnalyzer.js';
export { PROVIDER_PROFILES, resolveProfile } from './providers/profiles.js';
export type { FileStateOptions } from './state/file.js';
export { fileState } from './state/file.js';
export { kvState } from './state/kv.js';
export { memoryState } from './state/memory.js';
export { combineKeys, fnv1a64 } from './stats/hash.js';
export { estimateTokens } from './stats/tokens.js';
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
} from './types.js';
