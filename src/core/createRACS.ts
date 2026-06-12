/**
 * Engine core of RACS (Remote Agent Context Store): wires the analyzer, the planner, the
 * ledger, drift fingerprints, the keep-warm keeper, and the resource registry behind the
 * one public {@link RACS} surface.
 *
 * The core owns everything stateful: deterministic plan identity, prefix bookkeeping,
 * telemetry fan-out, and persistence. The modules it wires stay pure or self-contained, so
 * this file is the only place where their interactions are decided.
 *
 * Determinism: plan ids derive from a seeded counter ({@link RACSOptions.seed}, default 7)
 * through the seeded short-id generator, never from the platform UUID or the global random
 * generator. The clock is read once per mutating call and is injectable for tests.
 *
 * @packageDocumentation
 */

import { Fingerprints } from '../drift/Fingerprints.js';
import { RacsError } from '../errors.js';
import { Ledger } from '../ledger/Ledger.js';
import { Planner } from '../plan/Planner.js';
import { PrefixAnalyzer } from '../plan/PrefixAnalyzer.js';
import { resolveProfile } from '../providers/profiles.js';
import { TtlKeeper } from '../schedule/TtlKeeper.js';
import { combineKeys, fnv1a64, shortId } from '../stats/hash.js';
import type {
  CacheDirective,
  CachePlan,
  CacheUsage,
  DriftReport,
  LedgerStats,
  LintFinding,
  PlanInput,
  PricingTable,
  PromptSegment,
  ProviderId,
  ProviderProfile,
  RACS,
  RACSOptions,
  RefreshEntry,
  StateBackend,
  StateSnapshot,
  TelemetryEvent,
  TelemetryListener,
} from '../types.js';

/** Default seed of the deterministic plan-id generator, see {@link RACSOptions.seed}. */
const DEFAULT_SEED = 7;

/** Default cap on distinct tracked prefixes, see {@link RACSOptions.maxPrefixes}. */
const DEFAULT_MAX_PREFIXES = 1000;

/**
 * Capacity of the drift ring. Two hundred reports cover days of drift on a misbehaving
 * deployment while keeping the ring, and therefore every snapshot, small enough for edge
 * KV value limits.
 */
const DRIFT_RING_CAPACITY = 200;

/**
 * Fraction of a resource TTL window after which a planned `'reuse'` is swapped for
 * `'refresh'`. Mirrors the keep-warm convention of the TtlKeeper: touching inside the last
 * 10 percent of the window renews it before expiry while absorbing scheduler jitter.
 */
const RESOURCE_REFRESH_FRACTION = 0.9;

/** Live registry entry for one resource-family cache, see {@link CacheDirective}. */
interface ResourceRecord {
  /** Provider the resource lives on, the attribution key of provider-scoped invalidation. */
  provider: ProviderId;
  ttlSeconds: number;
  lastWriteAt: number;
}

/** Serialized registry entry, persisted inside {@link StateSnapshot.data}. */
interface ResourceRecordJSON {
  readonly key: string;
  readonly provider: ProviderId;
  readonly ttlSeconds: number;
  readonly lastWriteAt: number;
}

/** True for any non-null object, the first gate of every defensive restore check. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** Structural check for one persisted resource registry entry. */
function isResourceRecordJSON(value: unknown): value is ResourceRecordJSON {
  return (
    isRecord(value) &&
    typeof value.key === 'string' &&
    typeof value.provider === 'string' &&
    typeof value.ttlSeconds === 'number' &&
    typeof value.lastWriteAt === 'number'
  );
}

/** Structural check for one persisted drift report. */
function isDriftReport(value: unknown): value is DriftReport {
  return (
    isRecord(value) &&
    (value.agentId === undefined || typeof value.agentId === 'string') &&
    typeof value.prefixKey === 'string' &&
    typeof value.previousKey === 'string' &&
    Array.isArray(value.changedSegmentIds) &&
    value.changedSegmentIds.every((id) => typeof id === 'string') &&
    typeof value.invalidatedTokens === 'number' &&
    typeof value.timestamp === 'number'
  );
}

/** Throws RacsError `'ERR_INVALID_INPUT'` unless `value` is a finite non-negative number. */
function requireCount(value: unknown, field: string): void {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw RacsError.invalid(
      `${field} must be a finite non-negative number, received ${String(value)}.`,
    );
  }
}

/**
 * Validates one {@link PlanInput} on behalf of untyped JavaScript callers: segments
 * non-empty, ids unique and non-empty, every segment carrying `content` or `contentHash`,
 * token counts sane. The provider id is validated separately by `resolveProfile`, which
 * throws the same `'ERR_INVALID_INPUT'` code for unknown providers.
 */
function validatePlanInput(input: PlanInput): void {
  if (!isRecord(input)) {
    throw RacsError.invalid(`PlanInput must be an object, received ${typeof input}.`);
  }
  if (typeof input.model !== 'string' || input.model === '') {
    throw RacsError.invalid('PlanInput.model must be a non-empty model identifier string.');
  }
  if (!Array.isArray(input.segments) || input.segments.length === 0) {
    throw RacsError.invalid('PlanInput.segments must be a non-empty array of prompt segments.');
  }
  const seen = new Set<string>();
  for (const segment of input.segments) {
    if (typeof segment.id !== 'string' || segment.id === '') {
      throw RacsError.invalid('Every segment needs a non-empty string id unique within the plan.');
    }
    if (seen.has(segment.id)) {
      throw RacsError.invalid(
        `Segment id '${segment.id}' appears more than once, ids must be unique within one plan.`,
      );
    }
    seen.add(segment.id);
    if (
      typeof segment.content !== 'string' &&
      (typeof segment.contentHash !== 'string' || segment.contentHash === '')
    ) {
      throw RacsError.invalid(
        `Segment '${segment.id}' carries neither content nor contentHash, provide at least one ` +
          `so the segment can be keyed.`,
      );
    }
    if (segment.tokens !== undefined) {
      requireCount(segment.tokens, `Segment '${segment.id}' tokens`);
    }
  }
}

/** Validates one {@link CacheUsage} on behalf of untyped JavaScript callers. */
function validateUsage(usage: CacheUsage): void {
  if (!isRecord(usage)) {
    throw RacsError.invalid(`CacheUsage must be an object, received ${typeof usage}.`);
  }
  // Widened to unknown because the ProviderId union cannot overlap '' at the type level,
  // while untyped JavaScript callers can still hand in anything at runtime.
  const provider: unknown = usage.provider;
  if (typeof provider !== 'string' || provider === '') {
    throw RacsError.invalid('CacheUsage.provider must be a non-empty provider id string.');
  }
  if (typeof usage.model !== 'string' || usage.model === '') {
    throw RacsError.invalid('CacheUsage.model must be a non-empty model identifier string.');
  }
  requireCount(usage.inputTokens, 'CacheUsage.inputTokens');
  requireCount(usage.cacheReadTokens, 'CacheUsage.cacheReadTokens');
  if (usage.cacheWriteTokens5m !== undefined) {
    requireCount(usage.cacheWriteTokens5m, 'CacheUsage.cacheWriteTokens5m');
  }
  if (usage.cacheWriteTokens1h !== undefined) {
    requireCount(usage.cacheWriteTokens1h, 'CacheUsage.cacheWriteTokens1h');
  }
  if (usage.timestamp !== undefined) {
    requireCount(usage.timestamp, 'CacheUsage.timestamp');
  }
}

/**
 * Keying hash of one segment. Per the {@link PromptSegment} content contract `contentHash`
 * wins when both fields are present, content alone is hashed with FNV-1a 64.
 */
function hashOf(segment: PromptSegment): string {
  if (typeof segment.contentHash === 'string' && segment.contentHash !== '') {
    return segment.contentHash;
  }
  return fnv1a64(segment.content ?? '');
}

/** The one concrete {@link RACS} implementation, constructed by {@link createRACS}. */
class RacsEngine implements RACS {
  private readonly profiles: RACSOptions['profiles'];
  private readonly pricing: PricingTable | undefined;
  private readonly maxPrefixes: number;
  private readonly clock: () => number;
  private readonly salt: string;
  private readonly state: StateBackend | undefined;
  private readonly analyzer = new PrefixAnalyzer();
  private readonly planner = new Planner();
  /** Replaced wholesale when a persisted section restores, hence not readonly. */
  private ledger: Ledger;
  private fingerprints: Fingerprints;
  private keeper: TtlKeeper;
  /** Live resource-family caches by resource key, the planner's `knownResource` source. */
  private readonly resources = new Map<string, ResourceRecord>();
  /** Chronological drift ring, oldest first, newest last, capacity {@link DRIFT_RING_CAPACITY}. */
  private readonly driftRing: DriftReport[] = [];
  /**
   * Every prefix key registered for keeper and resource bookkeeping, capped at
   * maxPrefixes, each mapped to its provider so {@link RACS.invalidate} can clear by
   * provider, the shape credential rotation needs.
   */
  private readonly prefixKeys = new Map<string, ProviderId>();
  private readonly listeners: TelemetryListener[] = [];
  private planCounter = 0;
  /** Resolves when the state backend finished restoring, awaited by flush to avoid races. */
  private readonly restored: Promise<void>;

  constructor(options: RACSOptions = {}) {
    this.profiles = options.profiles;
    this.pricing = options.pricing;
    this.maxPrefixes = options.maxPrefixes ?? DEFAULT_MAX_PREFIXES;
    this.clock = options.clock ?? ((): number => Date.now());
    this.salt = String(options.seed ?? DEFAULT_SEED);
    this.state = options.state;
    this.ledger = new Ledger(this.pricing, this.maxPrefixes);
    this.fingerprints = new Fingerprints(this.maxPrefixes);
    this.keeper = new TtlKeeper(this.maxPrefixes);
    this.restored = this.state === undefined ? Promise.resolve() : this.restore(this.state);
  }

  plan(input: PlanInput): CachePlan {
    validatePlanInput(input);
    const profile = resolveProfile(input.provider, this.profiles);
    const now = this.clock();

    const segmentHashes = new Map<string, string>();
    for (const segment of input.segments) {
      segmentHashes.set(segment.id, hashOf(segment));
    }

    const analysis = this.analyzer.analyze(input, profile);

    // The prefix key fuses the ordered hashes of the left-anchored stable run with the
    // provider, model, and agent lineage, so equal keys mean byte-equal cacheable prefixes
    // and different agents never share keys even on identical content.
    const stableHashes: string[] = [];
    for (const segment of input.segments.slice(0, analysis.orderedStableBoundary)) {
      stableHashes.push(segmentHashes.get(segment.id) ?? '');
    }
    const prefixKey = combineKeys([
      ...stableHashes,
      input.provider,
      input.model,
      input.agentId ?? '',
    ]);

    let knownResource = false;
    if (profile.family === 'resource') {
      const record = this.resources.get(prefixKey);
      if (record !== undefined) {
        if (now >= record.lastWriteAt + record.ttlSeconds * 1000) {
          // The TTL window fully elapsed, the server already expired the resource, so the
          // next directive must be a create, not a reuse of a dead handle.
          this.resources.delete(prefixKey);
        } else {
          knownResource = true;
        }
      }
    }

    const result = this.planner.plan(
      input,
      profile,
      analysis,
      prefixKey,
      this.pricing?.[input.model],
      knownResource,
    );

    // The planner emits the reuse shape, the core owns the timing: inside the last 10
    // percent of the TTL window a reuse is swapped for a refresh so the host renews the
    // resource before the server expires it.
    const directives: CacheDirective[] = result.directives.map((directive) => {
      if (directive.kind !== 'resource' || directive.action !== 'reuse') {
        return directive;
      }
      const record = this.resources.get(directive.resourceKey);
      if (
        record !== undefined &&
        now >= record.lastWriteAt + RESOURCE_REFRESH_FRACTION * record.ttlSeconds * 1000
      ) {
        return { ...directive, action: 'refresh' as const };
      }
      return directive;
    });

    this.planCounter += 1;
    const plan: CachePlan = {
      planId: `rx-${this.planCounter}-${shortId(this.planCounter, this.salt)}`,
      provider: input.provider,
      model: input.model,
      family: profile.family,
      prefixKey,
      stableTokens: analysis.stableTokens,
      totalTokens: analysis.totalTokens,
      directives,
      findings: [...analysis.findings, ...result.extraFindings],
      ...(result.breakEven !== undefined ? { breakEven: result.breakEven } : {}),
      reasoning: result.reasoning,
    };

    // Drift tracking is lineage-bounded inside Fingerprints itself, so it runs even when
    // the prefix cap below degrades registration: a drifting prefix is exactly the signal
    // a saturated deployment must not lose.
    const report = this.fingerprints.observe(
      input,
      prefixKey,
      segmentHashes,
      analysis.stableTokens,
      now,
    );
    if (report !== undefined) {
      this.pushDrift(report);
      this.emit({ type: 'prefix.drifted', report });
    }

    if (!this.prefixKeys.has(prefixKey) && this.prefixKeys.size >= this.maxPrefixes) {
      // Degraded mode: the plan itself is still served in full, but the new key gets no
      // keep-warm tracking and no resource bookkeeping, so the bounded stores cannot grow
      // past the cap. The ledger applies its own LRU cap at recording time.
      this.emit({
        type: 'limit.reached',
        scope: 'prefixes',
        detail:
          `The ${this.maxPrefixes}-prefix cap is reached, plan for new prefix ` +
          `'${prefixKey}' was served without keep-warm tracking or resource bookkeeping.`,
        timestamp: now,
      });
    } else {
      this.prefixKeys.set(prefixKey, input.provider);
      this.keeper.track(plan, now);
      this.applyResourceDirectives(input.provider, directives, now);
    }

    this.emit({ type: 'plan.created', plan, timestamp: now });
    return plan;
  }

  lint(input: PlanInput): readonly LintFinding[] {
    validatePlanInput(input);
    const profile = resolveProfile(input.provider, this.profiles);
    return this.analyzer.analyze(input, profile).findings;
  }

  record(usage: CacheUsage): void {
    validateUsage(usage);
    const timestamp = usage.timestamp ?? this.clock();
    const stamped: CacheUsage = usage.timestamp !== undefined ? usage : { ...usage, timestamp };
    const { hit, evicted } = this.ledger.record(stamped);
    this.emit({ type: 'usage.recorded', usage: stamped, hit, timestamp });
    if (evicted !== undefined) {
      this.emit({
        type: 'limit.reached',
        scope: 'ledger',
        detail: `The ledger evicted least-recently-used aggregate '${evicted}' to stay within its cap.`,
        timestamp,
      });
    }
  }

  stats(filter?: { prefixKey?: string; provider?: ProviderId }): LedgerStats {
    return this.ledger.stats(filter);
  }

  schedule(now?: number): readonly RefreshEntry[] {
    const at = now ?? this.clock();
    const due = this.keeper.due(at);
    for (const entry of due) {
      this.emit({ type: 'refresh.due', entry, timestamp: at });
    }
    return due;
  }

  markRefreshed(prefixKey: string, now?: number): void {
    this.keeper.markRefreshed(prefixKey, now ?? this.clock());
  }

  drifts(limit?: number): readonly DriftReport[] {
    if (limit === undefined) {
      return [...this.driftRing];
    }
    if (limit <= 0) {
      return [];
    }
    return this.driftRing.slice(-limit);
  }

  invalidate(filter?: { readonly prefixKey?: string; readonly provider?: ProviderId }): number {
    const now = this.clock();
    const keyFilter = filter?.prefixKey;
    const providerFilter = filter?.provider;
    const matchesKey = (key: string): boolean => keyFilter === undefined || key === keyFilter;

    // Resolve the matching prefix set first, then clear every store in one pass. The
    // prefix registry attributes a provider to each tracked prefix, and the resource
    // registry carries its own attribution, so provider-scoped invalidation covers both.
    const matched = new Set<string>();
    for (const [key, provider] of this.prefixKeys) {
      if (matchesKey(key) && (providerFilter === undefined || provider === providerFilter)) {
        matched.add(key);
      }
    }
    for (const [key, record] of this.resources) {
      if (matchesKey(key) && (providerFilter === undefined || record.provider === providerFilter)) {
        matched.add(key);
      }
    }
    // Fingerprint lineages carry no provider attribution of their own, so under a provider
    // filter only prefixes attributed above are pruned. Without one, every lineage whose
    // prefix key matches goes, including lineages for capped prefixes the registry never
    // tracked, exactly the ones a full clear must not leave behind.
    const pruned = this.fingerprints.prune((key) =>
      providerFilter === undefined ? matchesKey(key) : matched.has(key),
    );
    for (const key of pruned) {
      matched.add(key);
    }

    for (const key of matched) {
      this.prefixKeys.delete(key);
      this.keeper.remove(key);
      const record = this.resources.get(key);
      if (record !== undefined) {
        this.resources.delete(key);
        // The host mirrors this delete onto the provider, the handle may be orphaned or
        // scoped to a rotated credential, see the invalidate contract on the RACS type.
        this.emit({
          type: 'resource.action',
          directive: {
            kind: 'resource',
            action: 'delete',
            resourceKey: key,
            ttlSeconds: record.ttlSeconds,
          },
          timestamp: now,
        });
      }
    }
    return matched.size;
  }

  profileOf(provider: ProviderId): ProviderProfile {
    return resolveProfile(provider, this.profiles);
  }

  on(listener: TelemetryListener): () => void {
    this.listeners.push(listener);
    return (): void => {
      const index = this.listeners.indexOf(listener);
      if (index !== -1) {
        this.listeners.splice(index, 1);
      }
    };
  }

  async flush(): Promise<void> {
    if (this.state === undefined) {
      return;
    }
    // A flush issued before the startup restore resolves must not overwrite the persisted
    // snapshot with the empty pre-restore state, so it waits for the restore first.
    await this.restored;
    const resources: ResourceRecordJSON[] = [];
    for (const [key, record] of this.resources) {
      resources.push({
        key,
        provider: record.provider,
        ttlSeconds: record.ttlSeconds,
        lastWriteAt: record.lastWriteAt,
      });
    }
    const snapshot: StateSnapshot = {
      version: 1,
      savedAt: this.clock(),
      data: {
        ledger: this.ledger.toJSON(),
        fingerprints: this.fingerprints.toJSON(),
        keeper: this.keeper.toJSON(),
        resources,
        drifts: [...this.driftRing],
      },
    };
    await this.state.save(snapshot);
  }

  async close(): Promise<void> {
    await this.flush();
    this.listeners.length = 0;
  }

  /** Appends one drift report, dropping the oldest beyond {@link DRIFT_RING_CAPACITY}. */
  private pushDrift(report: DriftReport): void {
    this.driftRing.push(report);
    if (this.driftRing.length > DRIFT_RING_CAPACITY) {
      this.driftRing.shift();
    }
  }

  /**
   * Mirrors resource directives into the registry and telemetry: create and refresh start
   * a new TTL window, delete drops the record, reuse leaves the window untouched because
   * reading a resource does not rewrite its server-side TTL.
   */
  private applyResourceDirectives(
    provider: ProviderId,
    directives: readonly CacheDirective[],
    now: number,
  ): void {
    for (const directive of directives) {
      if (directive.kind !== 'resource') {
        continue;
      }
      if (directive.action === 'delete') {
        this.resources.delete(directive.resourceKey);
      } else if (directive.action === 'create' || directive.action === 'refresh') {
        this.resources.set(directive.resourceKey, {
          provider,
          ttlSeconds: directive.ttlSeconds,
          lastWriteAt: now,
        });
      }
      this.emit({ type: 'resource.action', directive, timestamp: now });
    }
  }

  /** Synchronous fan-out over a copy of the listener list, exceptions swallowed. */
  private emit(event: TelemetryEvent): void {
    for (const listener of [...this.listeners]) {
      try {
        listener(event);
      } catch {
        // Listener exceptions are swallowed by contract, telemetry must never break the
        // engine's own hot path, see TelemetryListener.
      }
    }
  }

  /**
   * Defensive startup restore: each snapshot section is applied inside its own try/catch
   * with structural checks first, so one corrupt section never poisons the others and a
   * corrupt snapshot degrades to a fresh engine, never to a crash.
   */
  private async restore(state: StateBackend): Promise<void> {
    let snapshot: StateSnapshot | undefined;
    try {
      snapshot = await state.load();
    } catch {
      return;
    }
    if (snapshot === undefined) {
      return;
    }
    const data: Readonly<Record<string, unknown>> = snapshot.data;
    try {
      const section = data.ledger;
      if (
        isRecord(section) &&
        typeof section.maxPrefixes === 'number' &&
        Array.isArray(section.entries)
      ) {
        this.ledger = Ledger.fromJSON(
          { maxPrefixes: section.maxPrefixes, entries: section.entries },
          this.pricing,
        );
      }
    } catch {
      // Corrupt ledger section skipped, aggregates restart empty.
    }
    try {
      const section = data.fingerprints;
      if (
        isRecord(section) &&
        typeof section.capacity === 'number' &&
        Array.isArray(section.entries)
      ) {
        this.fingerprints = Fingerprints.fromJSON({
          capacity: section.capacity,
          entries: section.entries,
        });
      }
    } catch {
      // Corrupt fingerprint section skipped, drift baselines restart empty.
    }
    try {
      const section = data.keeper;
      if (
        isRecord(section) &&
        typeof section.capacity === 'number' &&
        Array.isArray(section.entries)
      ) {
        this.keeper = TtlKeeper.fromJSON({ capacity: section.capacity, entries: section.entries });
      }
    } catch {
      // Corrupt keeper section skipped, refresh schedule restarts empty.
    }
    try {
      const section = data.resources;
      if (Array.isArray(section)) {
        for (const item of section) {
          if (isResourceRecordJSON(item)) {
            this.resources.set(item.key, {
              provider: item.provider,
              ttlSeconds: item.ttlSeconds,
              lastWriteAt: item.lastWriteAt,
            });
          }
        }
      }
    } catch {
      // Corrupt resource section skipped, the registry restarts empty.
    }
    try {
      const section = data.drifts;
      if (Array.isArray(section)) {
        const reports: DriftReport[] = [];
        for (const item of section) {
          if (isDriftReport(item)) {
            reports.push(item);
          }
        }
        // Restored reports predate anything observed since construction, so they go in
        // front of the ring before it is re-trimmed oldest-first.
        this.driftRing.unshift(...reports.slice(-DRIFT_RING_CAPACITY));
        while (this.driftRing.length > DRIFT_RING_CAPACITY) {
          this.driftRing.shift();
        }
      }
    } catch {
      // Corrupt drift section skipped, the ring restarts empty.
    }
    // The prefix registry is derived state and is not persisted; reseeding it from the
    // restored keeper and resource keys keeps the maxPrefixes accounting honest across
    // restarts instead of resetting the cap to zero. Both sources carry the provider, so
    // provider-scoped invalidation keeps working across restarts too.
    for (const entry of this.keeper.toJSON().entries) {
      this.prefixKeys.set(entry.prefixKey, entry.provider);
    }
    for (const [key, record] of this.resources) {
      this.prefixKeys.set(key, record.provider);
    }
  }
}

/**
 * Creates one RACS (Remote Agent Context Store) engine, the single entry point of the
 * package. Zero-config by default: no options yields a fully working in-memory engine with
 * the shipped provider profiles, seed 7, a 1000-prefix cap, and the platform wall clock.
 *
 * Persistence note: when {@link RACSOptions.state} is given, the previous snapshot is
 * restored asynchronously after construction, section by section, skipping anything
 * corrupt. Hosts that need restored state before their first plan should `await
 * racs.flush()` once after construction, flush waits for the restore to settle.
 *
 * @param options - See {@link RACSOptions}, every field optional.
 * @returns The engine, see {@link RACS} for the full surface contract.
 *
 * @example
 * ```ts
 * const racs = createRACS({ seed: 42 });
 * const plan = racs.plan({
 *   provider: 'anthropic',
 *   model: 'claude-sonnet-4-5',
 *   segments: [
 *     { id: 'system', role: 'system', stability: 'stable', content: SYSTEM_PROMPT },
 *     { id: 'turn', role: 'dynamic', stability: 'volatile', content: userTurn },
 *   ],
 *   reuse: { intervalSeconds: 60 },
 * });
 * // Apply plan.directives to the API call the host owns, then report usage back:
 * racs.record({ provider: 'anthropic', model: 'claude-sonnet-4-5', prefixKey: plan.prefixKey,
 *   inputTokens: 5000, cacheReadTokens: 4200 });
 * ```
 */
export function createRACS(options: RACSOptions = {}): RACS {
  return new RacsEngine(options);
}
