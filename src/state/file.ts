/**
 * File state backend of RACS (Remote Agent Context Store): one JSON file on disk, written
 * atomically, the persistence shape for single-process Node hosts.
 *
 * This is the ONE module (until the CLI lands) allowed to touch Node built-ins, and only
 * through lazy dynamic imports inside function bodies, so merely importing the module
 * stays safe in browsers and edge runtimes, the platform requirement only materializes
 * when `load` or `save` actually runs.
 *
 * @packageDocumentation
 */

import { RacsError } from '../errors.js';
import type { StateBackend, StateSnapshot } from '../types.js';

/** Options of {@link fileState}. */
export interface FileStateOptions {
  /** Filesystem path of the snapshot file, absolute or relative to the working directory. */
  readonly path: string;
}

/** True when the value looks like a Node errno error carrying the given code. */
function hasErrnoCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === code;
}

/** Human-readable rendering of an unknown thrown value for error messages. */
function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Parses and validates one serialized snapshot.
 *
 * @throws RacsError code `'ERR_STATE_LOAD'` when the text is not valid JSON or not a
 *   snapshot-shaped object.
 * @throws RacsError code `'ERR_STATE_VERSION'` unless `version` is the literal 1, so a
 *   future layout never half-loads into an engine that cannot interpret it.
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
 * Creates a state backend persisting snapshots to one JSON file.
 *
 * Save is atomic via tmp-then-rename: the snapshot is written to `<path>.tmp` and renamed
 * over `<path>`, so readers see either the old complete file or the new complete file,
 * never a torn write. The tmp name is deterministic, not random, per the RACS determinism
 * contract, which also means two processes saving to the same path race at the host's own
 * risk, single-writer is the supported topology. Missing parent directories are created.
 *
 * Load returns `undefined` when the file does not exist yet (ENOENT), the normal first-run
 * case. Every other read failure throws RacsError `'ERR_STATE_LOAD'`, and a readable file
 * with the wrong snapshot version throws RacsError `'ERR_STATE_VERSION'`.
 *
 * @param options - See {@link FileStateOptions}.
 */
export function fileState(options: FileStateOptions): StateBackend {
  const { path } = options;
  return {
    async load(): Promise<StateSnapshot | undefined> {
      const fs = await import('node:fs/promises');
      let text: string;
      try {
        text = await fs.readFile(path, 'utf8');
      } catch (error: unknown) {
        if (hasErrnoCode(error, 'ENOENT')) {
          return undefined;
        }
        throw new RacsError(
          `Failed to read RACS state from ${path}: ${describe(error)}`,
          'ERR_STATE_LOAD',
        );
      }
      return parseSnapshot(text, path);
    },
    async save(snapshot: StateSnapshot): Promise<void> {
      const fs = await import('node:fs/promises');
      const { dirname } = await import('node:path');
      await fs.mkdir(dirname(path), { recursive: true });
      const tmpPath = `${path}.tmp`;
      await fs.writeFile(tmpPath, JSON.stringify(snapshot), 'utf8');
      await fs.rename(tmpPath, path);
    },
  };
}
