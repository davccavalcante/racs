# Contributing to @takk/racs

Thanks for considering a contribution. This document is the canonical guide for proposing changes to `@takk/racs`, RACS (Remote Agent Context Store).

The project is open source under [Apache License 2.0](../LICENSE). The package surface and stability promise are documented in [SPEC.md](../SPEC.md).

---

## 1. Code of conduct

Be respectful, be precise, and assume good faith. The maintainer reads every issue and PR personally; disrespectful, harmful, or manipulative behavior is grounds for removal from the project. The full policy is in [CODE_OF_CONDUCT.md](../CODE_OF_CONDUCT.md).

---

## 2. Contributor license

Every contribution is governed by the Apache License 2.0 (the same license the project is published under) and by [CLA.md](../CLA.md). Sign off every commit with `git commit -s` (Developer Certificate of Origin):

```bash
git commit -s -m "fix(planner): clamp resource ttl to the documented bounds"
```

The `-s` flag appends a `Signed-off-by:` trailer that attests you have the right to submit the change under Apache 2.0. PRs without DCO sign-off are not merged.

---

## 3. Local setup

### 3.1 Prerequisites

- **Node 22 or 24.** CI runs both; pick one for local dev. `.nvmrc` pins the line.
- **pnpm 10.** The repo uses `pnpm` for install and scripts; `pnpm-lock.yaml` is the source of truth and CI installs with `--frozen-lockfile`.
- **git** with `git commit -s` configured (DCO).

### 3.2 Clone and install

```bash
git clone https://github.com/davccavalcante/racs.git
cd racs
pnpm install
```

### 3.3 Verify locally

```bash
pnpm verify          # lint + typecheck + test + build + smoke + publint
# or run individually:
pnpm lint
pnpm typecheck
pnpm test
pnpm test:coverage
pnpm build
pnpm publint
node scripts/check-links.mjs --skip-external   # doc link gate, relative targets only
```

Current baseline (verify before opening a PR): **187 tests passing across 13 suites**. Coverage: statements 92.46 percent, branches 82.09, functions 93.33, lines 92.49. The planning benchmark (P1-P10 in `tests/integration/planning-benchmark.test.ts`) is a permanent quality contract; a regression on any of its bounds must fail, never be re-calibrated to pass.

---

## 4. Branch and commit conventions

### 4.1 Branch names

- `fix/<short-slug>` for bug fixes
- `feat/<short-slug>` for new optional surface (minor bump)
- `docs/<short-slug>` for README/SPEC/CHANGELOG-only changes
- `chore/<short-slug>` for tooling, deps, CI
- `refactor/<short-slug>` for internal restructuring with no API change

Avoid PRs larger than ~500 LOC; split into smaller logically coherent PRs.

### 4.2 Commit style

[Conventional Commits](https://www.conventionalcommits.org/) are encouraged but not enforced. What IS enforced:

- **One commit per logical change.** No `WIP` or `fixup` commits in the merged history.
- **Imperative subject up to 70 chars.** Body wrap at 72 cols.
- **DCO sign-off (`git commit -s`).**
- **No commit credits to assistants.** This is the Creator's discipline.

### 4.3 What requires a discussion before coding

Open a GitHub Issue first if your change touches:

- A new public export on any entry point (SemVer minor/major impact, see [SPEC.md section 11](../SPEC.md#11-semver-policy)).
- The `ProviderId`, `LintCode`, or `TelemetryEvent` unions, or a new `CacheDirective` kind.
- The meaning of an existing lint code or directive kind (always major).
- The `StateSnapshot` schema or any state backend interface.
- The shipped provider profile numbers (cite the provider documentation and retrieval date in JSDoc, as every existing entry does).
- The CLI flags, exit codes, or serve endpoints (the `racs 1.0.0` help first line is a tested CI contract).
- Anything that would add a runtime dependency. The answer is almost certainly no; the zero-dependency invariant is load-bearing for the security posture.

For docs-only fixes, typos, or contained internal refactors, skip the issue and open a PR directly.

---

## 5. Pull request workflow

### 5.1 Before opening

- All checks green: `pnpm verify`.
- Coverage thresholds preserved or improved (see `vitest.config.ts`).
- For any change that touches the public API: `SPEC.md` and `README.md` updated.
- For prose changes: `node scripts/check-links.mjs --skip-external` passes.
- For any deprecated surface: `@deprecated` JSDoc plus a `### Deprecated` section in the next `CHANGELOG.md` entry.

### 5.2 PR description

Fill the [PULL_REQUEST_TEMPLATE.md](./PULL_REQUEST_TEMPLATE.md) honestly. Empty sections are not acceptable; write "N/A" with a one-line reason if a section truly does not apply.

### 5.3 Review

The maintainer reviews every PR personally. Expect:

- A surgical line-by-line read.
- Questions on intent before merge (the Creator's discipline: if you notice any problem, error, or inconsistency, ask before acting).
- Required for governance-touching changes: explicit Creator approval before merge.

### 5.4 After merge

CI publishes nothing on merge to `main`. Publishing is a Creator-triggered, two-step flow (GitHub Release first, npm second), documented in [RELEASING.md](./RELEASING.md).

---

## 6. Tests

Add tests for any non-trivial change. Patterns:

- **Vitest** (`tests/**/*.test.ts`), unit suites per component, integration suites per entry point.
- **Determinism is mandatory.** Inject the clock (`options.clock`), fix the seed, and never read the wall clock or the global random generator in a test path. The engine itself never does.
- **CLI tests spawn the real Node binary with the tsx loader**, never the tsx wrapper binary, for exit-code fidelity (see the note in `tests/integration/planning-benchmark.test.ts`).
- **No provider credentials, no network.** The product never calls a provider, and neither does any test.

Every fixable bug ships with a regression test that fails pre-fix and passes post-fix.

---

## 7. Security disclosure

Do NOT open a public GitHub Issue for security vulnerabilities. Email `davcavalcante@proton.me` with the prefix `[SECURITY]` (or `say@takk.ag`), and we will coordinate the fix and disclosure timeline privately. See [SECURITY.md](../SECURITY.md).

---

## 8. Releasing

Releases are maintainer-only. The full runbook lives in [RELEASING.md](./RELEASING.md). Contributors do not tag, do not publish, and do not edit historical CHANGELOG entries (those are immutable per Keep a Changelog).

When proposing a change that warrants a release, indicate in your PR description which SemVer bump you believe it triggers (patch / minor / major per [SPEC.md section 11](../SPEC.md#11-semver-policy)). The maintainer makes the final call.

---

## 9. Communication

- **GitHub Issues** for bug reports and feature requests (see [ISSUE_TEMPLATE/](./ISSUE_TEMPLATE)).
- **GitHub Discussions** (if enabled) for design conversations.
- **Email** `davcavalcante@proton.me` for anything private, sensitive, or trademark- or license-related.

The project's primary language for code, docs, CI, issues, and PRs is **English**.

---

## Contact

**David C Cavalcante**
- Email: [davcavalcante@proton.me](mailto:davcavalcante@proton.me)
- LinkedIn: [linkedin.com/in/hellodav](https://linkedin.com/in/hellodav)
- GitHub: [github.com/davccavalcante](https://github.com/davccavalcante)
- X: [x.com/davccavalcante](https://x.com/davccavalcante)
- Project site: [takk.ag](https://takk.ag)
