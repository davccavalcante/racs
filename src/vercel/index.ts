/**
 * Packaged Vercel AI SDK middleware for RACS (Remote Agent Context Store): one middleware
 * object that plans cache directives before each call, applies them through provider
 * options, and records the usage the provider reports back, for both generate and stream
 * paths.
 *
 * Structural by design. This module declares its own shapes ({@link CallOptionsLike},
 * {@link GenerateResultLike}, {@link StreamResultLike}, {@link RacsMiddleware}) instead of
 * importing from the `ai` package, so the package keeps its zero-runtime-dependency
 * invariant. The shapes match the `LanguageModelV3Middleware` contract structurally, which
 * is all the Vercel AI SDK requires: pass the object to `wrapLanguageModel({ model, middleware })`
 * and it just works, with no version coupling to the `ai` dependency graph.
 *
 * The product invariant holds here too: the middleware never performs a provider call. It
 * decorates the params the host's own model call will send, and reads the usage the host's
 * own call already produced.
 *
 * @packageDocumentation
 */

import type { PromptSegment, ProviderId, RACS } from '../types.js';

/**
 * Structural stand-in for the Vercel AI SDK call options handed to `transformParams`,
 * `wrapGenerate`, and `wrapStream`. Only the fields the middleware touches are named,
 * everything else flows through the index signature untouched.
 */
export interface CallOptionsLike {
  /** System instructions, a string in most hosts, tolerated in any shape. */
  system?: unknown;
  /** The prompt, usually an array of messages, tolerated in any shape. */
  prompt?: unknown;
  /** Tool definitions, hashed as one stable segment when present. */
  tools?: unknown;
  /** Provider-namespaced options, where cache directives and the RACS stash land. */
  providerOptions?: Record<string, Record<string, unknown>>;
  /** Every other call option flows through unread and unmodified. */
  [k: string]: unknown;
}

/**
 * Structural stand-in for one Vercel AI SDK generate result, the subset usage recording reads.
 * Field availability varies by SDK version and provider, which is why every read falls
 * back along a documented chain, see {@link racsMiddleware}.
 */
export interface GenerateResultLike {
  /** Normalized usage as the Vercel AI SDK reports it, every field optional in the wild. */
  usage?: {
    /** Total billed input tokens, cached and uncached together. */
    inputTokens?: number;
    /** Cached input tokens in the flattened spelling some versions use. */
    cachedInputTokens?: number;
    /** Cached read and write detail in the nested spelling other versions use. */
    inputTokenDetails?: { cacheReadTokens?: number; cacheWriteTokens?: number };
  };
  /** Raw provider metadata, the fallback source for Anthropic cache counters. */
  providerMetadata?: Record<string, Record<string, unknown>>;
  /** Every other result field flows through unread and unmodified. */
  [k: string]: unknown;
}

/** Structural stand-in for one Vercel AI SDK stream result: the part stream plus passthrough. */
export interface StreamResultLike {
  /** The stream of parts the host consumes, teed by the middleware, never consumed by it. */
  stream: ReadableStream<unknown>;
  /** Every other result field flows through unread and unmodified. */
  [k: string]: unknown;
}

/**
 * The middleware surface, structurally compatible with `LanguageModelV3Middleware` from
 * the Vercel AI SDK. Hand the object to `wrapLanguageModel({ model, middleware })`.
 */
export interface RacsMiddleware {
  /** Middleware specification version the Vercel AI SDK dispatches on. */
  readonly middlewareVersion: 'v3';
  /** Plans the call and decorates `providerOptions` with cache directives and the stash. */
  transformParams(input: { params: CallOptionsLike }): Promise<CallOptionsLike>;
  /** Runs the wrapped generate call and records its usage into the engine ledger. */
  wrapGenerate(input: {
    doGenerate: () => PromiseLike<GenerateResultLike>;
    params: CallOptionsLike;
  }): Promise<GenerateResultLike>;
  /** Tees the wrapped stream and records usage from its finish part, parts untouched. */
  wrapStream(input: {
    doStream: () => PromiseLike<StreamResultLike>;
    params: CallOptionsLike;
  }): Promise<StreamResultLike>;
}

/** Construction options for {@link racsMiddleware}. */
export interface RacsMiddlewareOptions {
  /** Provider every call through this middleware targets, selects the adapter family. */
  readonly provider: ProviderId;
  /** Model identifier, verbatim, for plan identity and pricing lookups. */
  readonly model: string;
  /**
   * Replaces {@link defaultSegmenter}. Provide one when the host knows its own prompt
   * anatomy, exact token counts, or stability declarations better than the structural
   * default can guess them, which is most production hosts eventually.
   */
  readonly segmenter?: (params: CallOptionsLike) => readonly PromptSegment[];
  /**
   * Time source returning milliseconds since the Unix epoch, used to stamp recorded
   * usage. Without it, recording omits the timestamp and the engine stamps it with its
   * own injected clock, so the wall clock is never read here directly.
   */
  readonly clock?: () => number;
}

/**
 * Cap on segment content length used for hashing. Segments exist to be keyed and
 * estimated, not stored, and hashing the first 8000 characters keys realistic prompts
 * uniquely while keeping the segmenter allocation-bounded on huge documents. Token
 * estimates for longer segments are therefore floors, hosts needing exact economics
 * should pass a custom segmenter with explicit `tokens`.
 */
const MAX_HASH_CONTENT_CHARS = 8000;

/** True for any non-null object, the first gate of every structural check. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/**
 * JSON-stringifies defensively: circular structures and other stringify throws come back
 * absent instead of propagating, and `undefined` input stays absent.
 */
function safeStringify(value: unknown): string | undefined {
  try {
    const text = JSON.stringify(value);
    return typeof text === 'string' ? text : undefined;
  } catch {
    return undefined;
  }
}

/** Applies the {@link MAX_HASH_CONTENT_CHARS} cap. */
function capForHashing(text: string): string {
  return text.length > MAX_HASH_CONTENT_CHARS ? text.slice(0, MAX_HASH_CONTENT_CHARS) : text;
}

/** Reads one value as a finite non-negative token count, anything else is absent. */
function countOf(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

/**
 * The default prompt segmenter, fully overridable through
 * {@link RacsMiddlewareOptions.segmenter}. It maps the conventional Vercel AI SDK call anatomy
 * onto RACS segments:
 *
 * - `system` (a string, or the head of the `prompt` message array when that head carries
 *   the system role) becomes one `'system'` segment declared stable.
 * - `tools` becomes one `'tools'` segment declared stable, keyed by the JSON
 *   serialization of the tools value, so any byte-level churn in tool definitions
 *   surfaces through the `'unstable-tools'` and drift machinery.
 * - every prompt message except the final one becomes one `'history'` segment declared
 *   semi, history grows monotonically in well-behaved agents.
 * - the final message becomes one `'dynamic'` segment declared volatile, it is the live
 *   turn and differs on every call.
 *
 * Every read is defensive over unknown shapes: non-array prompts, message-less calls, and
 * unstringifiable values degrade to fewer or emptier segments, never to a throw. Content
 * is capped at {@link MAX_HASH_CONTENT_CHARS} characters per segment for hashing, so
 * token estimates on very long segments are floors.
 *
 * @param params - The call options to segment, any structural shape tolerated.
 * @returns Segments in request order, never empty.
 */
export function defaultSegmenter(params: CallOptionsLike): readonly PromptSegment[] {
  const segments: PromptSegment[] = [];
  let messages: readonly unknown[] = Array.isArray(params.prompt) ? params.prompt : [];

  let systemText: string | undefined;
  if (typeof params.system === 'string' && params.system !== '') {
    systemText = params.system;
  } else {
    const head = messages[0];
    if (isRecord(head) && head.role === 'system') {
      const content = head.content;
      systemText = typeof content === 'string' ? content : (safeStringify(content) ?? '');
      messages = messages.slice(1);
    }
  }
  if (systemText !== undefined) {
    segments.push({
      id: 'system',
      role: 'system',
      stability: 'stable',
      content: capForHashing(systemText),
    });
  }

  if (params.tools !== undefined && params.tools !== null) {
    const text = safeStringify(params.tools);
    if (text !== undefined && text !== '[]' && text !== '{}') {
      segments.push({
        id: 'tools',
        role: 'tools',
        stability: 'stable',
        content: capForHashing(text),
      });
    }
  }

  if (messages.length > 1) {
    segments.push({
      id: 'history',
      role: 'history',
      stability: 'semi',
      content: capForHashing(safeStringify(messages.slice(0, -1)) ?? ''),
    });
  }
  if (messages.length > 0) {
    segments.push({
      id: 'dynamic',
      role: 'dynamic',
      stability: 'volatile',
      content: capForHashing(safeStringify(messages[messages.length - 1]) ?? ''),
    });
  } else if (typeof params.prompt === 'string' && params.prompt !== '') {
    segments.push({
      id: 'dynamic',
      role: 'dynamic',
      stability: 'volatile',
      content: capForHashing(params.prompt),
    });
  }

  if (segments.length === 0) {
    // A plan needs at least one segment; an empty call degrades to one empty volatile
    // turn so planning still runs and accounting still attributes the call.
    segments.push({ id: 'dynamic', role: 'dynamic', stability: 'volatile', content: '' });
  }
  return segments;
}

/**
 * Creates the packaged RACS middleware for the Vercel AI SDK.
 *
 * What each hook does:
 *
 * `transformParams` runs {@link RACS.plan} over the segmented prompt and applies the
 * directives through provider options:
 * - Breakpoint family (`'breakpoint'` directives): sets
 *   `providerOptions.anthropic.cacheControl = { type: 'ephemeral' }`, with `ttl: '1h'`
 *   when any planned breakpoint chose the 1-hour tier. Placement note: the Vercel AI SDK applies
 *   message-level `cacheControl` to the last content block of a message; RACS sets the
 *   option at the request level, which the Anthropic provider honors for system and
 *   tools. Finer per-block placement, for example a marker after each planned
 *   `segmentId`, belongs to the host, which owns the message array.
 * - Routing-key family (`'routing-key'` directives): sets
 *   `providerOptions.openai.promptCacheKey` to the deterministic key, plus
 *   `promptCacheRetention: '24h'` when the plan requested extended retention. For
 *   routing-key providers other than OpenAI the key is also mirrored under
 *   `providerOptions.racs.routingKey`, so hosts of those providers can forward it to
 *   whatever request field their provider reads.
 * - Resource and passive families: no parameter changes, the host owns resource
 *   lifecycle calls and passive providers expose no surface.
 * - Always: stashes `{ prefixKey, planId, provider, model }` under
 *   `providerOptions.racs`, the join key the wrap hooks read back at recording time.
 *   Provider-namespaced options unknown to a provider are ignored by it, so the stash
 *   rides the params without affecting the call.
 *
 * `wrapGenerate` awaits the wrapped call and records one {@link RACS} usage with these
 * fallback chains, covering every Vercel AI SDK version and provider spelling in circulation:
 * - `cacheReadTokens`: `usage.inputTokenDetails.cacheReadTokens`, then
 *   `usage.cachedInputTokens`, then `providerMetadata.anthropic.cacheReadInputTokens`,
 *   then zero.
 * - `cacheWriteTokens5m`: `usage.inputTokenDetails.cacheWriteTokens`, then
 *   `providerMetadata.anthropic.cacheCreationInputTokens`, omitted when neither exists.
 * - `inputTokens`: `usage.inputTokens`, then zero, normalized to the all-in convention
 *   {@link CacheUsage.inputTokens} documents: when the resolved input count is smaller
 *   than the resolved cached reads plus writes, the counts are provably exclusive (raw
 *   Anthropic counters surfaced through provider metadata) and the cached subsets are
 *   added back; the inline comment in the recorder documents the heuristic and its limit.
 * When the `providerOptions.racs` stash is absent, because the host skipped
 * `transformParams` or stripped the options, recording proceeds silently without prefix
 * attribution, the call still aggregates into ledger totals. When the wrapped call
 * throws, the error is rethrown and nothing is recorded: no usage exists to record. This
 * is deliberately asymmetric with noeticos-style outcome tracking, where failures are
 * themselves the signal; here the ledger accounts tokens, and a failed call billed none.
 *
 * `wrapStream` tees the result stream through a TransformStream that watches for the
 * finish-shaped part (an object with `type: 'finish'` carrying usage under `part.usage`
 * or `part.totalUsage`), passes every part through untouched, and records once on flush
 * with the same fallback chains as `wrapGenerate`. Stream errors propagate to the
 * consumer unchanged, and an errored stream never reaches flush, so nothing is recorded
 * for it.
 *
 * @param racs - The engine that plans and accounts, see {@link RACS}.
 * @param options - Provider, model, and the optional segmenter and clock overrides.
 * @returns The middleware object, see {@link RacsMiddleware}.
 *
 * @example
 * ```ts
 * import { anthropic } from '@ai-sdk/anthropic';
 * import { wrapLanguageModel } from 'ai';
 * import { createRACS } from '@takk/racs';
 * import { racsMiddleware } from '@takk/racs/vercel';
 *
 * const racs = createRACS();
 * const model = wrapLanguageModel({
 *   model: anthropic('claude-sonnet-4-5'),
 *   middleware: racsMiddleware(racs, { provider: 'anthropic', model: 'claude-sonnet-4-5' }),
 * });
 * // Use `model` with generateText or streamText as usual, then:
 * const { hitRatio, savedUsd } = racs.stats();
 * ```
 */
export function racsMiddleware(racs: RACS, options: RacsMiddlewareOptions): RacsMiddleware {
  const segmenter = options.segmenter ?? defaultSegmenter;

  /** Reads the prefix key from the `providerOptions.racs` stash, absent when missing. */
  const prefixKeyOf = (params: CallOptionsLike): string | undefined => {
    const stash = params.providerOptions?.racs;
    if (stash === undefined) {
      return undefined;
    }
    const prefixKey = stash.prefixKey;
    return typeof prefixKey === 'string' && prefixKey !== '' ? prefixKey : undefined;
  };

  /** Builds and records one usage from any usage-shaped object plus provider metadata. */
  const recordUsage = (
    usageLike: unknown,
    metadataLike: unknown,
    params: CallOptionsLike,
  ): void => {
    const usage = isRecord(usageLike) ? usageLike : {};
    const details = isRecord(usage.inputTokenDetails) ? usage.inputTokenDetails : {};
    const metadata = isRecord(metadataLike) ? metadataLike : {};
    const anthropic = isRecord(metadata.anthropic) ? metadata.anthropic : {};

    const cacheReadTokens =
      countOf(details.cacheReadTokens) ??
      countOf(usage.cachedInputTokens) ??
      countOf(anthropic.cacheReadInputTokens) ??
      0;
    const cacheWriteTokens5m =
      countOf(details.cacheWriteTokens) ?? countOf(anthropic.cacheCreationInputTokens);
    const rawInputTokens = countOf(usage.inputTokens) ?? 0;
    // All-in normalization, see CacheUsage.inputTokens: SDK versions that surface the raw
    // Anthropic counters (providerMetadata.anthropic.cacheCreationInputTokens and peers)
    // report EXCLUSIVE counts where usage.inputTokens carries only the fresh uncached
    // input. Detection: an all-in input can never be smaller than the sum of its own
    // cached subsets, so rawInput < reads + writes proves the counts are exclusive and
    // the subsets are added back. Known limit: exclusive counts whose fresh input
    // outweighs reads plus writes are indistinguishable from all-in counts and pass
    // through unadjusted, undercounting total input; hosts on such SDK versions should
    // normalize in their own segmenter-side accounting before recording.
    const cachedSubsets = cacheReadTokens + (cacheWriteTokens5m ?? 0);
    const inputTokens =
      rawInputTokens < cachedSubsets ? rawInputTokens + cachedSubsets : rawInputTokens;
    const prefixKey = prefixKeyOf(params);

    racs.record({
      provider: options.provider,
      model: options.model,
      ...(prefixKey !== undefined ? { prefixKey } : {}),
      inputTokens,
      cacheReadTokens,
      ...(cacheWriteTokens5m !== undefined ? { cacheWriteTokens5m } : {}),
      ...(options.clock !== undefined ? { timestamp: options.clock() } : {}),
    });
  };

  return {
    middlewareVersion: 'v3',

    transformParams: ({ params }): Promise<CallOptionsLike> => {
      const segments = segmenter(params);
      if (segments.length === 0) {
        // A custom segmenter declared nothing to plan; the params pass through unchanged
        // rather than feeding the engine an input it would reject.
        return Promise.resolve(params);
      }
      const plan = racs.plan({ provider: options.provider, model: options.model, segments });

      let hasBreakpoint = false;
      let wantsOneHour = false;
      let routingKey: string | undefined;
      let routingRetention: '24h' | undefined;
      for (const directive of plan.directives) {
        if (directive.kind === 'breakpoint') {
          hasBreakpoint = true;
          if (directive.ttl === '1h') {
            wantsOneHour = true;
          }
        } else if (directive.kind === 'routing-key') {
          routingKey = directive.key;
          routingRetention = directive.retention;
        }
        // 'resource' and 'none' directives change no parameters by design: resource
        // lifecycle calls belong to the host, passive providers expose no surface.
      }

      const providerOptions: Record<string, Record<string, unknown>> = {
        ...params.providerOptions,
      };
      if (hasBreakpoint) {
        providerOptions.anthropic = {
          ...providerOptions.anthropic,
          cacheControl: { type: 'ephemeral', ...(wantsOneHour ? { ttl: '1h' } : {}) },
        };
      }
      let routingMirror: Record<string, unknown> = {};
      if (routingKey !== undefined) {
        providerOptions.openai = {
          ...providerOptions.openai,
          promptCacheKey: routingKey,
          ...(routingRetention !== undefined ? { promptCacheRetention: '24h' } : {}),
        };
        if (plan.provider !== 'openai') {
          routingMirror = {
            routingKey,
            ...(routingRetention !== undefined ? { retention: '24h' } : {}),
          };
        }
      }
      providerOptions.racs = {
        ...providerOptions.racs,
        ...routingMirror,
        prefixKey: plan.prefixKey,
        planId: plan.planId,
        provider: plan.provider,
        model: plan.model,
      };

      return Promise.resolve({ ...params, providerOptions });
    },

    wrapGenerate: async ({ doGenerate, params }): Promise<GenerateResultLike> => {
      // No try/catch around the wrapped call: a throw means no usage exists to record,
      // so it propagates unrecorded, see the asymmetry note on racsMiddleware.
      const result = await doGenerate();
      recordUsage(result.usage, result.providerMetadata, params);
      return result;
    },

    wrapStream: async ({ doStream, params }): Promise<StreamResultLike> => {
      const result = await doStream();
      let sawFinish = false;
      let finishUsage: unknown;
      let finishMetadata: unknown;
      const watcher = new TransformStream<unknown, unknown>({
        transform: (part, controller): void => {
          if (!sawFinish && isRecord(part) && part.type === 'finish') {
            sawFinish = true;
            const direct = part.usage;
            const total = part.totalUsage;
            if (isRecord(direct)) {
              finishUsage = direct;
            } else if (isRecord(total)) {
              finishUsage = total;
            }
            finishMetadata = part.providerMetadata;
          }
          controller.enqueue(part);
        },
        flush: (): void => {
          // Flush fires only when the source stream completes cleanly; an errored stream
          // propagates its error to the consumer and records nothing.
          if (sawFinish) {
            recordUsage(finishUsage, finishMetadata, params);
          }
        },
      });
      return { ...result, stream: result.stream.pipeThrough(watcher) };
    },
  };
}
