/**
 * Sibling-package bridges of RACS (Remote Agent Context Store): four adapters wiring a
 * running engine to the rest of the @takk family, @takk/noeticos parameter tuning,
 * @takk/behavioralai behavioral observability, @takk/modelchain model routing, and
 * @takk/keymesh credential rotation.
 *
 * Optional-peer pattern: every sibling shape in this module is a LOCAL structural
 * interface. Nothing here imports a sibling package at runtime or at the type level, so
 * the siblings stay optional peer dependencies, the published real objects satisfy these
 * shapes structurally, and the zero-runtime-dependency invariant of the package survives
 * intact. Hosts pass ready instances in, exactly as they do with `KvLike` stores.
 *
 * Privacy posture, shared by every bridge: only prefix keys (hashes), token counts, USD
 * figures derived from counts, agent identifiers, and hit flags ever cross a bridge.
 * Prompt content never does, RACS never holds it in the first place.
 *
 * @packageDocumentation
 */

import type { CachePlan, CacheUsage, PlanInput, PricingTable, ProviderId, RACS } from '../types.js';

/**
 * Structural freeze surface of a @takk/noeticos runtime, as {@link noeticosBridge}
 * consumes it.
 *
 * The published package exposes freezing as the module-level functions
 * `freezeTuning(runtime, agentId, reason)` and `releaseTuning(runtime, agentId)` next to
 * the `NoeticOS` runtime interface; {@link noeticosAdapter} folds that pair into this
 * object in one line. Any other tuning runtime can satisfy the same two methods directly.
 */
export interface NoeticOSLike {
  /** Pauses parameter tuning for the agent, recording the reason in the audit trail. */
  freeze(agentId: string, reason: string): void;
  /** Resumes parameter tuning for the agent. Releasing a non-frozen agent is a no-op. */
  release(agentId: string): void;
}

/**
 * Module shape of the real @takk/noeticos package, structurally: the two module-level
 * tuning functions the bridge needs. Members are method-style on purpose, method
 * parameters are checked bivariantly, so the published functions, whose first parameter
 * is the concrete `NoeticOS` runtime, satisfy `unknown` here without this module ever
 * naming the sibling type.
 */
export interface NoeticosModuleLike {
  /** The published `freezeTuning(runtime, agentId, reason)`. */
  freezeTuning(runtime: unknown, agentId: string, reason: string): void;
  /** The published `releaseTuning(runtime, agentId)`. */
  releaseTuning(runtime: unknown, agentId: string): void;
}

/**
 * Folds the real @takk/noeticos module surface into a {@link NoeticOSLike} bound to one
 * runtime, in one line per method.
 *
 * @param noeticosModule - The imported module, or any object carrying `freezeTuning` and
 *   `releaseTuning` with the published signatures.
 * @param runtime - The `NoeticOS` runtime the functions act on, opaque to this package.
 * @returns A {@link NoeticOSLike} bound to that runtime.
 *
 * @example
 * ```ts
 * import * as noeticos from '@takk/noeticos';
 * import { noeticosAdapter } from '@takk/racs/integrations';
 *
 * const runtime = noeticos.createNoeticOS();
 * const like = noeticosAdapter(noeticos, runtime);
 * like.freeze('support-agent', 'manual maintenance window');
 * ```
 */
export function noeticosAdapter(
  noeticosModule: NoeticosModuleLike,
  runtime: unknown,
): NoeticOSLike {
  return {
    freeze: (agentId, reason): void => noeticosModule.freezeTuning(runtime, agentId, reason),
    release: (agentId): void => noeticosModule.releaseTuning(runtime, agentId),
  };
}

/** Per-agent freeze bookkeeping of {@link noeticosBridge}. */
interface FreezeState {
  /** Prefix key the lineage drifted to, the baseline stable plans are counted against. */
  prefixKey: string;
  /** Consecutive zero-drift plans observed since the latest drift. */
  stablePlans: number;
  /** The drifting plan's own `'plan.created'` event is still pending and must not count. */
  skipNext: boolean;
}

/**
 * Freezes @takk/noeticos parameter tuning across prompt-prefix discontinuities.
 *
 * Rationale: parameter tuning must not learn across a prefix discontinuity, the reward
 * landscape moved. A drifted prefix changes hit ratio, latency, and cost all at once, so
 * reward samples taken right after the drift would be credited to parameter choices that
 * had nothing to do with them.
 *
 * Behavior: on every `'prefix.drifted'` event carrying an agentId (it flows in from
 * {@link PlanInput.agentId}), the bridge freezes that agent with a reason naming the
 * changed segments, then counts subsequent `'plan.created'` events for the agent with
 * zero drift and releases after `releaseAfterStablePlans` of them (default 3). A new
 * drift during the count re-freezes, which refreshes the audit trail, and restarts the
 * count.
 *
 * Disposal: the returned function only unsubscribes from telemetry. Agents frozen at
 * that moment stay frozen, releasing tuning silently would be a policy decision only the
 * host can take.
 *
 * @example
 * ```ts
 * import * as noeticos from '@takk/noeticos';
 * import { createRACS } from '@takk/racs';
 * import { noeticosAdapter, noeticosBridge } from '@takk/racs/integrations';
 *
 * const racs = createRACS();
 * const runtime = noeticos.createNoeticOS();
 * const dispose = noeticosBridge(racs, noeticosAdapter(noeticos, runtime), {
 *   releaseAfterStablePlans: 3,
 * });
 * // Plans carrying an agentId now freeze that agent's tuning on prefix drift:
 * racs.plan({
 *   agentId: 'support-agent',
 *   provider: 'anthropic',
 *   model: 'claude-sonnet-4-5',
 *   segments: [{ id: 'system', role: 'system', stability: 'stable', content: SYSTEM }],
 * });
 * ```
 */
export function noeticosBridge(
  racs: RACS,
  noeticos: NoeticOSLike,
  options?: { readonly releaseAfterStablePlans?: number },
): () => void {
  const releaseAfter = options?.releaseAfterStablePlans ?? 3;
  const frozen = new Map<string, FreezeState>();
  return racs.on((event) => {
    if (event.type === 'prefix.drifted') {
      const agentId = event.report.agentId;
      if (agentId === undefined) {
        return;
      }
      const segments = event.report.changedSegmentIds.join(', ');
      try {
        noeticos.freeze(
          agentId,
          `RACS prefix drift: changed segments [${segments}], ` +
            `${event.report.invalidatedTokens} cached prefix tokens invalidated.`,
        );
      } catch {
        // Telemetry listeners must not throw, see TelemetryListener; a failing sibling
        // call is contained here instead of leaning on the engine's safety net.
      }
      frozen.set(agentId, {
        prefixKey: event.report.prefixKey,
        stablePlans: 0,
        skipNext: true,
      });
      return;
    }
    if (event.type !== 'plan.created') {
      return;
    }
    // The prefix key embeds the agent identity, so matching on it is matching the agent.
    for (const [agentId, state] of frozen) {
      if (state.prefixKey !== event.plan.prefixKey) {
        continue;
      }
      if (state.skipNext) {
        // The drifting plan emits 'prefix.drifted' first and 'plan.created' second; the
        // skip flag keeps that plan from counting toward its own release.
        state.skipNext = false;
        break;
      }
      state.stablePlans += 1;
      if (state.stablePlans >= releaseAfter) {
        frozen.delete(agentId);
        try {
          noeticos.release(agentId);
        } catch {
          // Same containment as freeze above.
        }
      }
      break;
    }
  });
}

/**
 * The synthetic turn {@link behavioralaiBridge} reports, a narrow structural slice of
 * the sibling's `TurnObservation`, field names verbatim from the published
 * @takk/behavioralai types.
 */
export interface CacheTurnObservation {
  /** Behavioral profile the turn belongs to, the bridge's `options.agentId`. */
  readonly agentId: string;
  /** End-to-end latency in milliseconds. Declared for shape parity, never populated. */
  readonly latencyMs?: number;
  /** Cache-write spend of the call in USD, present when pricing covers the model. */
  readonly costUsd?: number;
  /** Always false, a recorded usage is a completed call. */
  readonly error?: boolean;
  /** Keys and counts only: the prefix key (a hash) and the hit flag. */
  readonly metadata?: Readonly<Record<string, string>>;
}

/**
 * Structural observation surface of a @takk/behavioralai engine. The real
 * `BehavioralAI.observe(turn)` returns a drift report; the bridge has no use for it, so
 * the return type stays `unknown`.
 */
export interface BehavioralAILike {
  /** Ingests one observed turn into the behavioral fingerprint. */
  observe(turn: CacheTurnObservation): unknown;
}

/**
 * Cache-write spend of one usage record in USD, `undefined` when the table does not
 * cover the model or misses a TTL tier the call wrote to: an unpriceable turn is omitted
 * entirely rather than underreported.
 */
function writeCostUsd(usage: CacheUsage, pricing: PricingTable | undefined): number | undefined {
  const card = pricing?.[usage.model];
  if (card === undefined) {
    return undefined;
  }
  const write5m = usage.cacheWriteTokens5m ?? 0;
  const write1h = usage.cacheWriteTokens1h ?? 0;
  if (write5m > 0 && card.cacheWrite5mPerMTok === undefined) {
    return undefined;
  }
  if (write1h > 0 && card.cacheWrite1hPerMTok === undefined) {
    return undefined;
  }
  const spend =
    write5m * (card.cacheWrite5mPerMTok ?? 0) + write1h * (card.cacheWrite1hPerMTok ?? 0);
  return spend / 1_000_000;
}

/**
 * Turns the cache itself into a behaviorally observed agent of @takk/behavioralai.
 *
 * Behavior: on every `'usage.recorded'` event the bridge reports one synthetic turn
 * under `options.agentId` (default `'racs-cache'`): `error` false, `metadata` carrying
 * the prefix key (when the usage was linked to a plan) and the hit flag as
 * `'true' | 'false'`, and `costUsd` set to the call's cache-write spend when pricing
 * covers the model. A healthy cache fingerprints as near-zero write cost and hit
 * `'true'` almost always, so a hit-ratio collapse, a burst of misses paying write
 * premiums, shifts the fingerprint and surfaces as behavioral drift in the sibling.
 *
 * Pricing design, the simplest honest one: the per-turn write cost is computed from the
 * usage record's own write token counts and the table passed in `options.pricing` (same
 * shape as `RACSOptions.pricing`). Reading `racs.stats` instead would only offer
 * cumulative aggregates, and deriving per-turn deltas from those would need shadow state
 * and would misattribute under interleaved recording. Without pricing coverage `costUsd`
 * is omitted, never guessed.
 *
 * Privacy posture: keys and counts only. The bridge forwards the prefix key (a hash), a
 * hit flag, and a USD figure derived from token counts. Prompt content never crosses.
 *
 * @example
 * ```ts
 * import { createBehavioralAI } from '@takk/behavioralai';
 * import { createRACS } from '@takk/racs';
 * import { behavioralaiBridge } from '@takk/racs/integrations';
 *
 * const racs = createRACS();
 * const behavioral = createBehavioralAI();
 * const dispose = behavioralaiBridge(racs, behavioral, {
 *   pricing: {
 *     'claude-sonnet-4-5': {
 *       inputPerMTok: 3,
 *       cacheReadPerMTok: 0.3,
 *       cacheWrite5mPerMTok: 3.75,
 *       cacheWrite1hPerMTok: 6,
 *     },
 *   },
 * });
 * racs.record({
 *   provider: 'anthropic',
 *   model: 'claude-sonnet-4-5',
 *   prefixKey: plan.prefixKey,
 *   inputTokens: 5000,
 *   cacheReadTokens: 4200,
 * });
 * // -> behavioral.observe({ agentId: 'racs-cache', costUsd: 0, error: false,
 * //      metadata: { prefixKey: plan.prefixKey, hit: 'true' } })
 * ```
 */
export function behavioralaiBridge(
  racs: RACS,
  behavioral: BehavioralAILike,
  options?: { readonly agentId?: string; readonly pricing?: PricingTable },
): () => void {
  const agentId = options?.agentId ?? 'racs-cache';
  const pricing = options?.pricing;
  return racs.on((event) => {
    if (event.type !== 'usage.recorded') {
      return;
    }
    const costUsd = writeCostUsd(event.usage, pricing);
    const turn: CacheTurnObservation = {
      agentId,
      error: false,
      metadata: {
        ...(event.usage.prefixKey !== undefined ? { prefixKey: event.usage.prefixKey } : {}),
        hit: event.hit ? 'true' : 'false',
      },
      ...(costUsd !== undefined ? { costUsd } : {}),
    };
    try {
      behavioral.observe(turn);
    } catch {
      // Telemetry listeners must not throw, see TelemetryListener; a failing sibling
      // call is contained here instead of leaning on the engine's safety net.
    }
  });
}

/** Per-model cache planning surface returned by {@link modelchainBridge}. */
export interface ModelchainCachePlanner {
  /**
   * Plans the cache for one routed model: `base` is the model-agnostic plan input,
   * `modelId` is the id the router actually picked. Because the deterministic prefix key
   * includes the model, every routed model gets its own prefix key, fingerprint lineage,
   * and keep-warm schedule, which is exactly right: provider caches are per-model, a
   * prefix cached for one model is cold for every other.
   */
  planForModel(base: Omit<PlanInput, 'model'>, modelId: string): CachePlan;
}

/**
 * Pure helper for @takk/modelchain routed traffic: per-model cache plans from one shared
 * base input. No subscriptions, no state, just {@link RACS.plan} with the routed model
 * spliced in.
 *
 * @example
 * ```ts
 * import { createModelchain } from '@takk/modelchain';
 * import { createRACS } from '@takk/racs';
 * import { modelchainBridge } from '@takk/racs/integrations';
 *
 * const racs = createRACS();
 * const planner = modelchainBridge(racs);
 * const router = createModelchain({ models });
 *
 * const response = await router.complete({ prompt: userTurn, system: SYSTEM });
 * // CompletionResponse.modelId names the model the router picked; plan its cache:
 * const plan = planner.planForModel(
 *   {
 *     provider: 'openai',
 *     segments: [
 *       { id: 'system', role: 'system', stability: 'stable', content: SYSTEM },
 *       { id: 'turn', role: 'dynamic', stability: 'volatile', content: userTurn },
 *     ],
 *     reuse: { intervalSeconds: 45 },
 *   },
 *   response.modelId,
 * );
 * ```
 */
export function modelchainBridge(racs: RACS): ModelchainCachePlanner {
  return {
    planForModel(base: Omit<PlanInput, 'model'>, modelId: string): CachePlan {
      return racs.plan({ ...base, model: modelId });
    },
  };
}

/**
 * The keymesh telemetry events that signal credentials in flux, names verbatim from the
 * published @takk/keymesh event union. The bridge subscribes to `'key.rotated'` and
 * `'circuit.open'`; `'all.exhausted'` is part of the structural surface so hosts can
 * hang their own handlers off the same {@link KeymeshLike} object.
 */
export type KeymeshCredentialEventName = 'key.rotated' | 'circuit.open' | 'all.exhausted';

/**
 * Structural on/off pair of a keymesh client, the `KeymeshExtras` surface every
 * `createKeymesh` client carries. The real methods are generic over the full event
 * union; this narrowed method pair is satisfied by them structurally.
 */
export interface KeymeshLike {
  /** Subscribes a handler to one telemetry event. */
  on(event: KeymeshCredentialEventName, handler: (event: unknown) => void): void;
  /** Unsubscribes a previously subscribed handler. */
  off(event: KeymeshCredentialEventName, handler: (event: unknown) => void): void;
}

/**
 * Invalidates provider-scoped cache state when @takk/keymesh signals credentials in
 * flux: on `'key.rotated'` and on `'circuit.open'` the bridge calls
 * `racs.invalidate({ provider })` once per provider in `options.providers`, clearing
 * fingerprints, keep-warm schedules, and resource registry entries, with one
 * `'resource.action'` delete event per dropped resource for the host to mirror.
 *
 * Why rotation invalidates: cache entries and cachedContent handles may be scoped to the
 * credential or workspace that created them. Gemini `cachedContents` especially, a
 * resource created under a rotated or disabled key may be unreachable or orphaned, and
 * silently still billing storage. Routing-key and breakpoint caches can land in a
 * different account-side namespace under the new credential. Re-planning from scratch
 * costs one write premium; planning against a dead handle costs failed calls. The same
 * logic covers `'circuit.open'`: a credential in cooldown leaves its provider-side
 * resources unrefreshable, so they expire mid-schedule anyway.
 *
 * @example
 * ```ts
 * import { createKeymesh } from '@takk/keymesh';
 * import { createRACS } from '@takk/racs';
 * import { keymeshBridge } from '@takk/racs/integrations';
 *
 * const racs = createRACS();
 * const gemini = createKeymesh({ provider: geminiAdapter, keys: geminiKeys });
 * const dispose = keymeshBridge(racs, gemini, { providers: ['google'] });
 * // From here a rotation or an opened circuit clears every google-attributed prefix
 * // and the host re-plans, recreating provider resources under the new credential.
 * ```
 */
export function keymeshBridge(
  racs: RACS,
  keymesh: KeymeshLike,
  options: { readonly providers: readonly ProviderId[] },
): () => void {
  const onCredentialChange = (): void => {
    for (const provider of options.providers) {
      racs.invalidate({ provider });
    }
  };
  keymesh.on('key.rotated', onCredentialChange);
  keymesh.on('circuit.open', onCredentialChange);
  return (): void => {
    keymesh.off('key.rotated', onCredentialChange);
    keymesh.off('circuit.open', onCredentialChange);
  };
}
