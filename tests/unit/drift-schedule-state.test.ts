/**
 * Unit tests for drift fingerprints, the keep-warm TTL keeper, and the state backends.
 *
 * Time never comes from the platform clock: every observation and refresh receives an
 * explicit millisecond timestamp, and the refresh expectations are hand-computed from
 * refreshAt = lastWriteAt + 0.9 * ttl (270000ms for the 5m tier, 540000ms for 600s).
 */

import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { Fingerprints } from '../../src/drift/Fingerprints.js';
import { RacsError } from '../../src/errors.js';
import { TtlKeeper } from '../../src/schedule/TtlKeeper.js';
import { fileState } from '../../src/state/file.js';
import { kvState } from '../../src/state/kv.js';
import { memoryState } from '../../src/state/memory.js';
import type {
  CacheDirective,
  CachePlan,
  KvLike,
  PlanInput,
  PromptSegment,
  StateSnapshot,
} from '../../src/types.js';

function at<T>(items: readonly T[], index: number): T {
  const item = items[index];
  if (item === undefined) {
    throw new Error(`expected an element at index ${index}`);
  }
  return item;
}

async function racsErrorCodeOf(promise: Promise<unknown>): Promise<string> {
  let caught: unknown;
  try {
    await promise;
  } catch (error: unknown) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(RacsError);
  return caught instanceof RacsError ? caught.code : 'no-error-thrown';
}

describe('Fingerprints', () => {
  const stableSeg = (id: string): PromptSegment => ({
    id,
    role: 'system',
    stability: 'stable',
    contentHash: `decl-${id}`,
  });
  const volatileSeg = (id: string): PromptSegment => ({
    id,
    role: 'dynamic',
    stability: 'volatile',
    contentHash: `decl-${id}`,
  });
  const inputOf = (segments: readonly PromptSegment[], agentId?: string): PlanInput => ({
    ...(agentId !== undefined ? { agentId } : {}),
    provider: 'anthropic',
    model: 'claude-sonnet-4-5',
    segments,
  });

  it('reports a stable-segment change with exact ids, invalidated tokens, and agent', () => {
    const store = new Fingerprints();
    const segments = [stableSeg('sys'), volatileSeg('turn')];
    const first = store.observe(
      inputOf(segments, 'agent-7'),
      'key-v1',
      new Map([
        ['sys', 'h-sys-1'],
        ['turn', 'h-turn-1'],
      ]),
      1200,
      1000,
    );
    expect(first).toBeUndefined();

    // The volatile turn hash changes too, but only the stable change may be reported,
    // and the invalidated tokens are the 1200 of the PREVIOUS stable prefix.
    const report = store.observe(
      inputOf(segments, 'agent-7'),
      'key-v2',
      new Map([
        ['sys', 'h-sys-2'],
        ['turn', 'h-turn-2'],
      ]),
      1300,
      2000,
    );
    expect(report).toEqual({
      agentId: 'agent-7',
      prefixKey: 'key-v2',
      previousKey: 'key-v1',
      changedSegmentIds: ['sys'],
      invalidatedTokens: 1200,
      timestamp: 2000,
    });
  });

  it('stays silent across 50 observations of pure volatile churn', () => {
    const store = new Fingerprints();
    const segments = [stableSeg('sys'), volatileSeg('turn')];
    for (let index = 0; index < 50; index += 1) {
      const report = store.observe(
        inputOf(segments),
        'key-stable',
        new Map([
          ['sys', 'h-sys'],
          ['turn', `h-turn-${index}`],
        ]),
        1000,
        index,
      );
      expect(report).toBeUndefined();
    }
  });

  it('reports both added and removed stable segments', () => {
    const store = new Fingerprints();
    expect(
      store.observe(inputOf([stableSeg('a')]), 'k1', new Map([['a', 'ha']]), 500, 1),
    ).toBeUndefined();

    const added = store.observe(
      inputOf([stableSeg('a'), stableSeg('b')]),
      'k2',
      new Map([
        ['a', 'ha'],
        ['b', 'hb'],
      ]),
      900,
      2,
    );
    expect(added?.changedSegmentIds).toEqual(['b']);
    expect(added?.previousKey).toBe('k1');
    expect(added?.invalidatedTokens).toBe(500);

    const removed = store.observe(inputOf([stableSeg('a')]), 'k1', new Map([['a', 'ha']]), 500, 3);
    expect(removed?.changedSegmentIds).toEqual(['b']);
    expect(removed?.previousKey).toBe('k2');
    expect(removed?.invalidatedTokens).toBe(900);
  });

  it('evicts the least-recently-observed lineage at capacity', () => {
    const store = new Fingerprints(1);
    const segments = [stableSeg('sys')];
    expect(
      store.observe(inputOf(segments, 'a1'), 'ka1', new Map([['sys', 'h1']]), 100, 1),
    ).toBeUndefined();
    // Tracking a second lineage evicts the first.
    expect(
      store.observe(inputOf(segments, 'a2'), 'ka2', new Map([['sys', 'h2']]), 100, 2),
    ).toBeUndefined();
    // The evicted lineage restarts as a first observation: a changed hash and a changed
    // key produce no report, which is the observable proof the record was dropped.
    expect(
      store.observe(inputOf(segments, 'a1'), 'ka1-x', new Map([['sys', 'h1-x']]), 100, 3),
    ).toBeUndefined();
    // Once re-tracked, the next change reports again.
    const report = store.observe(
      inputOf(segments, 'a1'),
      'ka1-y',
      new Map([['sys', 'h1-y']]),
      100,
      4,
    );
    expect(report?.changedSegmentIds).toEqual(['sys']);
  });
});

describe('TtlKeeper', () => {
  const makePlan = (directives: readonly CacheDirective[], prefixKey = 'prefix-1'): CachePlan => ({
    planId: 'plan-1',
    provider: 'anthropic',
    model: 'claude-sonnet-4-5',
    family: 'breakpoint',
    prefixKey,
    stableTokens: 2000,
    totalTokens: 2500,
    directives,
    findings: [],
    reasoning: 'test plan',
  });
  const breakpoint5m: CacheDirective = { kind: 'breakpoint', segmentId: 'sys', ttl: '5m' };

  it('schedules the refresh at exactly lastWriteAt + 0.9 * ttl, 270000ms for 5m', () => {
    const keeper = new TtlKeeper();
    keeper.track(makePlan([breakpoint5m]), 1_000_000);
    const entry = at(keeper.toJSON().entries, 0);
    expect(entry.lastWriteAt).toBe(1_000_000);
    expect(entry.refreshAt).toBe(1_270_000);
    expect(entry.ttl).toBe('5m');
  });

  it('pins the due() boundary: exclusive one millisecond early, inclusive at refreshAt', () => {
    const keeper = new TtlKeeper();
    keeper.track(makePlan([breakpoint5m]), 1_000_000);
    expect(keeper.due(1_269_999)).toEqual([]);
    const due = keeper.due(1_270_000);
    expect(due).toHaveLength(1);
    expect(at(due, 0).prefixKey).toBe('prefix-1');
  });

  it('slides the window on markRefreshed', () => {
    const keeper = new TtlKeeper();
    keeper.track(makePlan([breakpoint5m]), 1_000_000);
    keeper.markRefreshed('prefix-1', 2_000_000);
    expect(keeper.due(2_269_999)).toEqual([]);
    const due = keeper.due(2_270_000);
    expect(due).toHaveLength(1);
    expect(at(due, 0).lastWriteAt).toBe(2_000_000);
  });

  it('clears the entry on remove', () => {
    const keeper = new TtlKeeper();
    keeper.track(makePlan([breakpoint5m]), 1_000_000);
    keeper.remove('prefix-1');
    expect(keeper.due(Number.MAX_SAFE_INTEGER)).toEqual([]);
    expect(keeper.toJSON().entries).toEqual([]);
  });

  it('tracks resource directives by their ttlSeconds', () => {
    const keeper = new TtlKeeper();
    const resource: CacheDirective = {
      kind: 'resource',
      action: 'create',
      resourceKey: 'r1',
      ttlSeconds: 600,
    };
    keeper.track(makePlan([resource]), 100_000);
    const entry = at(keeper.toJSON().entries, 0);
    expect(entry.ttl).toBe(600);
    // 0.9 * 600000ms = 540000ms after the write.
    expect(entry.refreshAt).toBe(640_000);
  });

  it('tracks nothing for routing-key and none directives', () => {
    const keeper = new TtlKeeper();
    keeper.track(makePlan([{ kind: 'routing-key', key: 'k' }]), 1_000);
    keeper.track(makePlan([{ kind: 'none', reason: 'passive' }], 'prefix-2'), 1_000);
    expect(keeper.toJSON().entries).toEqual([]);
  });
});

describe('state backends', () => {
  const dir = mkdtempSync(join(tmpdir(), 'racs-state-'));
  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const snapshot: StateSnapshot = {
    version: 1,
    savedAt: 1_718_000_000_000,
    data: { ledger: { calls: 3 }, note: 'unit-test' },
  };

  it('memory: loads undefined before the first save, then round-trips the snapshot', async () => {
    const backend = memoryState();
    expect(await backend.load()).toBeUndefined();
    await backend.save(snapshot);
    expect(await backend.load()).toEqual(snapshot);
  });

  it('memory: two backends are fully independent', async () => {
    const first = memoryState();
    const second = memoryState();
    await first.save(snapshot);
    expect(await second.load()).toBeUndefined();
  });

  it('file: saves atomically, creating parents and leaving no .tmp behind', async () => {
    const path = join(dir, 'nested', 'state.json');
    const backend = fileState({ path });
    await backend.save(snapshot);
    expect(existsSync(path)).toBe(true);
    expect(existsSync(`${path}.tmp`)).toBe(false);
    expect(await backend.load()).toEqual(snapshot);
  });

  it('file: returns undefined for a missing file (ENOENT)', async () => {
    const backend = fileState({ path: join(dir, 'does-not-exist.json') });
    expect(await backend.load()).toBeUndefined();
  });

  it('file: throws ERR_STATE_LOAD on a corrupt file', async () => {
    const path = join(dir, 'corrupt.json');
    writeFileSync(path, '{this is not json', 'utf8');
    expect(await racsErrorCodeOf(fileState({ path }).load())).toBe('ERR_STATE_LOAD');
  });

  it('file: throws ERR_STATE_VERSION on a wrong snapshot version', async () => {
    const path = join(dir, 'version-2.json');
    writeFileSync(path, JSON.stringify({ version: 2, savedAt: 1, data: {} }), 'utf8');
    expect(await racsErrorCodeOf(fileState({ path }).load())).toBe('ERR_STATE_VERSION');
  });

  it('kv: talks to the store under the configured key and round-trips JSON', async () => {
    const store = new Map<string, string>();
    const getKeys: string[] = [];
    const setCalls: Array<{ key: string; value: string }> = [];
    const deleteKeys: string[] = [];
    const kv: KvLike = {
      get: (key) => {
        getKeys.push(key);
        // Absent keys answer null, the convention kvState must tolerate.
        return Promise.resolve(store.get(key) ?? null);
      },
      set: (key, value) => {
        setCalls.push({ key, value });
        store.set(key, value);
        return Promise.resolve();
      },
      delete: (key) => {
        deleteKeys.push(key);
        store.delete(key);
        return Promise.resolve();
      },
    };

    const backend = kvState(kv, 'engine-7:state');
    // First load sees the null from the empty store and reports absence.
    expect(await backend.load()).toBeUndefined();
    await backend.save(snapshot);
    expect(await backend.load()).toEqual(snapshot);

    expect(getKeys).toEqual(['engine-7:state', 'engine-7:state']);
    expect(setCalls.map((call) => call.key)).toEqual(['engine-7:state']);
    expect(JSON.parse(at(setCalls, 0).value)).toEqual(snapshot);
    // load and save never delete.
    expect(deleteKeys).toEqual([]);
  });
});
