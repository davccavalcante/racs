# Security Policy

`@takk/racs` is a stable (1.0.0) library and CLI for provider-faithful prefix-cache planning and analytics. We take security reports seriously and aim to acknowledge each one within two business days.

## Supported versions

Each published version follows strict SemVer (see [SPEC.md](./SPEC.md) section 11 and [.github/RELEASING.md](./.github/RELEASING.md)). Only the latest minor of the current major receives security patches; an older major receives critical-CVE fixes for 6 months after the next major lands.

| Package | Supported |
|---|---|
| `@takk/racs` | current `latest` dist-tag |

## Reporting a vulnerability

**Do not file public GitHub issues for security problems.** Send reports to **davcavalcante@proton.me** (preferred) or **say@takk.ag** (Takk relay), with the subject line beginning `[SECURITY]`.

Include, at minimum:

- Affected version (`npm ls @takk/racs`).
- Reproduction steps or a minimal proof of concept.
- Impact assessment (what an attacker can achieve).
- Any suggested mitigation.

PGP or signed reports are welcome but not required. If you need an out-of-band channel, ask in the first message and we will propose one.

## Response process

1. Acknowledgement within **2 business days**.
2. Triage and severity assignment within **7 days**.
3. Fix targeted for the next release; critical issues ship as an out-of-band patch on the affected minor.
4. Coordinated disclosure: the reporter is credited in the changelog and advisory unless they request anonymity.

## Threat model: in scope

- **Credential handling: there is none, and any appearance of it is a bug.** RACS never handles API keys, by product invariant. The `KvLike` and bridge interfaces receive ready client objects; any path that causes a connection string, token, or key to be read, stored, logged, or persisted by this package is in scope and treated as a vulnerability.
- **Prompt content leakage.** Segment content must never reach a persisted snapshot, a telemetry event, a lint message (matches are referenced by digest only), or the `/otel` ingestion path (which must never read content attributes). Any counterexample is in scope.
- **The serve bridge.** `racs serve` binds loopback by default and refuses non-loopback hosts without a token; the bearer comparison is constant-time over SHA-256 digests; POST bodies are gated by content type (415) and a 1 MB cap (413); CORS headers are emitted only when both `--token` and `--cors-origin` are configured. Tokenless instances additionally validate the Host header as the DNS-rebinding defense: any request whose hostname (port stripped, IPv6 brackets tolerated) is not loopback (`localhost`, `127.0.0.1`, `::1`) is answered 403 `forbidden host`, and `/healthz` is host-checked too, consistency over the nothing-leaked argument; with a token configured the bearer is the gate and the Host header is not consulted. Any bypass of these gates (auth bypass, timing oracle on the token, body-cap evasion, Host-validation bypass in tokenless mode, CORS leak without the double opt-in) is in scope.
- **State snapshot handling.** Snapshots are validated by version (`version: 1`, rejected otherwise with `ERR_STATE_VERSION`) and restored defensively section by section. A crafted snapshot that crashes the engine, escapes the defensive restore, or smuggles content into memory it should not reach is in scope. Path traversal in the file backend write path likewise.
- **Forged usage, as a documented boundary.** `record()` and the authenticated `/usage` endpoint trust the operator: fabricated `CacheUsage` skews hit ratios and USD analytics. By design this can never alter directives, plans, or schedules, only the analytics. A forged usage record that influences planning output would cross the documented boundary and is in scope as a vulnerability; skewed analytics from a trusted-but-lying feeder is not, that is the operator trust boundary.
- **Misuse-resistance of cache keys.** FNV-1a 64 prefix keys are non-cryptographic, predictable, and collision-constructible, and the package must never use them for authentication, authorization, or integrity decisions. Any internal code path that does is in scope.
- **Supply chain.** Tarball contamination, compromised npm scope, or a published artifact whose provenance attestation does not match the source commit.

## Out of scope

- The security of upstream provider APIs and the accuracy of the usage counters they report.
- Custody of your prompts, pricing tables, and provider credentials before anything reaches RACS; that is the operator's responsibility (RACS never receives the credentials at all).
- Analytics skew caused by an operator feeding the engine false usage within their own trust domain (see the documented boundary above).
- Theoretical attacks against FNV-1a as a hash; it is declared non-cryptographic and is never used for security decisions. Report a violation of that rule, not the hash.
- Denial of service through unbounded inputs to your own embedding application; the serve bridge's own caps are in scope, your application's are yours.

## Supply-chain assurances

- **Zero runtime dependencies.** The transitive attack surface of the published package is the package itself. Sibling bridges are structural; the optional peers are never imported at runtime.
- **Provenance.** Every release is published with `npm publish --provenance` (SLSA attestation from GitHub Actions). Verify with `npm view @takk/racs@<version> --json | jq .dist.attestations`.
- **Files allowlist.** `package.json#files` enumerates exactly what ships (`dist`, `README.md`, `LICENSE`, `NOTICE`, `CHANGELOG.md`, `SECURITY.md`); nothing else can leak into the tarball. The published artifact carries 46 files.
- **Frozen lockfile.** `pnpm-lock.yaml` is committed, and CI installs with `--frozen-lockfile`, so builds are reproducible and dependency swaps cannot ride a CI run.
- **Two-step release.** A reviewable GitHub Release precedes every npm publish (see [.github/RELEASING.md](./.github/RELEASING.md)).
