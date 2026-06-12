/**
 * Integration tests for the sibling-package bridges, run entirely against in-memory fakes
 * that satisfy the structural Like types: noeticos freeze-on-drift and release after
 * stable plans, behavioralai synthetic turns per recorded usage, modelchain per-model
 * planning, and keymesh credential-driven invalidation.
 *
 * The final describe block is the in-repo compile-time type proof: real published types
 * from the four @takk siblings are assigned into the structural Like types, mirroring the
 * standalone /tmp/racs-bridge-typecheck.ts proof so CI re-proves the structural contract
 * on every typecheck. The proof function is never executed, only compiled.
 *
 * Determinism: every engine here runs with seed 7 and an injected clock.
 */

import type { BehavioralAI, TurnObservation } from '@takk/behavioralai';
import type { KeymeshExtras, TelemetryEventName } from '@takk/keymesh';
import type { CompletionResponse, ModelchainRouter } from '@takk/modelchain';
import type { NoeticOS } from '@takk/noeticos';
import { describe, expect, it } from 'vitest';
import type { CachePlan, PlanInput, PricingTable, RACS, TelemetryEvent } from '../../src/index.js';
import { createRACS } from '../../src/index.js';
import type {
  BehavioralAILike,
  CacheTurnObservation,
  KeymeshCredentialEventName,
  KeymeshLike,
  ModelchainCachePlanner,
  NoeticOSLike,
  NoeticosModuleLike,
} from '../../src/integrations/index.js';
import {
  behavioralaiBridge,
  keymeshBridge,
  modelchainBridge,
  noeticosAdapter,
  noeticosBridge,
} from '../../src/integrations/index.js';

/** Fixed origin of every simulated timeline, milliseconds since the Unix epoch. */
const T0 = 1_750_000_000_000;

/** Indexes into an array without non-null assertions, supports negative indexes. */
function at<T>(items: readonly T[], index: number): T {
  const item = items.at(index);
  if (item === undefined) {
    throw new Error(`expected an element at index ${index}, found none`);
  }
  return item;
}

interface Harness {
  readonly racs: RACS;
  readonly events: TelemetryEvent[];
  setNow(value: number): void;
}

/** One engine with seed 7, an injected mutable clock starting at T0, and a telemetry tap. */
function harness(): Harness {
  let now = T0;
  const racs = createRACS({ seed: 7, clock: () => now });
  const events: TelemetryEvent[] = [];
  racs.on((event) => {
    events.push(event);
  });
  return {
    racs,
    events,
    setNow: (value: number): void => {
      now = value;
    },
  };
}

/** Versioned agent lineage input: the stable segment carries 1200 exact tokens. */
const agentInput = (version: number): PlanInput => ({
  agentId: 'support-agent',
  provider: 'anthropic',
  model: 'claude-sonnet-4-5',
  segments: [
    {
      id: 'sys',
      role: 'system',
      stability: 'stable',
      content: `system-prompt-v${version}`,
      tokens: 1200,
    },
    { id: 'turn', role: 'dynamic', stability: 'volatile', content: 'turn' },
  ],
});

/** Google resource input, ttlSeconds resolves to 2400 from the 600s reuse interval. */
const googleInput = (): PlanInput => ({
  provider: 'google',
  model: 'gemini-2.5-pro',
  segments: [
    { id: 'kb', role: 'documents', stability: 'stable', content: 'k'.repeat(800), tokens: 4096 },
    { id: 'turn', role: 'dynamic', stability: 'volatile', content: 'question' },
  ],
  reuse: { intervalSeconds: 600 },
});

/** Anthropic input used as the not-configured provider in the keymesh test. */
const anthropicInput = (): PlanInput => ({
  provider: 'anthropic',
  model: 'claude-sonnet-4-5',
  segments: [
    { id: 'sys', role: 'system', stability: 'stable', content: 'a'.repeat(4096) },
    { id: 'turn', role: 'dynamic', stability: 'volatile', content: 'hello' },
  ],
  reuse: { intervalSeconds: 60 },
});

describe('noeticosBridge', () => {
  it('freezes on drift naming the changed segments and releases after exactly 3 stable plans', () => {
    const { racs, setNow } = harness();
    const freezeCalls: Array<{ agentId: string; reason: string }> = [];
    const releaseCalls: string[] = [];
    const fake: NoeticOSLike = {
      freeze(agentId, reason): void {
        freezeCalls.push({ agentId, reason });
      },
      release(agentId): void {
        releaseCalls.push(agentId);
      },
    };
    const dispose = noeticosBridge(racs, fake);

    racs.plan(agentInput(0));
    expect(freezeCalls).toEqual([]);

    // The mutation drifts the lineage and freezes tuning with a reason naming the
    // changed segment and the 1200 invalidated stable-prefix tokens.
    setNow(T0 + 1000);
    racs.plan(agentInput(1));
    expect(freezeCalls.length).toBe(1);
    expect(at(freezeCalls, 0).agentId).toBe('support-agent');
    expect(at(freezeCalls, 0).reason).toContain('[sys]');
    expect(at(freezeCalls, 0).reason).toContain('1200');

    // The drifting plan's own 'plan.created' must not count toward release, so two
    // further stable plans are not yet enough.
    racs.plan(agentInput(1));
    racs.plan(agentInput(1));
    expect(releaseCalls).toEqual([]);

    // The third stable plan releases, exactly once.
    racs.plan(agentInput(1));
    expect(releaseCalls).toEqual(['support-agent']);
    racs.plan(agentInput(1));
    expect(releaseCalls).toEqual(['support-agent']);

    // Unsubscribing detaches the bridge: a later drift no longer freezes.
    dispose();
    setNow(T0 + 2000);
    racs.plan(agentInput(2));
    expect(freezeCalls.length).toBe(1);
  });
});

describe('behavioralaiBridge', () => {
  it('reports one synthetic turn per recorded usage with pricing-gated costUsd', () => {
    const { racs } = harness();
    const turns: CacheTurnObservation[] = [];
    const fake: BehavioralAILike = {
      observe(turn): unknown {
        turns.push(turn);
        return undefined;
      },
    };
    const pricing: PricingTable = {
      'model-a': { inputPerMTok: 3, cacheWrite5mPerMTok: 3.75, cacheWrite1hPerMTok: 6 },
      'model-c': { inputPerMTok: 3, cacheWrite5mPerMTok: 3.75 },
    };
    const dispose = behavioralaiBridge(racs, fake, { pricing });

    // Fully priced model: cost is hand-computed as
    // (200,000 * 3.75 + 100,000 * 6) / 1e6 = (0.75 + 0.6) = 1.35 USD.
    racs.record({
      provider: 'anthropic',
      model: 'model-a',
      prefixKey: 'prefix-hash-1',
      inputTokens: 500_000,
      cacheReadTokens: 200_000,
      cacheWriteTokens5m: 200_000,
      cacheWriteTokens1h: 100_000,
    });
    expect(turns).toEqual([
      {
        agentId: 'racs-cache',
        error: false,
        metadata: { prefixKey: 'prefix-hash-1', hit: 'true' },
        costUsd: 1.35,
      },
    ]);

    // Unpriced model: costUsd is omitted, and a plan-less usage carries no prefixKey.
    racs.record({
      provider: 'anthropic',
      model: 'model-b',
      inputTokens: 100,
      cacheReadTokens: 0,
    });
    expect(at(turns, 1)).toEqual({
      agentId: 'racs-cache',
      error: false,
      metadata: { hit: 'false' },
    });
    expect('costUsd' in at(turns, 1)).toBe(false);

    // Covered model but the written tier has no price: omitted, never underreported.
    racs.record({
      provider: 'anthropic',
      model: 'model-c',
      prefixKey: 'prefix-hash-2',
      inputTokens: 10,
      cacheReadTokens: 0,
      cacheWriteTokens1h: 50,
    });
    expect('costUsd' in at(turns, 2)).toBe(false);

    // Covered model with zero writes reports an explicit zero cost.
    racs.record({
      provider: 'anthropic',
      model: 'model-a',
      prefixKey: 'prefix-hash-1',
      inputTokens: 100,
      cacheReadTokens: 100,
    });
    expect(at(turns, 3)).toMatchObject({ costUsd: 0, metadata: { hit: 'true' } });

    // Disposal stops observation.
    dispose();
    racs.record({
      provider: 'anthropic',
      model: 'model-a',
      inputTokens: 1,
      cacheReadTokens: 0,
    });
    expect(turns.length).toBe(4);
  });
});

describe('modelchainBridge', () => {
  it('plans distinct prefix keys per routed model over the same segments', () => {
    const { racs } = harness();
    const planner = modelchainBridge(racs);
    const base: Omit<PlanInput, 'model'> = {
      provider: 'openai',
      segments: [
        { id: 'sys', role: 'system', stability: 'stable', content: 'shared system prompt' },
        { id: 'turn', role: 'dynamic', stability: 'volatile', content: 'turn' },
      ],
    };

    const first = planner.planForModel(base, 'gpt-5.2');
    const second = planner.planForModel(base, 'gpt-5.2-mini');
    const repeat = planner.planForModel(base, 'gpt-5.2');

    expect(first.model).toBe('gpt-5.2');
    expect(second.model).toBe('gpt-5.2-mini');
    // The model is part of the deterministic key, so each routed model owns its own
    // prefix, while the same model maps back to the same key.
    expect(second.prefixKey).not.toBe(first.prefixKey);
    expect(repeat.prefixKey).toBe(first.prefixKey);
    // The segments are shared, so the prefix geometry is identical across models.
    expect(second.stableTokens).toBe(first.stableTokens);
    expect(second.totalTokens).toBe(first.totalTokens);
    // Each plan routes through its own key.
    expect(first.directives).toEqual([{ kind: 'routing-key', key: first.prefixKey }]);
    expect(second.directives).toEqual([{ kind: 'routing-key', key: second.prefixKey }]);
  });
});

/** In-memory keymesh client: structural on/off with introspection for the tests. */
class FakeKeymeshEmitter implements KeymeshLike {
  private readonly handlers = new Map<KeymeshCredentialEventName, Set<(event: unknown) => void>>();

  on(event: KeymeshCredentialEventName, handler: (event: unknown) => void): void {
    const set = this.handlers.get(event) ?? new Set<(event: unknown) => void>();
    set.add(handler);
    this.handlers.set(event, set);
  }

  off(event: KeymeshCredentialEventName, handler: (event: unknown) => void): void {
    this.handlers.get(event)?.delete(handler);
  }

  emit(event: KeymeshCredentialEventName): void {
    for (const handler of this.handlers.get(event) ?? []) {
      handler({ type: event, timestamp: T0 });
    }
  }

  handlerCount(event: KeymeshCredentialEventName): number {
    return this.handlers.get(event)?.size ?? 0;
  }
}

describe('keymeshBridge', () => {
  it('invalidates configured providers on key.rotated and circuit.open only', () => {
    const { racs, events } = harness();
    const fake = new FakeKeymeshEmitter();

    const google = racs.plan(googleInput());
    racs.plan(anthropicInput());

    const dispose = keymeshBridge(racs, fake, { providers: ['google'] });
    expect(fake.handlerCount('key.rotated')).toBe(1);
    expect(fake.handlerCount('circuit.open')).toBe(1);

    const deletes = (): string[] =>
      events.flatMap((event) =>
        event.type === 'resource.action' && event.directive.action === 'delete'
          ? [event.directive.resourceKey]
          : [],
      );

    // A rotation clears the google-attributed prefix and mirrors the resource delete.
    fake.emit('key.rotated');
    expect(deletes()).toEqual([google.prefixKey]);
    expect(racs.invalidate({ provider: 'google' })).toBe(0);

    // Re-create the resource, then an opened circuit clears it the same way.
    racs.plan(googleInput());
    fake.emit('circuit.open');
    expect(deletes()).toEqual([google.prefixKey, google.prefixKey]);

    // The anthropic prefix was never configured and survived both events.
    expect(racs.invalidate({ provider: 'anthropic' })).toBe(1);

    // The disposer removes exactly the bridge handlers.
    dispose();
    expect(fake.handlerCount('key.rotated')).toBe(0);
    expect(fake.handlerCount('circuit.open')).toBe(0);

    // After disposal a rotation no longer reaches the engine.
    racs.plan(googleInput());
    fake.emit('key.rotated');
    expect(deletes().length).toBe(2);
    expect(racs.invalidate({ provider: 'google' })).toBe(1);
  });
});

// Compile-time type proof. The declarations below exist only at the type level and the
// proof function is never invoked, so none of these values is ever dereferenced at
// runtime. Compiling this file with zero errors proves the real published types of the
// four @takk siblings satisfy the structural Like types, with no casts and no any,
// mirroring /tmp/racs-bridge-typecheck.ts inside the repository.
declare const noeticosModule: typeof import('@takk/noeticos');
declare const noeticosRuntime: NoeticOS;
declare const behavioral: BehavioralAI;
declare const keymeshClient: KeymeshExtras;
declare const router: ModelchainRouter;
declare const routedResponse: CompletionResponse;
declare const syntheticTurn: CacheTurnObservation;

const bridgeTypeProof = (): Record<string, unknown> => {
  const engine = createRACS();

  // 1. @takk/noeticos: the real module namespace satisfies NoeticosModuleLike, and the
  //    real freezeTuning/releaseTuning pair flows through the adapter into NoeticOSLike.
  const moduleLike: NoeticosModuleLike = noeticosModule;
  const runtimeLike: NoeticOSLike = noeticosAdapter(noeticosModule, noeticosRuntime);
  const disposeNoeticos: () => void = noeticosBridge(engine, runtimeLike, {
    releaseAfterStablePlans: 5,
  });

  // 2. @takk/behavioralai: the real BehavioralAI engine satisfies BehavioralAILike, and
  //    the bridge's synthetic turn satisfies the real TurnObservation.
  const behavioralLike: BehavioralAILike = behavioral;
  const realTurn: TurnObservation = syntheticTurn;
  const disposeBehavioral: () => void = behavioralaiBridge(engine, behavioral, {
    agentId: 'racs-cache',
    pricing: { 'claude-sonnet-4-5': { inputPerMTok: 3, cacheWrite5mPerMTok: 3.75 } },
  });

  // 3. @takk/modelchain: the routed CompletionResponse.modelId (a branded ModelId) feeds
  //    planForModel directly.
  const planner: ModelchainCachePlanner = modelchainBridge(engine);
  const routedPlan: CachePlan = planner.planForModel(
    {
      provider: 'openai',
      segments: [{ id: 'system', role: 'system', stability: 'stable', content: 'You are...' }],
    },
    routedResponse.modelId,
  );

  // 4. @takk/keymesh: the real generic on/off pair of KeymeshExtras satisfies the
  //    narrowed KeymeshLike, and the bridge event names are real TelemetryEventNames.
  const keymeshLike: KeymeshLike = keymeshClient;
  const eventNameSubset: TelemetryEventName = ((): KeymeshCredentialEventName => 'key.rotated')();
  const disposeKeymesh: () => void = keymeshBridge(engine, keymeshClient, {
    providers: ['google', 'anthropic'],
  });

  return {
    moduleLike,
    runtimeLike,
    disposeNoeticos,
    behavioralLike,
    realTurn,
    disposeBehavioral,
    planner,
    routedPlan,
    keymeshLike,
    eventNameSubset,
    disposeKeymesh,
    router,
  };
};

describe('compile-time type proof for the sibling bridges', () => {
  it('keeps the structural Like types satisfied by the real published types', () => {
    // The proof lives in the type system: this file compiling under tsc --noEmit is the
    // assertion. At runtime only the function's existence is observable.
    expect(typeof bridgeTypeProof).toBe('function');
  });
});
