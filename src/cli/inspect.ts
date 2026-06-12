/**
 * `racs inspect`: print a saved RACS (Remote Agent Context Store) state snapshot, the
 * operational window into a persisted engine.
 *
 * Flags:
 * - `--state <path>` (required): snapshot file written by the file state backend.
 * - `--pricing <path>` (optional): JSON {@link PricingTable}, adds USD figures to the
 *   ledger totals. Pricing is configuration, never part of the snapshot, so it must be
 *   re-supplied here for USD reporting.
 * - `--watch` (optional): redraw every 2 seconds, ANSI clear on a TTY, plain reprint
 *   otherwise, SIGINT exits 0. Best-effort TUI; the static path is the tested contract.
 *
 * Exit codes: 0 on a rendered snapshot AND on a missing file (`no state found at <path>`,
 * absence is a valid answer, not an error), 2 on usage errors or a corrupt snapshot.
 *
 * Each snapshot section is restored defensively, mirroring the engine core: a corrupt
 * section degrades to its empty default instead of failing the whole render.
 *
 * @packageDocumentation
 */

import { readFile } from 'node:fs/promises';
import type { LedgerEntryJSON } from '../ledger/Ledger.js';
import { Ledger } from '../ledger/Ledger.js';
import { TtlKeeper } from '../schedule/TtlKeeper.js';
import { fileState } from '../state/file.js';
import type { CacheTtl, DriftReport, PricingTable, RefreshEntry, StateSnapshot } from '../types.js';
import { flagPresent, parseArgs, readBoolean, readString } from './args.js';

/** Milliseconds between watch-mode redraws. */
const WATCH_INTERVAL_MS = 2000;

/** How many of the newest drift reports the render shows. */
const DRIFTS_SHOWN = 5;

/** Human-readable rendering of an unknown thrown value for error messages. */
function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** True for any non-null object, the first gate of every defensive section check. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** Structural check for one persisted drift report, mirrors the engine core. */
function isDriftReport(value: unknown): value is DriftReport {
  return (
    isRecord(value) &&
    typeof value.prefixKey === 'string' &&
    typeof value.previousKey === 'string' &&
    Array.isArray(value.changedSegmentIds) &&
    value.changedSegmentIds.every((id) => typeof id === 'string') &&
    typeof value.invalidatedTokens === 'number' &&
    typeof value.timestamp === 'number'
  );
}

/** Rebuilds the ledger from its snapshot section, empty ledger when corrupt or absent. */
function ledgerFrom(data: Readonly<Record<string, unknown>>, pricing?: PricingTable): Ledger {
  const section = data.ledger;
  if (
    isRecord(section) &&
    typeof section.maxPrefixes === 'number' &&
    Array.isArray(section.entries)
  ) {
    return Ledger.fromJSON(
      { maxPrefixes: section.maxPrefixes, entries: section.entries as readonly LedgerEntryJSON[] },
      pricing,
    );
  }
  return new Ledger(pricing);
}

/** Rebuilds the keeper from its snapshot section, empty keeper when corrupt or absent. */
function keeperFrom(data: Readonly<Record<string, unknown>>): TtlKeeper {
  const section = data.keeper;
  if (isRecord(section) && typeof section.capacity === 'number' && Array.isArray(section.entries)) {
    return TtlKeeper.fromJSON({
      capacity: section.capacity,
      entries: section.entries as readonly RefreshEntry[],
    });
  }
  return new TtlKeeper();
}

/** Valid drift reports from the snapshot, oldest first, invalid items skipped. */
function driftsFrom(data: Readonly<Record<string, unknown>>): DriftReport[] {
  const section = data.drifts;
  if (!Array.isArray(section)) {
    return [];
  }
  const reports: DriftReport[] = [];
  for (const item of section) {
    if (isDriftReport(item)) {
      reports.push(item);
    }
  }
  return reports;
}

/** Resource registry keys from the snapshot, invalid items skipped. */
function resourceKeysFrom(data: Readonly<Record<string, unknown>>): string[] {
  const section = data.resources;
  if (!Array.isArray(section)) {
    return [];
  }
  const keys: string[] = [];
  for (const item of section) {
    if (isRecord(item) && typeof item.key === 'string') {
      keys.push(item.key);
    }
  }
  return keys;
}

/** TTL tiers print verbatim, resource-family second counts print with the unit. */
function formatTtl(ttl: CacheTtl | number): string {
  return typeof ttl === 'string' ? ttl : `${ttl}s`;
}

/** Renders one snapshot into the multi-line report, pure given a fixed `now`. */
function renderSnapshot(
  path: string,
  snapshot: StateSnapshot,
  pricing: PricingTable | undefined,
  now: number,
): string {
  const data = snapshot.data;
  const keeper = keeperFrom(data);
  const stats = ledgerFrom(data, pricing).stats();
  const drifts = driftsFrom(data);

  // Mirrors the engine's own prefix accounting: the registry reseeds from the keeper and
  // the resource registry on restore, so the same union is reported here.
  const prefixes = new Set<string>();
  for (const entry of keeper.toJSON().entries) {
    prefixes.add(entry.prefixKey);
  }
  for (const key of resourceKeysFrom(data)) {
    prefixes.add(key);
  }

  const lines: string[] = [];
  lines.push(`racs state at ${path}`);
  lines.push(`saved: ${new Date(snapshot.savedAt).toISOString()}`);
  lines.push(`prefixes tracked: ${prefixes.size}`);
  lines.push(
    `ledger: ${stats.calls} calls, hit ratio ${stats.hitRatio.toFixed(2)}, ` +
      `${stats.readTokens} read / ${stats.writeTokens} written / ` +
      `${stats.uncachedTokens} uncached tokens`,
  );
  if (stats.savedUsd !== undefined && stats.netUsd !== undefined) {
    lines.push(`ledger USD: saved ${stats.savedUsd.toFixed(4)}, net ${stats.netUsd.toFixed(4)}`);
  }

  const due = keeper.due(now);
  lines.push(`refresh due now: ${due.length}`);
  for (const entry of due) {
    lines.push(
      `  ${entry.prefixKey} ${entry.provider}/${entry.model} ttl ${formatTtl(entry.ttl)}, ` +
        `due since ${new Date(entry.refreshAt).toISOString()}`,
    );
  }

  const recent = drifts.slice(-DRIFTS_SHOWN);
  lines.push(`recent drifts: ${recent.length} of ${drifts.length}`);
  for (const report of recent) {
    lines.push(
      `  ${new Date(report.timestamp).toISOString()} ${report.previousKey} -> ` +
        `${report.prefixKey}, segments [${report.changedSegmentIds.join(', ')}], ` +
        `${report.invalidatedTokens} tokens invalidated`,
    );
  }
  return lines.join('\n');
}

/**
 * Runs the inspect command, see the module-level contract.
 *
 * @param argv - Tokens after the `inspect` command word.
 * @param clock - Time source for "due now" math, injectable for tests, wall clock by
 *   default per the package determinism contract.
 * @returns Process exit code, 0 rendered or missing, 2 usage error or corrupt snapshot.
 */
export async function runInspect(
  argv: readonly string[],
  clock: () => number = (): number => Date.now(),
): Promise<number> {
  const args = parseArgs(argv);
  const statePath = readString(args, 'state');
  if (statePath === undefined || statePath === '') {
    console.error('racs inspect: --state <path> is required.');
    return 2;
  }
  const pricingPath = readString(args, 'pricing');
  if (flagPresent(args, 'pricing') && (pricingPath === undefined || pricingPath === '')) {
    console.error('racs inspect: --pricing requires a file path value.');
    return 2;
  }
  let pricing: PricingTable | undefined;
  if (pricingPath !== undefined) {
    try {
      const parsed: unknown = JSON.parse(await readFile(pricingPath, 'utf8'));
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        console.error(`racs inspect: '${pricingPath}' must hold a JSON object keyed by model id.`);
        return 2;
      }
      pricing = parsed as PricingTable;
    } catch (error: unknown) {
      console.error(`racs inspect: cannot read pricing '${pricingPath}': ${describe(error)}`);
      return 2;
    }
  }

  const backend = fileState({ path: statePath });

  if (!readBoolean(args, 'watch')) {
    let snapshot: StateSnapshot | undefined;
    try {
      snapshot = await backend.load();
    } catch (error: unknown) {
      console.error(`racs inspect: ${describe(error)}`);
      return 2;
    }
    if (snapshot === undefined) {
      console.log(`no state found at ${statePath}`);
      return 0;
    }
    console.log(renderSnapshot(statePath, snapshot, pricing, clock()));
    return 0;
  }

  // Watch mode, best-effort TUI: a transient read or parse failure (for example mid-write
  // on a busy host) prints as a status line and the loop keeps going.
  process.once('SIGINT', (): void => {
    process.exit(0);
  });
  const tick = async (): Promise<void> => {
    let text: string;
    try {
      const snapshot = await backend.load();
      text =
        snapshot === undefined
          ? `no state found at ${statePath}`
          : renderSnapshot(statePath, snapshot, pricing, clock());
    } catch (error: unknown) {
      text = `racs inspect: ${describe(error)}`;
    }
    if (process.stdout.isTTY === true) {
      process.stdout.write('\u001b[2J\u001b[H');
    }
    console.log(text);
  };
  await tick();
  setInterval((): void => {
    void tick();
  }, WATCH_INTERVAL_MS);
  return 0;
}
