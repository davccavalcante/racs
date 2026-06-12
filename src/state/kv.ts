/**
 * Key-value state backend of RACS (Remote Agent Context Store): one JSON string under one
 * key in any structural {@link KvLike} store, the persistence shape for edge runtimes and
 * multi-instance hosts that already run Redis, Upstash, or Cloudflare KV.
 *
 * RACS never constructs the client and never sees connection credentials, the host passes
 * a ready object, per the product invariant.
 *
 * @packageDocumentation
 */

import { RacsError } from '../errors.js';
import type { KvLike, StateBackend, StateSnapshot } from '../types.js';

/** Human-readable rendering of an unknown thrown value for error messages. */
function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Parses and validates one serialized snapshot. Duplicated from the file backend on
 * purpose, the state backends stay self-contained so bundlers tree-shake each one
 * independently.
 *
 * @throws RacsError code `'ERR_STATE_LOAD'` when the text is not valid JSON or not a
 *   snapshot-shaped object.
 * @throws RacsError code `'ERR_STATE_VERSION'` unless `version` is the literal 1.
 */
function parseSnapshot(text: string, source: string): StateSnapshot {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error: unknown) {
    throw new RacsError(
      `RACS state at ${source} is not valid JSON: ${describe(error)}`,
      'ERR_STATE_LOAD',
    );
  }
  if (typeof parsed !== 'object' || parsed === null) {
    throw new RacsError(
      `RACS state at ${source} is not a snapshot object, found ${typeof parsed}.`,
      'ERR_STATE_LOAD',
    );
  }
  const record = parsed as Record<string, unknown>;
  if (record.version !== 1) {
    throw new RacsError(
      `RACS state at ${source} has unsupported snapshot version ${String(record.version)}, expected 1.`,
      'ERR_STATE_VERSION',
    );
  }
  const savedAt = record.savedAt;
  const data = record.data;
  if (typeof savedAt !== 'number' || typeof data !== 'object' || data === null) {
    throw new RacsError(
      `RACS state at ${source} is missing the savedAt or data field of a version 1 snapshot.`,
      'ERR_STATE_LOAD',
    );
  }
  return { version: 1, savedAt, data: data as Readonly<Record<string, unknown>> };
}

/**
 * Creates a state backend persisting snapshots as one JSON string in a key-value store.
 *
 * Any client exposing string get, set, and delete wraps into {@link KvLike} in one line,
 * no adapter package needed:
 *
 * @example
 * ```ts
 * // Redis (node-redis or ioredis):
 * const state = kvState({
 *   get: (k) => redis.get(k),
 *   set: (k, v) => redis.set(k, v),
 *   delete: (k) => redis.del(k),
 * });
 *
 * // Upstash Redis:
 * const state = kvState({
 *   get: (k) => upstash.get<string>(k),
 *   set: (k, v) => upstash.set(k, v),
 *   delete: (k) => upstash.del(k),
 * });
 *
 * // Cloudflare KV (a binding named RACS_KV):
 * const state = kvState({
 *   get: (k) => env.RACS_KV.get(k),
 *   set: (k, v) => env.RACS_KV.put(k, v),
 *   delete: (k) => env.RACS_KV.delete(k),
 * });
 * ```
 *
 * Load tolerates both `null` and `undefined` from `get`, the two absence conventions in
 * the wild, and returns `undefined` for either, the normal first-run case. A present but
 * unparseable value throws RacsError `'ERR_STATE_LOAD'`, and a parseable value with the
 * wrong snapshot version throws RacsError `'ERR_STATE_VERSION'`.
 *
 * @param kv - The ready client, see {@link KvLike}.
 * @param key - Storage key for the snapshot, namespace it per engine when several engines
 *   share one store.
 */
export function kvState(kv: KvLike, key = 'racs:state'): StateBackend {
  return {
    async load(): Promise<StateSnapshot | undefined> {
      const raw = await kv.get(key);
      if (raw === undefined || raw === null) {
        return undefined;
      }
      return parseSnapshot(raw, `kv key "${key}"`);
    },
    async save(snapshot: StateSnapshot): Promise<void> {
      await kv.set(key, JSON.stringify(snapshot));
    },
  };
}
