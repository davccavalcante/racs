#!/usr/bin/env node
/**
 * Documentation link gate for @takk/racs (RACS, Remote Agent Context Store),
 * the family-standard pre-release check wired into release.yml.
 *
 * Policy:
 * - Every RELATIVE link target in the markdown docs must exist on disk.
 *   A broken relative link is always a failure.
 * - EXTERNAL http(s) links are probed (HEAD, GET fallback) unless
 *   `--skip-external` is passed. A hard failure (network error on a
 *   resolvable host, or HTTP >= 400 outside the tolerated cases) fails
 *   the gate.
 * - BOT-GATED hosts (LinkedIn, X, and peers) answer CI probes with
 *   401/403/429/999; those statuses are tolerated for the listed hosts
 *   and reported as reachable-but-gated.
 * - The package's OWN npm page is skipped pre-publish: before the first
 *   `npm publish` the page cannot exist, so when the registry returns 404
 *   for @takk/racs the npm-page links are reported as pending, not failed.
 *   Once the registry knows the package, the page is probed normally.
 * - The CANONICAL site https://racs.takk.ag/ is pending-by-design: DNS for
 *   the family domains is provisioned family-wide and may not resolve yet.
 *   A DNS miss on that exact host warns and passes; the moment the record
 *   resolves, the check re-arms and any HTTP failure there blocks again.
 *
 * Exit codes: 0 clean (warnings allowed), 1 failures found.
 * Zero dependencies, Node 20+, global fetch.
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SKIP_EXTERNAL = process.argv.includes('--skip-external');

/** Directories never scanned for markdown. */
const EXCLUDED_DIRS = new Set(['node_modules', 'dist', 'coverage', '.git', 'assets']);

/** Hosts that answer automated probes with auth or rate-limit statuses. */
const BOT_GATED_HOSTS = new Set([
  'linkedin.com',
  'www.linkedin.com',
  'x.com',
  'twitter.com',
  'www.npmjs.com', // bot-gates aggressively; the registry API is the truth source
]);

/** Statuses tolerated for bot-gated hosts: the host exists, it just said no to a bot. */
const BOT_GATED_STATUSES = new Set([401, 403, 405, 429, 999]);

/** The canonical project site, pending family-wide DNS by design. */
const CANONICAL_HOST = 'racs.takk.ag';

/** This package's npm page prefix, skipped pre-publish. */
const OWN_NPM_PAGE_PREFIX = 'https://www.npmjs.com/package/@takk/racs';

/** Registry URL used to decide whether the package is published yet. */
const OWN_REGISTRY_URL = 'https://registry.npmjs.org/@takk%2fracs';

/** Per-request timeout in milliseconds. */
const TIMEOUT_MS = 15_000;

/** Recursively collects markdown files under `dir`. */
function collectMarkdown(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!EXCLUDED_DIRS.has(entry.name)) {
        out.push(...collectMarkdown(join(dir, entry.name)));
      }
    } else if (entry.name.endsWith('.md')) {
      out.push(join(dir, entry.name));
    }
  }
  return out;
}

/**
 * Extracts link targets from one markdown text: inline `[text](target)` links
 * and autolinks `<https://...>`. Fenced code blocks and inline code spans are
 * stripped first so example snippets never produce probes.
 */
function extractTargets(text) {
  const withoutFences = text.replace(/```[\s\S]*?```/g, '');
  const withoutInlineCode = withoutFences.replace(/`[^`\n]*`/g, '');
  const targets = [];
  const inline = /\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
  for (const match of withoutInlineCode.matchAll(inline)) {
    targets.push(match[1]);
  }
  const auto = /<(https?:\/\/[^>\s]+)>/g;
  for (const match of withoutInlineCode.matchAll(auto)) {
    targets.push(match[1]);
  }
  return targets;
}

/** True when the URL points at this package's own npm page. */
function isOwnNpmPage(url) {
  return url.startsWith(OWN_NPM_PAGE_PREFIX);
}

/** Fetch with a timeout, HEAD first, GET fallback for HEAD-hostile servers. */
async function probe(url) {
  const attempt = async (method) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      return await fetch(url, {
        method,
        redirect: 'follow',
        signal: controller.signal,
        headers: { 'user-agent': 'racs-link-check/1.0 (+https://github.com/davccavalcante/racs)' },
      });
    } finally {
      clearTimeout(timer);
    }
  };
  let response = await attempt('HEAD');
  if (response.status === 405 || response.status === 404 || response.status === 403) {
    response = await attempt('GET');
  }
  return response;
}

/** True when a thrown fetch error is a DNS miss rather than a refusal. */
function isDnsMiss(error) {
  const code = error?.cause?.code ?? error?.code;
  return code === 'ENOTFOUND' || code === 'EAI_AGAIN';
}

const failures = [];
const warnings = [];
const notes = [];

// --- 1. Relative targets must exist on disk -------------------------------

const files = collectMarkdown(ROOT);
const externals = new Map(); // url -> [containing files]

for (const file of files) {
  const text = readFileSync(file, 'utf8');
  for (const raw of extractTargets(text)) {
    if (raw.startsWith('http://') || raw.startsWith('https://')) {
      const list = externals.get(raw) ?? [];
      list.push(file);
      externals.set(raw, list);
      continue;
    }
    if (raw.startsWith('mailto:') || raw.startsWith('#')) {
      continue; // mail and in-page anchors are out of scope for the disk check
    }
    const target = raw.split('#')[0].split('?')[0];
    if (target === '') {
      continue;
    }
    const resolved = resolve(dirname(file), decodeURIComponent(target));
    if (!existsSync(resolved)) {
      failures.push(`${file}: relative link target missing on disk: ${raw}`);
    } else {
      // Touch the stat so dangling symlinks fail loudly instead of passing.
      try {
        statSync(resolved);
      } catch {
        failures.push(`${file}: relative link target is a dangling entry: ${raw}`);
      }
    }
  }
}

// --- 2. External probes ----------------------------------------------------

if (SKIP_EXTERNAL) {
  notes.push(`external probing skipped (--skip-external), ${externals.size} external URL(s) not checked`);
} else {
  // Decide the own-npm-page posture once, against the registry.
  let published = false;
  try {
    const registry = await probe(OWN_REGISTRY_URL);
    published = registry.ok;
  } catch {
    published = false; // unreachable registry: stay in the pre-publish posture
  }

  for (const [url, containing] of externals) {
    const where = containing[0];
    if (isOwnNpmPage(url) && !published) {
      notes.push(`${url}: own npm page skipped pre-publish (registry has no @takk/racs yet)`);
      continue;
    }
    let host = '';
    try {
      host = new URL(url).hostname;
    } catch {
      failures.push(`${where}: unparseable URL: ${url}`);
      continue;
    }
    try {
      const response = await probe(url);
      if (response.ok) {
        continue;
      }
      if (BOT_GATED_HOSTS.has(host) && BOT_GATED_STATUSES.has(response.status)) {
        notes.push(`${url}: ${response.status} from bot-gated host, treated as reachable`);
        continue;
      }
      failures.push(`${where}: ${url} answered HTTP ${response.status}`);
    } catch (error) {
      if (host === CANONICAL_HOST && isDnsMiss(error)) {
        warnings.push(
          `${url}: DNS does not resolve yet, pending-by-design (family-wide DNS provisioning). ` +
            `This check re-arms automatically once the record exists.`,
        );
        continue;
      }
      const reason = error?.cause?.code ?? error?.name ?? 'unknown error';
      failures.push(`${where}: ${url} unreachable (${reason})`);
    }
  }
}

// --- 3. Report -------------------------------------------------------------

for (const note of notes) {
  console.log(`note: ${note}`);
}
for (const warning of warnings) {
  console.warn(`warning: ${warning}`);
}
for (const failure of failures) {
  console.error(`FAIL: ${failure}`);
}
console.log(
  `check-links: ${files.length} markdown file(s), ${externals.size} external URL(s), ` +
    `${failures.length} failure(s), ${warnings.length} warning(s)`,
);
process.exit(failures.length > 0 ? 1 : 0);
