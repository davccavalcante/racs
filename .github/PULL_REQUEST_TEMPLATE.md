<!--
Thank you for the PR. Please fill EVERY section honestly. Empty sections are
not acceptable; write "N/A" with a one-line reason if a section truly does
not apply. The maintainer reads every PR line-by-line; complete context is
faster for everyone than back-and-forth questions.

Read .github/CONTRIBUTING.md before opening this PR if you haven't yet.
-->

## Summary

<!-- One paragraph: what does this PR do and why? Avoid restating the diff;
state the intent. -->

## Affected surface

<!-- Tick every surface touched. -->

- [ ] core engine (`src/core/*`, `src/types.ts`, `src/errors.ts`)
- [ ] analyzer / lints (`src/plan/PrefixAnalyzer.ts`)
- [ ] planner / directives (`src/plan/Planner.ts`)
- [ ] provider profiles (`src/providers/*`)
- [ ] ledger / analytics (`src/ledger/*`, `src/stats/*`)
- [ ] drift / schedule (`src/drift/*`, `src/schedule/*`)
- [ ] state backends (`src/state/*`)
- [ ] otel entry (`src/otel/*`)
- [ ] vercel entry (`src/vercel/*`)
- [ ] integrations entry (`src/integrations/*`)
- [ ] web / edge entries (`src/web/*`, `src/edge/*`)
- [ ] CLI (`src/cli/*`)
- [ ] tests (`tests/*`)
- [ ] examples (`examples/*`)
- [ ] CI / workflows / scripts (`.github/*`, `scripts/*`)
- [ ] docs (README / SPEC / CHANGELOG / PRIVACY / SECURITY)
- [ ] package metadata (`package.json`, configs)

## What changed

<!-- Summarize the change in 1-5 bullets. Include the key file paths and
one-line rationale per bullet. -->

- `<file>`: <change + rationale>

## SemVer impact

<!-- Per SPEC.md section 11. Tick the highest applicable level. -->

- [ ] No published impact (docs-only / internal refactor / CI-only)
- [ ] Patch: bug fix, internal refactor, profile-number correction
- [ ] Minor: new optional export, new optional field, new union member (`ProviderId` / `LintCode` / `TelemetryEvent`), new CLI flag with preserving default
- [ ] Major: renaming/removing an export, signature change, snapshot schema change, lint/directive meaning change, CLI flag or exit-code change

If Major: explain the migration path below.

## Gate checklist

<!-- Run locally and tick. Every box must be ticked or explained. -->

- [ ] `pnpm verify` passes (lint + typecheck + test + build + smoke + publint).
- [ ] Test baseline holds: 187 / 187 passing across 13 suites before this PR; report the after-count below.
- [ ] The planning benchmark P1-P10 passes untouched (bounds are a permanent contract; never re-calibrate one to pass).
- [ ] Coverage thresholds preserved or improved (baseline: 92.46 statements / 82.09 branches / 93.33 functions / 92.49 lines).
- [ ] `node scripts/check-links.mjs --skip-external` exits 0 (for any prose change).
- [ ] No runtime dependency added; no provider SDK imported; no network call introduced anywhere in `src/`.
- [ ] No prompt content reaches snapshots, telemetry, or lint messages (privacy contract, PRIVACY.md).

### Test counts

- Before this PR: 187 / 187 passing (baseline at 1.0.0)
- After this PR: <X> / <Y> passing

### New tests

<!-- For any fixable bug or new optional surface, list the regression test(s)
added. Tests must fail pre-fix and pass post-fix (CONTRIBUTING section 6). -->

- `tests/<path>/<file>.test.ts`, `<test name>`: <what it asserts>

## Documentation

<!-- Tick every doc updated. -->

- [ ] `README.md`
- [ ] `SPEC.md` (if public surface changed)
- [ ] `CHANGELOG.md` (new section; DO NOT edit historical entries)
- [ ] `.github/CONTRIBUTING.md` or `.github/RELEASING.md` (if process changed)
- [ ] N/A: docs-only PR / internal refactor / no public surface change

## License + contributor agreement

- [ ] DCO sign-off on every commit (`git commit -s`), per [CLA.md](../CLA.md).
- [ ] No commit credits to assistants.
- [ ] `[CLA-signed]` title prefix if this PR falls under CLA.md section 2.

## Anything else

<!-- Design rationale, follow-up PR plans, anything the maintainer should know. -->
