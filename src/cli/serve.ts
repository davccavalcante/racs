/**
 * `racs serve`: a hardened local HTTP bridge around one RACS (Remote Agent Context Store)
 * engine, the family posture for sidecar processes.
 *
 * The bridge exposes the engine surface as JSON endpoints so non-JavaScript hosts can
 * plan, lint, record usage, and read statistics. It is a bridge, not a proxy: per the
 * product invariant it never talks to any provider network API, it only serves the
 * engine's own pure logic.
 *
 * Endpoints:
 * - `GET /healthz` (no bearer required): `{ok:true}`. In tokenless mode it is still
 *   host-checked like every other route, see the security posture below.
 * - `POST /plan`: body {@link PlanInput}, answers the {@link CachePlan}.
 * - `POST /lint`: body {@link PlanInput}, answers the findings array.
 * - `POST /usage`: body {@link CacheUsage}, answers `{ok:true}`.
 * - `GET /stats`: answers {@link LedgerStats}.
 * - `GET /schedule`: answers the refresh entries due now.
 * - `POST /refreshed`: body `{prefixKey}`, answers `{ok:true}`.
 * - `POST /invalidate`: body `{prefixKey?, provider?}`, answers `{invalidated:n}`.
 *   `invalidate()` landed on the core RACS contract from a parallel work stream; the
 *   handler keeps a `typeof` probe as transition hardening and answers 501 on any mixed
 *   build where the method is absent, see the handler note.
 *
 * Security posture:
 * - Bearer auth on everything but `/healthz` when `--token` is set, compared in constant
 *   time via `timingSafeEqual` over sha256 digests so neither length nor prefix leaks.
 * - Refuses to bind a non-loopback host without `--token`; `--insecure-no-token`
 *   overrides with a loud warning.
 * - Tokenless instances validate the Host header: any request whose hostname (port
 *   stripped, IPv6 brackets tolerated) is not loopback (`localhost`, `127.0.0.1`, `::1`)
 *   is answered 403 `{error:'forbidden host'}`. This closes the DNS-rebinding vector
 *   where a hostile page resolves its own name to 127.0.0.1 and scripts requests at the
 *   bridge. `/healthz` is host-checked too: it leaks nothing, but one consistent gate is
 *   easier to audit than an exception. With `--token` the bearer is the gate and the
 *   Host header is not consulted.
 * - POST bodies must be `application/json` (415 otherwise) and at most 1 MB (413).
 * - CORS preflight is answered only when `--token` AND `--cors-origin` are both set,
 *   otherwise no CORS header is ever emitted.
 *
 * Lifecycle: SIGINT and SIGTERM handlers are registered before `listen`, close idle
 * connections, close the server, close the engine (which flushes state), and exit 0.
 * With `--state`, a 30-second unref'd timer flushes snapshots while serving.
 *
 * @packageDocumentation
 */

import { createHash, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createServer } from 'node:http';
import { createRACS } from '../core/createRACS.js';
import { RacsError } from '../errors.js';
import { fileState } from '../state/file.js';
import type { CacheUsage, PlanInput, ProviderId, RACS } from '../types.js';
import { flagPresent, parseArgs, readBoolean, readNumber, readString } from './args.js';

/** Default TCP port, fixed for the family so sidecar configs stay copy-pasteable. */
const DEFAULT_PORT = 4378;

/** Default bind host, loopback only, never the open network by default. */
const DEFAULT_HOST = '127.0.0.1';

/** POST body cap in bytes, large enough for any sane PlanInput, small enough to be safe. */
const MAX_BODY_BYTES = 1_048_576;

/** Milliseconds between periodic state flushes when `--state` is set. */
const FLUSH_INTERVAL_MS = 30_000;

/**
 * Hosts that resolve to the local machine only. Double duty: the bind hosts allowed
 * without a token, and the only Host header names a tokenless instance serves (the
 * bracketed IPv6 form `[::1]` normalizes to `::1` before the lookup).
 */
const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(['127.0.0.1', '::1', 'localhost']);

/** The POST endpoints the bridge serves, everything else is 404. */
const POST_PATHS: ReadonlySet<string> = new Set([
  '/plan',
  '/lint',
  '/usage',
  '/refreshed',
  '/invalidate',
]);

/** Everything one request handler invocation needs, fixed at startup. */
interface ServeContext {
  readonly engine: RACS;
  readonly token?: string;
  /** Set only when `--token` AND `--cors-origin` were both given, see the posture note. */
  readonly corsOrigin?: string;
}

/** Human-readable rendering of an unknown thrown value for error messages. */
function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** True for any non-null object. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** SHA-256 digest of a string, the fixed-length form `timingSafeEqual` requires. */
function sha256(text: string): Buffer {
  return createHash('sha256').update(text, 'utf8').digest();
}

/**
 * Extracts the lowercased hostname from a Host header value: any port suffix is
 * stripped, and the bracketed IPv6 form (`[::1]:4378`) is unwrapped to the bare address.
 */
function hostHeaderName(header: string): string {
  const value = header.trim().toLowerCase();
  if (value.startsWith('[')) {
    const closing = value.indexOf(']');
    return closing === -1 ? value : value.slice(1, closing);
  }
  const colon = value.indexOf(':');
  return colon === -1 ? value : value.slice(0, colon);
}

/**
 * True when the request's Host header names the local machine. Tokenless instances serve
 * loopback names only: a browser on the same machine can be lured to a hostile DNS name
 * that resolves to 127.0.0.1 (DNS rebinding), and the Host header is the signal that
 * survives that trick. A missing Host header fails closed.
 */
function isLoopbackHostHeader(header: string | undefined): boolean {
  return header !== undefined && LOOPBACK_HOSTS.has(hostHeaderName(header));
}

/**
 * Constant-time bearer check: both sides are hashed to fixed-length digests first, so
 * `timingSafeEqual` never throws on length mismatch and comparison time is independent
 * of how much of the token an attacker guessed.
 */
function bearerMatches(header: string | undefined, token: string): boolean {
  if (header === undefined || !header.startsWith('Bearer ')) {
    return false;
  }
  return timingSafeEqual(sha256(header.slice('Bearer '.length)), sha256(token));
}

/** Writes one JSON response, attaching the CORS origin header when configured. */
function sendJson(
  res: ServerResponse,
  status: number,
  body: unknown,
  corsOrigin: string | undefined,
): void {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    ...(corsOrigin !== undefined ? { 'access-control-allow-origin': corsOrigin } : {}),
  });
  res.end(JSON.stringify(body));
}

/**
 * Reads the request body up to {@link MAX_BODY_BYTES}. Past the cap the buffered chunks
 * are dropped and the rest of the stream is drained and discarded, so the 413 response
 * goes out on a cleanly finished request instead of a destroyed socket.
 */
function readBody(req: IncomingMessage): Promise<Buffer | 'too-large'> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let tooLarge = false;
    req.on('data', (chunk: Buffer) => {
      if (tooLarge) {
        return;
      }
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        tooLarge = true;
        chunks.length = 0;
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      resolve(tooLarge ? 'too-large' : Buffer.concat(chunks));
    });
    req.on('error', (error) => {
      reject(error);
    });
  });
}

/** Routes one authenticated, parsed POST body to the engine. */
function handlePost(path: string, parsed: unknown, res: ServerResponse, ctx: ServeContext): void {
  switch (path) {
    case '/plan': {
      sendJson(res, 200, ctx.engine.plan(parsed as PlanInput), ctx.corsOrigin);
      return;
    }
    case '/lint': {
      sendJson(res, 200, ctx.engine.lint(parsed as PlanInput), ctx.corsOrigin);
      return;
    }
    case '/usage': {
      ctx.engine.record(parsed as CacheUsage);
      sendJson(res, 200, { ok: true }, ctx.corsOrigin);
      return;
    }
    case '/refreshed': {
      const prefixKey = isRecord(parsed) ? parsed.prefixKey : undefined;
      if (typeof prefixKey !== 'string' || prefixKey === '') {
        sendJson(
          res,
          400,
          { error: 'body must carry a non-empty prefixKey string' },
          ctx.corsOrigin,
        );
        return;
      }
      ctx.engine.markRefreshed(prefixKey);
      sendJson(res, 200, { ok: true }, ctx.corsOrigin);
      return;
    }
    case '/invalidate': {
      // invalidate() landed on the core RACS contract while the CLI was built in a
      // parallel work stream. The runtime typeof probe stays as transition hardening: a
      // mixed build where the method is absent answers 501 instead of crashing, and the
      // final integrate pass can drop the guard once both streams are unified.
      const engine: RACS = ctx.engine;
      if (typeof engine.invalidate !== 'function') {
        sendJson(
          res,
          501,
          { error: 'invalidate is not implemented by this engine build' },
          ctx.corsOrigin,
        );
        return;
      }
      const body = isRecord(parsed) ? parsed : {};
      const prefixKey = typeof body.prefixKey === 'string' ? body.prefixKey : undefined;
      const provider =
        typeof body.provider === 'string' && body.provider !== ''
          ? (body.provider as ProviderId)
          : undefined;
      const invalidated = engine.invalidate({
        ...(prefixKey !== undefined ? { prefixKey } : {}),
        ...(provider !== undefined ? { provider } : {}),
      });
      sendJson(res, 200, { invalidated }, ctx.corsOrigin);
      return;
    }
    default: {
      sendJson(res, 404, { error: 'not found' }, ctx.corsOrigin);
    }
  }
}

/** Full request pipeline: health, preflight, auth, content-type, size cap, dispatch. */
async function handle(req: IncomingMessage, res: ServerResponse, ctx: ServeContext): Promise<void> {
  const method = req.method ?? 'GET';
  const path = (req.url ?? '/').split('?')[0] ?? '/';

  // Tokenless instances are loopback-only end to end: any request whose Host header is
  // not a loopback name is refused before routing (DNS-rebinding defense). /healthz is
  // checked too, consistency wins over the nothing-leaked argument. With a token the
  // bearer is the gate and the Host header is not consulted.
  if (ctx.token === undefined && !isLoopbackHostHeader(req.headers.host)) {
    req.resume();
    sendJson(res, 403, { error: 'forbidden host' }, ctx.corsOrigin);
    return;
  }

  if (method === 'GET' && path === '/healthz') {
    sendJson(res, 200, { ok: true }, ctx.corsOrigin);
    return;
  }

  if (method === 'OPTIONS') {
    if (ctx.corsOrigin !== undefined) {
      res.writeHead(204, {
        'access-control-allow-origin': ctx.corsOrigin,
        'access-control-allow-methods': 'GET, POST, OPTIONS',
        'access-control-allow-headers': 'authorization, content-type',
        'access-control-max-age': '600',
      });
      res.end();
      return;
    }
    sendJson(res, 404, { error: 'not found' }, undefined);
    return;
  }

  if (ctx.token !== undefined && !bearerMatches(req.headers.authorization, ctx.token)) {
    req.resume();
    sendJson(res, 401, { error: 'unauthorized' }, ctx.corsOrigin);
    return;
  }

  if (method === 'GET') {
    if (path === '/stats') {
      sendJson(res, 200, ctx.engine.stats(), ctx.corsOrigin);
      return;
    }
    if (path === '/schedule') {
      sendJson(res, 200, ctx.engine.schedule(), ctx.corsOrigin);
      return;
    }
    sendJson(res, 404, { error: 'not found' }, ctx.corsOrigin);
    return;
  }

  if (method !== 'POST' || !POST_PATHS.has(path)) {
    req.resume();
    sendJson(res, 404, { error: 'not found' }, ctx.corsOrigin);
    return;
  }

  const contentType = req.headers['content-type'];
  if (contentType === undefined || !contentType.toLowerCase().startsWith('application/json')) {
    req.resume();
    sendJson(res, 415, { error: 'content-type must be application/json' }, ctx.corsOrigin);
    return;
  }

  const body = await readBody(req);
  if (body === 'too-large') {
    sendJson(
      res,
      413,
      { error: `request body exceeds the ${MAX_BODY_BYTES}-byte cap` },
      ctx.corsOrigin,
    );
    return;
  }

  let parsed: unknown;
  try {
    parsed = body.length === 0 ? {} : (JSON.parse(body.toString('utf8')) as unknown);
  } catch {
    sendJson(res, 400, { error: 'request body is not valid JSON' }, ctx.corsOrigin);
    return;
  }

  try {
    handlePost(path, parsed, res, ctx);
  } catch (error: unknown) {
    if (error instanceof RacsError && error.code === 'ERR_INVALID_INPUT') {
      sendJson(res, 400, { error: error.message }, ctx.corsOrigin);
      return;
    }
    throw error;
  }
}

/**
 * Runs the serve command, see the module-level contract.
 *
 * @param argv - Tokens after the `serve` command word.
 * @returns Process exit code: 0 once listening (the server then owns the process until a
 *   signal arrives), 1 on refused startup or listen failure, 2 on usage errors.
 */
export async function runServe(argv: readonly string[]): Promise<number> {
  const args = parseArgs(argv);
  const port = readNumber(args, 'port', DEFAULT_PORT);
  if (port === undefined || !Number.isInteger(port) || port < 0 || port > 65535) {
    console.error('racs serve: --port must be an integer between 0 and 65535.');
    return 2;
  }
  const host = readString(args, 'host') ?? DEFAULT_HOST;
  if (flagPresent(args, 'host') && (readString(args, 'host') === undefined || host === '')) {
    console.error('racs serve: --host requires a hostname or address value.');
    return 2;
  }
  const token = readString(args, 'token');
  if (flagPresent(args, 'token') && (token === undefined || token === '')) {
    console.error('racs serve: --token requires a non-empty secret value.');
    return 2;
  }
  const statePath = readString(args, 'state');
  if (flagPresent(args, 'state') && (statePath === undefined || statePath === '')) {
    console.error('racs serve: --state requires a file path value.');
    return 2;
  }
  let seed: number | undefined;
  if (flagPresent(args, 'seed')) {
    seed = readNumber(args, 'seed', 0);
    if (seed === undefined) {
      console.error('racs serve: --seed must be a finite number.');
      return 2;
    }
  }
  const insecure = readBoolean(args, 'insecure-no-token');
  const corsOriginFlag = readString(args, 'cors-origin');

  if (token === undefined && !LOOPBACK_HOSTS.has(host)) {
    if (!insecure) {
      console.error(
        `racs serve: refusing to bind non-loopback host '${host}' without --token. ` +
          `Pass --token <secret>, or accept unauthenticated network access explicitly ` +
          `with --insecure-no-token.`,
      );
      return 1;
    }
    console.error(
      `racs serve: WARNING: binding non-loopback host '${host}' WITHOUT authentication ` +
        `(--insecure-no-token). Anyone who can reach this port can read statistics and ` +
        `mutate engine state.`,
    );
  }
  if (corsOriginFlag !== undefined && token === undefined) {
    console.error('racs serve: --cors-origin is ignored without --token, no CORS headers sent.');
  }
  const corsOrigin =
    token !== undefined && corsOriginFlag !== undefined && corsOriginFlag !== ''
      ? corsOriginFlag
      : undefined;

  const engine = createRACS({
    ...(seed !== undefined ? { seed } : {}),
    ...(statePath !== undefined ? { state: fileState({ path: statePath }) } : {}),
  });
  if (statePath !== undefined) {
    // Flush waits for the startup restore to settle, so the first request never races the
    // snapshot load, and it writes the initial snapshot so the path is valid from minute
    // zero instead of failing only at the first periodic flush.
    try {
      await engine.flush();
    } catch (error: unknown) {
      console.error(`racs serve: cannot initialize state at '${statePath}': ${describe(error)}`);
      return 1;
    }
  }

  const ctx: ServeContext = {
    engine,
    ...(token !== undefined ? { token } : {}),
    ...(corsOrigin !== undefined ? { corsOrigin } : {}),
  };

  const server = createServer((req, res) => {
    void handle(req, res, ctx).catch((error: unknown) => {
      console.error(`racs serve: request failed: ${describe(error)}`);
      if (!res.headersSent) {
        sendJson(res, 500, { error: 'internal error' }, ctx.corsOrigin);
      } else {
        res.destroy();
      }
    });
  });

  let flushTimer: NodeJS.Timeout | undefined;
  if (statePath !== undefined) {
    flushTimer = setInterval(() => {
      void engine.flush().catch((error: unknown) => {
        console.error(`racs serve: periodic state flush failed: ${describe(error)}`);
      });
    }, FLUSH_INTERVAL_MS);
    // Unref'd so the flush timer never keeps a closing process alive on its own.
    flushTimer.unref();
  }

  // Signal handlers are registered BEFORE listen, so a signal arriving in the listen
  // window still shuts down cleanly: idle connections closed, server closed, engine
  // closed (which flushes state), exit 0.
  let shuttingDown = false;
  const shutdown = (): void => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    if (flushTimer !== undefined) {
      clearInterval(flushTimer);
    }
    server.closeIdleConnections();
    server.close();
    void engine
      .close()
      .catch((error: unknown) => {
        console.error(`racs serve: state flush on shutdown failed: ${describe(error)}`);
      })
      .finally(() => {
        process.exit(0);
      });
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);

  return await new Promise<number>((resolve) => {
    server.once('error', (error: unknown) => {
      console.error(`racs serve: ${describe(error)}`);
      resolve(1);
    });
    server.listen(port, host, () => {
      console.log(`racs serve listening on http://${host}:${port}`);
      resolve(0);
    });
  });
}
