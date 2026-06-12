/**
 * `racs simulate`: a deterministic demonstration that prefix caching pays when the prompt
 * is planned right, and silently loses money when it is not.
 *
 * Two scenarios run side by side against one engine on a fully simulated timeline:
 * - structured: stable system (3000 tokens), stable tools (1500), semi documents (1000),
 *   volatile turn last, the layout RACS plans for.
 * - naive: a timestamp interpolated into the "stable" system prompt and the volatile turn
 *   placed before the remaining stable segments, the documented production failure. The
 *   timestamp changes the prefix key on every call, so the naive prompt never reads a
 *   single cached token and pays the write premium every time.
 *
 * Usage synthesis is deterministic: the first call after any prefix change or TTL expiry
 * writes the stable prefix to cache, subsequent calls inside the window read it back (a
 * hit also renews the window, mirroring provider read-refresh semantics). No wall clock
 * and no randomness anywhere: the engine clock is the simulated timeline and ids derive
 * from the seed, so the full output is byte-identical for a fixed flag set.
 *
 * Flags: `--calls` (default 400), `--seed` (default 7), `--interval` seconds between
 * calls (default 60), `--provider` (default anthropic).
 *
 * @packageDocumentation
 */

import { createRACS } from '../core/createRACS.js';
import { PROVIDER_PROFILES } from '../providers/profiles.js';
import type {
  CachePlan,
  CacheTtl,
  PlanInput,
  PricingTable,
  PromptSegment,
  ProviderId,
} from '../types.js';
import { formatFinding } from './analyze.js';
import { parseArgs, readNumber, readString } from './args.js';

/** Synthetic model id every simulated call bills against. */
const SIM_MODEL = 'sim-model';

/**
 * Fixed start of the simulated timeline, milliseconds since the Unix epoch. A constant,
 * never the wall clock, so two runs with the same flags produce byte-identical output.
 */
const SIM_EPOCH_MS = 1_750_000_000_000;

/** Price card of the synthetic model, USD per million tokens. */
const SIM_PRICING: PricingTable = {
  [SIM_MODEL]: {
    inputPerMTok: 5,
    cacheReadPerMTok: 0.5,
    cacheWrite5mPerMTok: 6.25,
    cacheWrite1hPerMTok: 10,
  },
};

/** Assumed provider-side cache window when no directive states a TTL (routing-key). */
const IMPLICIT_TTL_SECONDS = 3600;

/** The two scenario names, also the labels on every streamed line. */
type ScenarioName = 'structured' | 'naive';

/** One simulated cache window: when it was last touched and how long it lives. */
interface CacheWindow {
  lastTouch: number;
  ttlSeconds: number;
}

/** Synthesized provider-side outcome of one call. */
interface SynthesizedUsage {
  read: number;
  write5m: number;
  write1h: number;
}

/** Running totals of one scenario, the inputs of the summary block. */
interface Tally {
  hits: number;
  inputTokens: number;
  read: number;
  write5m: number;
  write1h: number;
}

/** Runtime guard for the `--provider` flag on behalf of arbitrary shell input. */
function isProviderId(value: string): value is ProviderId {
  return Object.hasOwn(PROVIDER_PROFILES, value);
}

/** The well-structured prompt: stable-first, volatile turn last. */
function structuredSegments(call: number): PromptSegment[] {
  return [
    {
      id: 'system',
      role: 'system',
      stability: 'stable',
      contentHash: 'sim-system-v1',
      tokens: 3000,
    },
    { id: 'tools', role: 'tools', stability: 'stable', contentHash: 'sim-tools-v1', tokens: 1500 },
    { id: 'docs', role: 'documents', stability: 'semi', contentHash: 'sim-docs-v1', tokens: 1000 },
    {
      id: 'turn',
      role: 'dynamic',
      stability: 'volatile',
      contentHash: `sim-turn-${call}`,
      tokens: 200,
    },
  ];
}

/**
 * The naive prompt: a live timestamp interpolated into the "stable" system segment (its
 * hash, and therefore the prefix key, changes every call) and the volatile turn placed
 * before the remaining stable segments, defeating the cache twice over.
 */
function naiveSegments(call: number, nowMs: number): PromptSegment[] {
  const iso = new Date(nowMs).toISOString();
  return [
    {
      id: 'naive-system',
      role: 'system',
      stability: 'stable',
      content:
        `You are a production agent. Today is ${iso} and the current time ${iso} ` +
        `must inform every answer you give.`,
      tokens: 3000,
    },
    {
      id: 'naive-turn',
      role: 'dynamic',
      stability: 'volatile',
      contentHash: `sim-turn-${call}`,
      tokens: 200,
    },
    {
      id: 'naive-tools',
      role: 'tools',
      stability: 'stable',
      contentHash: 'sim-tools-v1',
      tokens: 1500,
    },
    {
      id: 'naive-docs',
      role: 'documents',
      stability: 'semi',
      contentHash: 'sim-docs-v1',
      tokens: 1000,
    },
  ];
}

/**
 * Deterministic provider-side cache model: a miss (no live window) writes the stable
 * prefix at the directive's tier, a hit inside the window reads it back and renews the
 * window, plans without any cache directive never read or write.
 */
function synthesize(
  plan: CachePlan,
  now: number,
  windows: Map<string, CacheWindow>,
): SynthesizedUsage {
  let ttlSeconds: number | undefined;
  let tier: CacheTtl | undefined;
  let cacheable = false;
  for (const directive of plan.directives) {
    if (directive.kind === 'breakpoint') {
      cacheable = true;
      const seconds = directive.ttl === '1h' ? 3600 : 300;
      if (ttlSeconds === undefined || seconds < ttlSeconds) {
        ttlSeconds = seconds;
        tier = directive.ttl;
      }
    } else if (directive.kind === 'resource') {
      if (directive.action !== 'delete') {
        cacheable = true;
        if (ttlSeconds === undefined || directive.ttlSeconds < ttlSeconds) {
          ttlSeconds = directive.ttlSeconds;
        }
      }
    } else if (directive.kind === 'routing-key') {
      cacheable = true;
    }
  }
  if (!cacheable || plan.stableTokens <= 0) {
    return { read: 0, write5m: 0, write1h: 0 };
  }
  const window = windows.get(plan.prefixKey);
  if (window !== undefined && now < window.lastTouch + window.ttlSeconds * 1000) {
    windows.set(plan.prefixKey, { lastTouch: now, ttlSeconds: window.ttlSeconds });
    return { read: plan.stableTokens, write5m: 0, write1h: 0 };
  }
  windows.set(plan.prefixKey, { lastTouch: now, ttlSeconds: ttlSeconds ?? IMPLICIT_TTL_SECONDS });
  if (tier === '1h') {
    return { read: 0, write5m: 0, write1h: plan.stableTokens };
  }
  if (tier === '5m') {
    return { read: 0, write5m: plan.stableTokens, write1h: 0 };
  }
  // Routing-key and resource families write server-side without a per-token premium.
  return { read: 0, write5m: 0, write1h: 0 };
}

/** Billing cost of one tally in USD: reads, premium writes, and base-priced remainder. */
function billedUsd(tally: Tally): number {
  const price = SIM_PRICING[SIM_MODEL];
  if (price === undefined) {
    return 0;
  }
  const base = tally.inputTokens - tally.read - tally.write5m - tally.write1h;
  return (
    (tally.read * (price.cacheReadPerMTok ?? price.inputPerMTok) +
      tally.write5m * (price.cacheWrite5mPerMTok ?? price.inputPerMTok) +
      tally.write1h * (price.cacheWrite1hPerMTok ?? price.inputPerMTok) +
      Math.max(0, base) * price.inputPerMTok) /
    1e6
  );
}

/**
 * Ledger-convention hit ratio of one tally: reads over reads, writes, and uncached. The
 * tally's `inputTokens` is the all-in billed input (`plan.totalTokens` covers fresh input
 * plus the synthesized reads and writes), so the uncached remainder subtracts reads AND
 * writes, mirroring the Ledger formula exactly.
 */
function hitRatio(tally: Tally): number {
  const writes = tally.write5m + tally.write1h;
  const uncached = Math.max(0, tally.inputTokens - tally.read - writes);
  const denominator = tally.read + writes + uncached;
  return denominator === 0 ? 0 : tally.read / denominator;
}

/** Write premium of one tally in USD over base input price, both tiers, clamped at zero. */
function writePremiumUsd(tally: Tally): number {
  const price = SIM_PRICING[SIM_MODEL];
  if (price === undefined) {
    return 0;
  }
  const premium5m =
    price.cacheWrite5mPerMTok === undefined
      ? 0
      : Math.max(0, (tally.write5m / 1e6) * (price.cacheWrite5mPerMTok - price.inputPerMTok));
  const premium1h =
    price.cacheWrite1hPerMTok === undefined
      ? 0
      : Math.max(0, (tally.write1h / 1e6) * (price.cacheWrite1hPerMTok - price.inputPerMTok));
  return premium5m + premium1h;
}

/** USD saved by cache reads versus base input price, minus the write premiums. */
function netSavingsUsd(tally: Tally): number {
  const price = SIM_PRICING[SIM_MODEL];
  if (price === undefined || price.cacheReadPerMTok === undefined) {
    return 0;
  }
  const saved = (tally.read / 1e6) * (price.inputPerMTok - price.cacheReadPerMTok);
  return saved - writePremiumUsd(tally);
}

/**
 * Runs the simulate command, see the module-level contract.
 *
 * @param argv - Tokens after the `simulate` command word.
 * @returns Process exit code, 0 on completion, 2 on usage errors.
 */
export function runSimulate(argv: readonly string[]): number {
  const args = parseArgs(argv);
  const calls = readNumber(args, 'calls', 400);
  if (calls === undefined || !Number.isInteger(calls) || calls < 1) {
    console.error('racs simulate: --calls must be a positive integer.');
    return 2;
  }
  const seed = readNumber(args, 'seed', 7);
  if (seed === undefined) {
    console.error('racs simulate: --seed must be a finite number.');
    return 2;
  }
  const interval = readNumber(args, 'interval', 60);
  if (interval === undefined || interval <= 0) {
    console.error('racs simulate: --interval must be a positive number of seconds.');
    return 2;
  }
  const providerRaw = readString(args, 'provider') ?? 'anthropic';
  if (!isProviderId(providerRaw)) {
    console.error(
      `racs simulate: unknown provider '${providerRaw}', expected one of: ` +
        `${Object.keys(PROVIDER_PROFILES).join(', ')}.`,
    );
    return 2;
  }
  const provider: ProviderId = providerRaw;

  // The timeline IS the engine clock: every timestamp in plans, drift reports, and usage
  // records comes from here, never from the platform wall clock.
  const timeline = { now: SIM_EPOCH_MS };
  const racs = createRACS({ seed, clock: () => timeline.now, pricing: SIM_PRICING });

  const tallies: Record<ScenarioName, Tally> = {
    structured: { hits: 0, inputTokens: 0, read: 0, write5m: 0, write1h: 0 },
    naive: { hits: 0, inputTokens: 0, read: 0, write5m: 0, write1h: 0 },
  };
  const windows = new Map<string, CacheWindow>();

  let activeScenario: ScenarioName = 'structured';
  let activeCall = 0;
  racs.on((event) => {
    if (event.type === 'prefix.drifted') {
      const report = event.report;
      console.log(
        `drift ${activeScenario}: ${report.previousKey} -> ${report.prefixKey}, ` +
          `segments [${report.changedSegmentIds.join(', ')}], ` +
          `${report.invalidatedTokens} tokens invalidated (call ${activeCall})`,
      );
    }
  });

  console.log(
    `racs simulate: ${calls} calls, seed ${seed}, interval ${interval}s, provider ${provider}`,
  );

  const scenarios: readonly { name: ScenarioName; agentId: string }[] = [
    { name: 'structured', agentId: 'sim-structured' },
    { name: 'naive', agentId: 'sim-naive' },
  ];

  for (let call = 1; call <= calls; call += 1) {
    activeCall = call;
    timeline.now += interval * 1000;
    for (const scenario of scenarios) {
      activeScenario = scenario.name;
      const segments =
        scenario.name === 'structured'
          ? structuredSegments(call)
          : naiveSegments(call, timeline.now);
      const input: PlanInput = {
        agentId: scenario.agentId,
        provider,
        model: SIM_MODEL,
        segments,
        reuse: { intervalSeconds: interval },
      };
      const plan = racs.plan(input);
      if (call === 1) {
        if (plan.findings.length === 0) {
          console.log(`${scenario.name} lint: clean`);
        } else {
          console.log(`${scenario.name} lint:`);
          for (const finding of plan.findings) {
            console.log(formatFinding(finding));
          }
        }
      }
      const usage = synthesize(plan, timeline.now, windows);
      // All-in convention: plan.totalTokens covers the fresh volatile tail plus the
      // stable prefix, which on any given call is either written or read back, so the
      // recorded inputTokens equals fresh input + reads + writes exactly as
      // CacheUsage.inputTokens documents.
      racs.record({
        provider,
        model: SIM_MODEL,
        prefixKey: plan.prefixKey,
        inputTokens: plan.totalTokens,
        cacheReadTokens: usage.read,
        ...(usage.write5m > 0 ? { cacheWriteTokens5m: usage.write5m } : {}),
        ...(usage.write1h > 0 ? { cacheWriteTokens1h: usage.write1h } : {}),
        timestamp: timeline.now,
      });
      const tally = tallies[scenario.name];
      tally.inputTokens += plan.totalTokens;
      tally.read += usage.read;
      tally.write5m += usage.write5m;
      tally.write1h += usage.write1h;
      if (usage.read > 0) {
        tally.hits += 1;
      }
    }
    if (call % 100 === 0) {
      console.log(
        `progress: ${call}/${calls} calls, structured hits ${tallies.structured.hits}, ` +
          `naive hits ${tallies.naive.hits}`,
      );
    }
  }

  const structuredCost = billedUsd(tallies.structured);
  const naiveCost = billedUsd(tallies.naive);
  const delta = naiveCost - structuredCost;
  const percent = naiveCost > 0 ? (delta / naiveCost) * 100 : 0;

  console.log('--- summary ---');
  console.log(`calls: ${calls}`);
  console.log(
    `structured: hit ratio ${hitRatio(tallies.structured).toFixed(2)}, ` +
      `net savings ${netSavingsUsd(tallies.structured).toFixed(2)} USD`,
  );
  console.log(
    `naive: hit ratio ${hitRatio(tallies.naive).toFixed(2)}, ` +
      `write-premium loss ${writePremiumUsd(tallies.naive).toFixed(2)} USD`,
  );
  console.log(`structured prompt saves $${delta.toFixed(2)} (${percent.toFixed(1)}%) versus naive`);
  return 0;
}
