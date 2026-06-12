/**
 * In-memory state backend of RACS (Remote Agent Context Store): the zero-config default
 * persistence shape, a snapshot held in a closure variable. Nothing survives the process,
 * which is exactly right for tests, demos, and hosts that persist elsewhere.
 *
 * @packageDocumentation
 */

import type { StateBackend, StateSnapshot } from '../types.js';

/**
 * Creates a state backend that keeps the latest snapshot in memory.
 *
 * Each call returns an independent backend with its own closure variable, two engines
 * given two `memoryState()` results never see each other's snapshots. The snapshot object
 * is stored by reference, callers must treat saved snapshots as immutable, which the
 * {@link StateSnapshot} readonly contract already requires.
 *
 * @returns A {@link StateBackend} whose `load` resolves to the last saved snapshot, or
 *   `undefined` before the first save.
 */
export function memoryState(): StateBackend {
  let snapshot: StateSnapshot | undefined;
  return {
    load(): Promise<StateSnapshot | undefined> {
      return Promise.resolve(snapshot);
    },
    save(next: StateSnapshot): Promise<void> {
      snapshot = next;
      return Promise.resolve();
    },
  };
}
