/**
 * Cross-bundle contract of the built package: the ESM core (`dist/index.js`) and the CJS
 * integrations bundle (`dist/integrations/index.cjs`) must interoperate on one engine
 * instance, because real hosts mix module systems exactly like this.
 *
 * Proven here, after building dist in beforeAll:
 * - `createRACS` imported from the ESM bundle creates a working engine.
 * - `keymeshBridge` required from the CJS bundle wires a fake keymesh emitter to that ESM
 *   engine, and a fired 'key.rotated' invalidates provider-scoped state: the live google
 *   resource emits a telemetry 'resource.action' delete and the next plan re-creates it.
 * - A foreign object passed where a RACS engine is expected fails loudly at first method
 *   use instead of silently planning nothing.
 *
 * The standalone mirror of these checks lives in scripts/smoke-dist.mjs (pnpm smoke:dist).
 */

import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { beforeAll, describe, expect, it } from 'vitest';
import type {
  CacheDirective,
  CachePlan,
  PlanInput,
  ProviderId,
  RACS,
  RACSOptions,
  TelemetryEvent,
} from '../../src/types.js';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const ESM_ENTRY = join(ROOT, 'dist', 'index.js');
const CJS_INTEGRATIONS = join(ROOT, 'dist', 'integrations', 'index.cjs');

/** Local structural type of the fake emitter handed to the keymesh bridge. */
interface KeymeshEmitterLike {
  on(event: string, handler: (event: unknown) => void): void;
  off(event: string, handler: (event: unknown) => void): void;
}

/** Structural surface of the CJS integrations bundle, only what this file consumes. */
interface IntegrationsModule {
  keymeshBridge(
    racs: RACS,
    keymesh: KeymeshEmitterLike,
    options: { readonly providers: readonly ProviderId[] },
  ): () => void;
  modelchainBridge(racs: RACS): {
    planForModel(base: Omit<PlanInput, 'model'>, modelId: string): CachePlan;
  };
}

/** Minimal synchronous emitter satisfying the bridge's structural on/off pair. */
class FakeKeymesh implements KeymeshEmitterLike {
  private readonly handlers = new Map<string, Set<(event: unknown) => void>>();

  on(event: string, handler: (event: unknown) => void): void {
    const set = this.handlers.get(event) ?? new Set<(event: unknown) => void>();
    set.add(handler);
    this.handlers.set(event, set);
  }

  off(event: string, handler: (event: unknown) => void): void {
    this.handlers.get(event)?.delete(handler);
  }

  emit(event: string): void {
    for (const handler of this.handlers.get(event) ?? []) {
      handler({ name: event });
    }
  }
}

let createRACSDist: (options?: RACSOptions) => RACS;
let integrations: IntegrationsModule;

beforeAll(async () => {
  // Build dist with the real tsup binary so the test exercises the shipped bundles.
  await promisify(execFile)(join(ROOT, 'node_modules', '.bin', 'tsup'), [], { cwd: ROOT });
  expect(existsSync(ESM_ENTRY)).toBe(true);
  expect(existsSync(CJS_INTEGRATIONS)).toBe(true);

  const esm = (await import(/* @vite-ignore */ pathToFileURL(ESM_ENTRY).href)) as {
    createRACS: (options?: RACSOptions) => RACS;
  };
  createRACSDist = esm.createRACS;
  const requireCjs = createRequire(import.meta.url);
  integrations = requireCjs(CJS_INTEGRATIONS) as IntegrationsModule;
}, 120_000);

/** The directive at `index`, throwing instead of returning undefined under strict mode. */
function directiveAt(plan: CachePlan, index: number): CacheDirective {
  const directive = plan.directives[index];
  if (directive === undefined) {
    throw new Error(`plan ${plan.planId} has no directive at index ${index}`);
  }
  return directive;
}

describe('dist parity across ESM core and CJS integrations', () => {
  it('keymesh key.rotated through the CJS bridge invalidates the ESM engine, the google resource is re-created', () => {
    const timeline = { now: 1_750_000_000_000 };
    const engine = createRACSDist({ seed: 7, clock: () => timeline.now });
    const actions: string[] = [];
    engine.on((event: TelemetryEvent) => {
      if (event.type === 'resource.action') {
        actions.push(event.directive.action);
      }
    });

    const fake = new FakeKeymesh();
    const dispose = integrations.keymeshBridge(engine, fake, { providers: ['google'] });
    const inputOf = (call: number): PlanInput => ({
      agentId: 'dist-google',
      provider: 'google',
      model: 'gemini-dist',
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
    expect(directiveAt(created, 0).kind).toBe('resource');
    timeline.now += 60_000;
    const reused = engine.plan(inputOf(2));
    expect(reused.prefixKey).toBe(created.prefixKey);

    // Credential rotation: the CJS bridge calls invalidate({ provider: 'google' }) on the
    // ESM engine, which emits the telemetry delete for the live resource.
    fake.emit('key.rotated');

    // After rotation the registry is empty, so the next plan re-creates the resource.
    timeline.now += 60_000;
    const recreated = engine.plan(inputOf(3));
    const directive = directiveAt(recreated, 0);
    if (directive.kind !== 'resource') {
      throw new Error(`expected a resource directive, got '${directive.kind}'`);
    }
    expect(directive.action).toBe('create');
    expect(recreated.prefixKey).toBe(created.prefixKey);

    // Disposing the bridge unsubscribes: a later rotation no longer invalidates.
    dispose();
    fake.emit('key.rotated');
    timeline.now += 60_000;
    const afterDispose = engine.plan(inputOf(4));
    const lastDirective = directiveAt(afterDispose, 0);
    if (lastDirective.kind !== 'resource') {
      throw new Error(`expected a resource directive, got '${lastDirective.kind}'`);
    }
    expect(lastDirective.action).toBe('reuse');

    expect(actions).toEqual(['create', 'reuse', 'delete', 'create', 'reuse']);
  });

  it('a foreign object passed where RACS is expected fails loudly at first method use', () => {
    const foreign = { definitely: 'not-an-engine' } as unknown as RACS;
    const planner = integrations.modelchainBridge(foreign);
    expect(() =>
      planner.planForModel(
        {
          provider: 'openai',
          segments: [
            { id: 'sys', role: 'system', stability: 'stable', contentHash: 'x', tokens: 1200 },
          ],
        },
        'gpt-dist',
      ),
    ).toThrow(TypeError);
  });
});
