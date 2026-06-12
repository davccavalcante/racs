#!/usr/bin/env node
/**
 * Standalone dist smoke check, the dependency-free mirror of
 * tests/integration/dist-parity.test.ts. Run after `pnpm build` (wired as
 * `pnpm smoke:dist`). Node built-ins only, no test framework, no dev dependency.
 *
 * Proves the cross-bundle contract of the shipped package:
 * - `createRACS` imported from the ESM bundle (dist/index.js) creates a working engine.
 * - `keymeshBridge` required from the CJS integrations bundle (dist/integrations/index.cjs
 *   via createRequire) wires a fake keymesh emitter to that ESM engine, and a fired
 *   'key.rotated' invalidates provider-scoped state: the live google resource emits a
 *   'resource.action' delete and the next plan re-creates it.
 * - A foreign object passed where a RACS engine is expected fails loudly (TypeError) at
 *   first method use.
 *
 * Prints exactly one ok line on success, exits 1 with the failure on stderr otherwise.
 */

import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const esmEntry = join(root, 'dist', 'index.js');
const cjsIntegrations = join(root, 'dist', 'integrations', 'index.cjs');

/** Minimal synchronous emitter satisfying the keymesh bridge's structural on/off pair. */
function fakeKeymesh() {
  const handlers = new Map();
  return {
    on(event, handler) {
      const set = handlers.get(event) ?? new Set();
      set.add(handler);
      handlers.set(event, set);
    },
    off(event, handler) {
      handlers.get(event)?.delete(handler);
    },
    emit(event) {
      for (const handler of handlers.get(event) ?? []) {
        handler({ name: event });
      }
    },
  };
}

try {
  if (!existsSync(esmEntry) || !existsSync(cjsIntegrations)) {
    throw new Error('dist/ is missing or incomplete, run `pnpm build` first.');
  }

  const { createRACS } = await import(pathToFileURL(esmEntry).href);
  const requireCjs = createRequire(import.meta.url);
  const { keymeshBridge, modelchainBridge } = requireCjs(cjsIntegrations);
  assert.equal(typeof createRACS, 'function', 'ESM bundle must export createRACS');
  assert.equal(typeof keymeshBridge, 'function', 'CJS bundle must export keymeshBridge');
  assert.equal(typeof modelchainBridge, 'function', 'CJS bundle must export modelchainBridge');

  // Deterministic engine: fixed seed, injected simulated clock, never the wall clock.
  const timeline = { now: 1_750_000_000_000 };
  const engine = createRACS({ seed: 7, clock: () => timeline.now });
  const actions = [];
  engine.on((event) => {
    if (event.type === 'resource.action') {
      actions.push(event.directive.action);
    }
  });

  const emitter = fakeKeymesh();
  const dispose = keymeshBridge(engine, emitter, { providers: ['google'] });
  const inputOf = (call) => ({
    agentId: 'smoke-google',
    provider: 'google',
    model: 'gemini-smoke',
    segments: [
      { id: 'sys', role: 'system', stability: 'stable', contentHash: 'g-sys-v1', tokens: 4000 },
      {
        id: 'turn',
        role: 'dynamic',
        stability: 'volatile',
        contentHash: `g-turn-${call}`,
        tokens: 120,
      },
    ],
    reuse: { intervalSeconds: 600 },
  });

  // First sight creates the server-side resource, second sight reuses it.
  const created = engine.plan(inputOf(1));
  assert.equal(created.directives[0]?.kind, 'resource', 'google plan must emit a resource');
  timeline.now += 60_000;
  engine.plan(inputOf(2));

  // Credential rotation: the CJS bridge invalidates google state on the ESM engine.
  emitter.emit('key.rotated');

  // After rotation the registry is empty, so the next plan re-creates the resource.
  timeline.now += 60_000;
  const recreated = engine.plan(inputOf(3));
  assert.equal(
    recreated.directives[0]?.action,
    'create',
    'rotation must force the next google plan to re-create the resource',
  );
  assert.equal(recreated.prefixKey, created.prefixKey, 'the prefix lineage must survive');

  // Disposing the bridge unsubscribes: a later rotation no longer invalidates.
  dispose();
  emitter.emit('key.rotated');
  timeline.now += 60_000;
  engine.plan(inputOf(4));

  assert.deepEqual(
    actions,
    ['create', 'reuse', 'delete', 'create', 'reuse'],
    'resource.action telemetry must show the rotation-driven lifecycle exactly',
  );

  // A foreign object where RACS is expected fails loudly at first method use.
  assert.throws(
    () =>
      modelchainBridge({ definitely: 'not-an-engine' }).planForModel(
        {
          provider: 'openai',
          segments: [
            { id: 'sys', role: 'system', stability: 'stable', contentHash: 'x', tokens: 1200 },
          ],
        },
        'gpt-smoke',
      ),
    TypeError,
    'a foreign engine object must throw a TypeError at first method use',
  );

  console.log(
    'ok smoke-dist: ESM core and CJS keymesh bridge interoperate, key.rotated invalidates ' +
      'and re-creates the google resource, foreign engine objects fail loudly',
  );
} catch (error) {
  console.error(`smoke-dist: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
