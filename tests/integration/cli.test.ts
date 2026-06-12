/**
 * End-to-end contract tests of the `racs` CLI: exit codes, public output contracts, the
 * analyze gate, the deterministic simulate demonstration, inspect, and the full serve
 * lifecycle including bearer auth, body limits, SIGINT shutdown, and state persistence.
 *
 * HARD-LEARNED HARNESS RULE: never spawn the tsx wrapper binary for exit-code or signal
 * assertions. The wrapper relays SIGINT to its child and then exits 130 itself, which
 * masks the CLI's own exit code (serve exits 0 on SIGINT by contract, the wrapper would
 * report 130). Always spawn the real Node binary with the tsx loader instead:
 *   const NODE = process.execPath;
 *   const LOADER = ['--import', 'tsx'];
 *   spawn(NODE, [...LOADER, CLI, ...args])
 *
 * Determinism: every corpus is written to a fresh /tmp scratch directory, simulate runs on
 * its own fully simulated timeline (asserted byte-identical across two runs), and the only
 * environment-derived value is the pid-derived serve port.
 */

import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it, vi } from 'vitest';

vi.setConfig({ testTimeout: 30_000 });

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const CLI = join(ROOT, 'src', 'cli', 'index.ts');
const NODE = process.execPath;
const LOADER = ['--import', 'tsx'] as const;

/** Pid-derived port so parallel vitest workers never collide on the same listener. */
const PORT = 20_000 + (process.pid % 2_000);
const BASE = `http://127.0.0.1:${PORT}`;
const TOKEN = 'cli-test-secret';
const AUTH = { authorization: `Bearer ${TOKEN}` } as const;

const tmpDir = mkdtempSync('/tmp/racs-cli-');

afterAll(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

interface CliResult {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
}

/** Runs one CLI invocation to completion, per the harness rule above. */
function runCli(args: readonly string[]): Promise<CliResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(NODE, [...LOADER, CLI, ...args], { cwd: ROOT });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });
    child.once('error', reject);
    child.once('close', (code, signal) => {
      resolve({ code, signal, stdout, stderr });
    });
  });
}

interface ServeHandle {
  readonly kill: (signal: NodeJS.Signals) => void;
  readonly exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
}

/** Spawns `racs serve` and resolves once it reports listening, per the harness rule. */
function startServe(args: readonly string[]): Promise<ServeHandle> {
  return new Promise((resolve, reject) => {
    const child = spawn(NODE, [...LOADER, CLI, 'serve', ...args], { cwd: ROOT });
    let output = '';
    const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
      (resolveExit) => {
        child.once('close', (code, signal) => resolveExit({ code, signal }));
      },
    );
    const startupTimer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`racs serve did not report listening in time. Output:\n${output}`));
    }, 20_000);
    const onChunk = (chunk: string): void => {
      output += chunk;
      if (output.includes('racs serve listening on')) {
        clearTimeout(startupTimer);
        resolve({ kill: (signal) => child.kill(signal), exited });
      }
    };
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', onChunk);
    child.stderr.on('data', onChunk);
    child.once('error', (error) => {
      clearTimeout(startupTimer);
      reject(error);
    });
    void exited.then(({ code }) => {
      clearTimeout(startupTimer);
      reject(new Error(`racs serve exited early with code ${String(code)}. Output:\n${output}`));
    });
  });
}

interface RawResponse {
  readonly status: number;
  readonly body: string;
}

/**
 * Issues one HTTP request with a caller-controlled Host header. fetch cannot do this
 * (Host is a forbidden request header there), so the DNS-rebinding checks below speak
 * raw node:http to the loopback listener while presenting an arbitrary Host value.
 */
function rawRequest(options: {
  readonly port: number;
  readonly method: string;
  readonly path: string;
  readonly hostHeader: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: string;
}): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const request = httpRequest(
      {
        host: '127.0.0.1',
        port: options.port,
        method: options.method,
        path: options.path,
        headers: { host: options.hostHeader, ...(options.headers ?? {}) },
      },
      (response) => {
        let body = '';
        response.setEncoding('utf8');
        response.on('data', (chunk: string) => {
          body += chunk;
        });
        response.on('end', () => {
          resolve({ status: response.statusCode ?? 0, body });
        });
      },
    );
    request.once('error', reject);
    if (options.body !== undefined) {
      request.write(options.body);
    }
    request.end();
  });
}

/** A clean PlanInput corpus: stable-first anthropic layout, no findings expected. */
const CLEAN_INPUT = [
  {
    provider: 'anthropic',
    model: 'claude-sonnet-4-5',
    segments: [
      { id: 'system', role: 'system', stability: 'stable', contentHash: 'sys-v1', tokens: 2000 },
      { id: 'turn', role: 'dynamic', stability: 'volatile', contentHash: 'turn-1', tokens: 100 },
    ],
    reuse: { intervalSeconds: 60 },
  },
];

/**
 * The timestamp-poisoned production failure: a live timestamp interpolated into a small
 * "stable" system prompt and a volatile turn placed before the remaining stable segments.
 * Produces the error-severity 'volatile-early' finding, so analyze must exit 1.
 */
const POISONED_INPUT = [
  {
    provider: 'anthropic',
    model: 'claude-sonnet-4-5',
    segments: [
      {
        id: 'sys',
        role: 'system',
        stability: 'stable',
        content: 'You are the deploy assistant. Today is 2026-06-11T09:30:00Z, mind the clock.',
      },
      {
        id: 'turn',
        role: 'dynamic',
        stability: 'volatile',
        content: 'What changed since the last deploy?',
      },
      { id: 'tools', role: 'tools', stability: 'stable', contentHash: 'tools-v1', tokens: 1500 },
      { id: 'docs', role: 'documents', stability: 'semi', contentHash: 'docs-v1', tokens: 1000 },
    ],
  },
];

describe('racs help and version', () => {
  it('help exits 0, the first stdout line is exactly the public CI contract', async () => {
    const result = await runCli(['help']);
    expect(result.code).toBe(0);
    const lines = result.stdout.split('\n');
    expect(lines[0]).toBe('racs 1.0.0');
    for (const command of ['analyze', 'simulate', 'inspect', 'serve']) {
      expect(result.stdout).toContain(`  ${command} `);
    }
  });

  it('version, -v, and --version print 1.0.0 and exit 0', async () => {
    for (const flag of ['version', '-v', '--version']) {
      const result = await runCli([flag]);
      expect(result.code).toBe(0);
      expect(result.stdout.trim()).toBe('1.0.0');
    }
  });

  it('an unknown command exits 2 with the exact stderr line', async () => {
    const result = await runCli(['frobnicate']);
    expect(result.code).toBe(2);
    expect(result.stderr.trim()).toBe('racs: unknown command "frobnicate". Run "racs help".');
  });
});

describe('racs analyze', () => {
  it('a clean corpus exits 0 and prints the summary block', async () => {
    const path = join(tmpDir, 'clean.json');
    writeFileSync(path, JSON.stringify(CLEAN_INPUT), 'utf8');
    const result = await runCli(['analyze', '--input', path]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('--- summary ---');
    expect(result.stdout).toContain('errors: 0');
  });

  it('a timestamp-poisoned corpus exits 1 with a LINT error line', async () => {
    const path = join(tmpDir, 'poisoned.json');
    writeFileSync(path, JSON.stringify(POISONED_INPUT), 'utf8');
    const result = await runCli(['analyze', '--input', path]);
    expect(result.code).toBe(1);
    expect(result.stdout).toContain('LINT error');
    expect(result.stdout).toContain('volatile-early');
    expect(result.stdout).toContain('timestamp-in-stable');
  });

  it('analyze without --input exits 2', async () => {
    const result = await runCli(['analyze']);
    expect(result.code).toBe(2);
    expect(result.stderr.trim()).toBe('racs analyze: --input <path> is required.');
  });
});

describe('racs simulate', () => {
  it('two runs with --calls 200 --seed 7 are byte-identical and show caching pays', async () => {
    const first = await runCli(['simulate', '--calls', '200', '--seed', '7']);
    const second = await runCli(['simulate', '--calls', '200', '--seed', '7']);
    expect(first.code).toBe(0);
    expect(second.code).toBe(0);
    expect(first.stdout).toBe(second.stdout);

    // The structured-versus-naive delta line is the public demonstration contract.
    expect(first.stdout).toMatch(
      /structured prompt saves \$-?\d+\.\d+ \(-?\d+\.\d+%\) versus naive/,
    );

    const structured = /structured: hit ratio (\d+\.\d+), net savings (-?\d+\.\d+) USD/.exec(
      first.stdout,
    );
    const naive = /naive: hit ratio (\d+\.\d+), write-premium loss (-?\d+\.\d+) USD/.exec(
      first.stdout,
    );
    if (structured === null || naive === null) {
      throw new Error(`simulate summary lines missing from output:\n${first.stdout}`);
    }
    const structuredRatio = Number(structured[1]);
    const naiveRatio = Number(naive[1]);
    expect(structuredRatio).toBeGreaterThan(0.8);
    expect(naiveRatio).toBe(0);
  });
});

describe('racs inspect', () => {
  it('a missing state path is a valid answer, message printed and exit 0', async () => {
    const path = join(tmpDir, 'missing-state.json');
    const result = await runCli(['inspect', '--state', path]);
    expect(result.code).toBe(0);
    expect(result.stdout.trim()).toBe(`no state found at ${path}`);
  });
});

describe('racs serve host-header validation', () => {
  const JSON_TYPE = { 'content-type': 'application/json' } as const;
  const USAGE_BODY = JSON.stringify({
    provider: 'anthropic',
    model: 'serve-model',
    inputTokens: 1000,
    cacheReadTokens: 0,
  });

  it('a tokenless instance answers 403 to non-loopback Host headers and 200 to loopback ones', async () => {
    const port = PORT + 1;
    const server = await startServe(['--port', String(port)]);
    try {
      // The DNS-rebinding shape: the bytes arrive on 127.0.0.1, the Host header says
      // evil.com. Both mutating endpoints must refuse before routing.
      const usageEvil = await rawRequest({
        port,
        method: 'POST',
        path: '/usage',
        hostHeader: 'evil.com',
        headers: JSON_TYPE,
        body: USAGE_BODY,
      });
      expect(usageEvil.status).toBe(403);
      expect(JSON.parse(usageEvil.body)).toEqual({ error: 'forbidden host' });

      const invalidateEvil = await rawRequest({
        port,
        method: 'POST',
        path: '/invalidate',
        hostHeader: 'evil.com',
        headers: JSON_TYPE,
        body: '{}',
      });
      expect(invalidateEvil.status).toBe(403);
      expect(JSON.parse(invalidateEvil.body)).toEqual({ error: 'forbidden host' });

      // /healthz is host-checked too in tokenless mode: it leaks nothing, but one
      // consistent gate beats an exception, the documented posture choice.
      const healthEvil = await rawRequest({
        port,
        method: 'GET',
        path: '/healthz',
        hostHeader: 'evil.com',
      });
      expect(healthEvil.status).toBe(403);

      // The legitimate loopback Host, port included as real clients send it, passes.
      const usageLocal = await rawRequest({
        port,
        method: 'POST',
        path: '/usage',
        hostHeader: `127.0.0.1:${port}`,
        headers: JSON_TYPE,
        body: USAGE_BODY,
      });
      expect(usageLocal.status).toBe(200);
      expect(JSON.parse(usageLocal.body)).toEqual({ ok: true });
    } finally {
      server.kill('SIGINT');
      await server.exited;
    }
  });

  it('with a token the bearer is the gate: an evil Host plus a valid bearer is served', async () => {
    const port = PORT + 2;
    const server = await startServe(['--port', String(port), '--token', TOKEN]);
    try {
      const usage = await rawRequest({
        port,
        method: 'POST',
        path: '/usage',
        hostHeader: 'evil.com',
        headers: { ...JSON_TYPE, ...AUTH },
        body: USAGE_BODY,
      });
      expect(usage.status).toBe(200);
      expect(JSON.parse(usage.body)).toEqual({ ok: true });
    } finally {
      server.kill('SIGINT');
      await server.exited;
    }
  });
});

describe('racs serve lifecycle', () => {
  it('serves the engine over HTTP with auth, limits, clean SIGINT, and state persistence', async () => {
    const statePath = join(tmpDir, 'serve-state.json');
    const serveArgs = ['--port', String(PORT), '--token', TOKEN, '--state', statePath];
    const planInput = {
      provider: 'anthropic',
      model: 'serve-model',
      segments: [
        { id: 'system', role: 'system', stability: 'stable', contentHash: 'sys-v1', tokens: 2000 },
        { id: 'turn', role: 'dynamic', stability: 'volatile', contentHash: 'turn-1', tokens: 100 },
      ],
      reuse: { intervalSeconds: 60 },
    };

    const first = await startServe(serveArgs);

    // /healthz stays open without any bearer even when --token is set.
    const health = await fetch(`${BASE}/healthz`);
    expect(health.status).toBe(200);
    expect(await health.json()).toEqual({ ok: true });

    // Everything else is 401 without a bearer and 401 with the wrong bearer.
    expect((await fetch(`${BASE}/stats`)).status).toBe(401);
    expect(
      (await fetch(`${BASE}/stats`, { headers: { authorization: 'Bearer wrong-secret' } })).status,
    ).toBe(401);

    // The right bearer opens the surface.
    const statsEmpty = await fetch(`${BASE}/stats`, { headers: AUTH });
    expect(statsEmpty.status).toBe(200);

    // POST /plan answers a CachePlan carrying provider-faithful directives.
    const planRes = await fetch(`${BASE}/plan`, {
      method: 'POST',
      headers: { ...AUTH, 'content-type': 'application/json' },
      body: JSON.stringify(planInput),
    });
    expect(planRes.status).toBe(200);
    const plan = (await planRes.json()) as {
      planId: string;
      prefixKey: string;
      directives: readonly { kind: string }[];
    };
    expect(typeof plan.planId).toBe('string');
    expect(typeof plan.prefixKey).toBe('string');
    expect(plan.directives.length).toBeGreaterThan(0);
    expect(plan.directives[0]?.kind).toBe('breakpoint');

    // POST /usage ingests one call, GET /stats then shows it.
    const usageRes = await fetch(`${BASE}/usage`, {
      method: 'POST',
      headers: { ...AUTH, 'content-type': 'application/json' },
      body: JSON.stringify({
        provider: 'anthropic',
        model: 'serve-model',
        prefixKey: plan.prefixKey,
        inputTokens: 5000,
        cacheReadTokens: 4000,
      }),
    });
    expect(usageRes.status).toBe(200);
    expect(await usageRes.json()).toEqual({ ok: true });

    const statsRes = await fetch(`${BASE}/stats`, { headers: AUTH });
    expect(statsRes.status).toBe(200);
    const stats = (await statsRes.json()) as {
      calls: number;
      readTokens: number;
      hitRatio: number;
    };
    expect(stats.calls).toBe(1);
    expect(stats.readTokens).toBe(4000);
    // 4000 cached reads over 4000 + 1000 uncached input tokens.
    expect(stats.hitRatio).toBeCloseTo(0.8, 9);

    // POST /invalidate clears the one tracked prefix and reports the count.
    const invalidateRes = await fetch(`${BASE}/invalidate`, {
      method: 'POST',
      headers: { ...AUTH, 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(invalidateRes.status).toBe(200);
    expect(await invalidateRes.json()).toEqual({ invalidated: 1 });

    // 415 on a non-JSON content type.
    const unsupported = await fetch(`${BASE}/plan`, {
      method: 'POST',
      headers: { ...AUTH, 'content-type': 'text/plain' },
      body: '{}',
    });
    expect(unsupported.status).toBe(415);

    // 413 once the body crosses the 1 MB cap.
    const tooLarge = await fetch(`${BASE}/plan`, {
      method: 'POST',
      headers: { ...AUTH, 'content-type': 'application/json' },
      body: `{"pad":"${'x'.repeat(1_100_000)}"}`,
    });
    expect(tooLarge.status).toBe(413);

    // 404 catch-all on unknown paths.
    const missing = await fetch(`${BASE}/definitely-not-a-route`, { headers: AUTH });
    expect(missing.status).toBe(404);

    // SIGINT shuts down cleanly: exit code 0, no terminating signal, state flushed.
    first.kill('SIGINT');
    const firstExit = await first.exited;
    expect(firstExit.code).toBe(0);
    expect(firstExit.signal).toBeNull();
    expect(existsSync(statePath)).toBe(true);

    // A restarted serve reloads the snapshot: ledger statistics persist (invalidate
    // clears cache bookkeeping, never accounting records, per the engine contract).
    const second = await startServe(serveArgs);
    const restoredRes = await fetch(`${BASE}/stats`, { headers: AUTH });
    expect(restoredRes.status).toBe(200);
    const restored = (await restoredRes.json()) as {
      calls: number;
      readTokens: number;
      prefixes: readonly { prefixKey: string }[];
    };
    expect(restored.calls).toBe(1);
    expect(restored.readTokens).toBe(4000);
    expect(restored.prefixes.map((prefix) => prefix.prefixKey)).toEqual([plan.prefixKey]);

    second.kill('SIGINT');
    const secondExit = await second.exited;
    expect(secondExit.code).toBe(0);
    expect(secondExit.signal).toBeNull();
  });
});
