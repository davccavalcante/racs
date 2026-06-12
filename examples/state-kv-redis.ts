/**
 * state-kv-redis.ts: cross-restart persistence through any key-value store.
 * `kvState` wraps anything exposing string get/set/delete, which is why a
 * Redis, Upstash, or Cloudflare KV client fits in ONE line, no adapter
 * package. Here the store is a Map so the example runs offline; the real
 * wraps are in the comments below, byte-for-byte what production uses.
 *
 *   // ioredis or node-redis:
 *   // const state = kvState({
 *   //   get: (k) => redis.get(k),
 *   //   set: (k, v) => redis.set(k, v),
 *   //   delete: (k) => redis.del(k),
 *   // });
 *
 *   // Upstash Redis (@upstash/redis):
 *   // const state = kvState({
 *   //   get: (k) => upstash.get<string>(k),
 *   //   set: (k, v) => upstash.set(k, v),
 *   //   delete: (k) => upstash.del(k),
 *   // });
 *
 *   // Cloudflare KV (a binding named RACS_KV):
 *   // const state = kvState({
 *   //   get: (k) => env.RACS_KV.get(k),
 *   //   set: (k, v) => env.RACS_KV.put(k, v),
 *   //   delete: (k) => env.RACS_KV.delete(k),
 *   // });
 *
 * RACS never constructs the client and never sees connection credentials;
 * the host passes a ready object. Snapshots hold hashes and aggregates only,
 * never prompt content, so a shared namespace leaks nothing.
 *
 * Run from the repository root:
 *   node --import tsx examples/state-kv-redis.ts
 */

import { createRACS, kvState, type KvLike } from '@takk/racs';

// The offline stand-in: a Map with the same three-method surface.
const backing = new Map<string, string>();
const fakeRedis: KvLike = {
  get: (key) => Promise.resolve(backing.get(key)),
  set: (key, value) => Promise.resolve(backing.set(key, value)),
  delete: (key) => Promise.resolve(backing.delete(key)),
};

const state = kvState(fakeRedis, 'racs:state'); // namespace the key per engine

// --- First process lifetime ------------------------------------------------
const first = createRACS({ seed: 7, state });
const plan = first.plan({
  agentId: 'persistent-agent',
  provider: 'anthropic',
  model: 'claude-sonnet-4-5',
  segments: [
    { id: 'system', role: 'system', stability: 'stable', contentHash: 'sys-v1', tokens: 3000 },
    { id: 'turn', role: 'dynamic', stability: 'volatile', contentHash: 'turn-1', tokens: 150 },
  ],
  reuse: { intervalSeconds: 60 },
});
first.record({
  provider: 'anthropic',
  model: 'claude-sonnet-4-5',
  prefixKey: plan.prefixKey,
  inputTokens: 3150,
  cacheReadTokens: 3000,
});
await first.close(); // close flushes the snapshot through the backend

console.log('snapshot stored under key:', [...backing.keys()]);
console.log('snapshot size (bytes)    :', backing.get('racs:state')?.length);

// --- Second process lifetime (a restart, a new replica, a redeploy) --------
const second = createRACS({ seed: 7, state });
await second.flush(); // flush waits for the startup restore to settle

const stats = second.stats();
console.log('restored calls           :', stats.calls);
console.log('restored hit ratio       :', stats.hitRatio.toFixed(3));

// The restored fingerprints keep drift detection seamless across restarts:
// the same lineage with a changed stable segment drifts immediately.
second.plan({
  agentId: 'persistent-agent',
  provider: 'anthropic',
  model: 'claude-sonnet-4-5',
  segments: [
    { id: 'system', role: 'system', stability: 'stable', contentHash: 'sys-v2', tokens: 3000 },
    { id: 'turn', role: 'dynamic', stability: 'volatile', contentHash: 'turn-2', tokens: 150 },
  ],
  reuse: { intervalSeconds: 60 },
});
console.log('drift detected after restart:', second.drifts().length === 1);

await second.close();
