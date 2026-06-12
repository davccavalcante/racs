/**
 * integrations-family.ts: all four @takk family bridges, exercised with
 * structural fakes so this example runs with ZERO siblings installed. Every
 * bridge consumes a LOCAL structural interface; the real packages satisfy
 * the same shapes, so swapping a fake for the real object is a one-line
 * change (the real wiring is shown in comments per section).
 *
 * Run from the repository root:
 *   node --import tsx examples/integrations-family.ts
 */

import { createRACS, type PlanInput } from '@takk/racs';
import {
  behavioralaiBridge,
  keymeshBridge,
  modelchainBridge,
  noeticosBridge,
  type BehavioralAILike,
  type CacheTurnObservation,
  type KeymeshCredentialEventName,
  type KeymeshLike,
  type NoeticOSLike,
} from '@takk/racs/integrations';

const racs = createRACS({ seed: 7 });

const inputOf = (systemHash: string, turn: number): PlanInput => ({
  agentId: 'support-agent',
  provider: 'anthropic',
  model: 'claude-sonnet-4-5',
  segments: [
    { id: 'system', role: 'system', stability: 'stable', contentHash: systemHash, tokens: 3000 },
    { id: 'turn', role: 'dynamic', stability: 'volatile', contentHash: `turn-${turn}`, tokens: 150 },
  ],
  reuse: { intervalSeconds: 60 },
});

// --- 1. noeticosBridge: freeze parameter tuning across prefix drift --------
// Real wiring:
//   import * as noeticos from '@takk/noeticos';
//   import { noeticosAdapter } from '@takk/racs/integrations';
//   const runtime = noeticos.createNoeticOS();
//   noeticosBridge(racs, noeticosAdapter(noeticos, runtime));
const tuningLog: string[] = [];
const fakeNoeticos: NoeticOSLike = {
  freeze: (agentId, reason) => tuningLog.push(`freeze ${agentId}: ${reason}`),
  release: (agentId) => tuningLog.push(`release ${agentId}`),
};
const disposeNoeticos = noeticosBridge(racs, fakeNoeticos, { releaseAfterStablePlans: 3 });

racs.plan(inputOf('sys-v1', 1)); // baseline
racs.plan(inputOf('sys-v2', 2)); // stable segment changed -> drift -> freeze
racs.plan(inputOf('sys-v2', 3)); // stable plan 1 of 3
racs.plan(inputOf('sys-v2', 4)); // stable plan 2 of 3
racs.plan(inputOf('sys-v2', 5)); // stable plan 3 of 3 -> release
console.log('noeticos bridge:');
for (const line of tuningLog) console.log(' ', line);
disposeNoeticos();

// --- 2. behavioralaiBridge: the cache as a behaviorally observed agent -----
// Real wiring:
//   import { createBehavioralAI } from '@takk/behavioralai';
//   behavioralaiBridge(racs, createBehavioralAI(), { pricing });
const turns: CacheTurnObservation[] = [];
const fakeBehavioral: BehavioralAILike = {
  observe: (turn) => {
    turns.push(turn);
    return undefined;
  },
};
const disposeBehavioral = behavioralaiBridge(racs, fakeBehavioral, {
  pricing: {
    'claude-sonnet-4-5': { inputPerMTok: 3, cacheWrite5mPerMTok: 3.75 },
  },
});
racs.record({
  provider: 'anthropic',
  model: 'claude-sonnet-4-5',
  inputTokens: 3150,
  cacheReadTokens: 3000,
});
console.log('behavioralai bridge observed:', JSON.stringify(turns));
disposeBehavioral();

// --- 3. modelchainBridge: one base input, a cache plan per routed model ----
// Real wiring:
//   import { createModelchain } from '@takk/modelchain';
//   const router = createModelchain({ models });
//   const response = await router.complete({ ... });
//   planner.planForModel(base, response.modelId);
const planner = modelchainBridge(racs);
const base: Omit<PlanInput, 'model'> = {
  agentId: 'routed-agent',
  provider: 'openai',
  segments: [
    { id: 'system', role: 'system', stability: 'stable', contentHash: 'r-sys-v1', tokens: 2000 },
    { id: 'turn', role: 'dynamic', stability: 'volatile', contentHash: 'r-turn-1', tokens: 100 },
  ],
  reuse: { intervalSeconds: 45 },
};
const planA = planner.planForModel(base, 'gpt-fast');
const planB = planner.planForModel(base, 'gpt-deep');
console.log('modelchain bridge: distinct per-model prefix keys ->', planA.prefixKey !== planB.prefixKey);

// --- 4. keymeshBridge: invalidate provider-scoped caches on rotation -------
// Real wiring:
//   import { createKeymesh } from '@takk/keymesh';
//   const gemini = createKeymesh({ provider: geminiAdapter, keys });
//   keymeshBridge(racs, gemini, { providers: ['google'] });
const handlers = new Map<KeymeshCredentialEventName, ((event: unknown) => void)[]>();
const fakeKeymesh: KeymeshLike = {
  on: (event, handler) => {
    handlers.set(event, [...(handlers.get(event) ?? []), handler]);
  },
  off: (event, handler) => {
    handlers.set(event, (handlers.get(event) ?? []).filter((h) => h !== handler));
  },
};
const disposeKeymesh = keymeshBridge(racs, fakeKeymesh, { providers: ['google'] });

// A live google resource to invalidate, plus a telemetry listener showing the
// delete the host must mirror onto the provider (cachedContents especially).
const deletes: string[] = [];
racs.on((event) => {
  if (event.type === 'resource.action' && event.directive.action === 'delete') {
    deletes.push(event.directive.resourceKey);
  }
});
racs.plan({
  agentId: 'gemini-agent',
  provider: 'google',
  model: 'gemini-bench',
  segments: [
    { id: 'kb', role: 'documents', stability: 'stable', contentHash: 'kb-v1', tokens: 4000 },
    { id: 'turn', role: 'dynamic', stability: 'volatile', contentHash: 'g-turn-1', tokens: 120 },
  ],
  reuse: { intervalSeconds: 600 },
});

// The credential rotates (here: triggered by hand on the fake client).
for (const handler of handlers.get('key.rotated') ?? []) {
  handler({ keyId: 'a1b2c3d4' });
}
console.log('keymesh bridge: resource deletes to mirror ->', deletes.length);
disposeKeymesh();

await racs.close();
