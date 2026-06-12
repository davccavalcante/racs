# Privacy Notice

This notice describes what data `@takk/racs` processes when you install and run it. RACS (Remote Agent Context Store) is an npm library and CLI that runs entirely inside your own process and infrastructure. The author, David C Cavalcante (Takk Innovate Studio), hosts no service, sees no traffic, and collects no telemetry.

Last updated: 2026-06-11.

---

## 1. What RACS is, and is not

RACS is self-hosted by construction. There is no RACS cloud, no account, no sign-up, and no endpoint the package talks to. The product invariant goes further than most libraries: RACS never makes any network call at all, not to the author and not to any provider. It plans cache directives; your application makes its own calls with its own credentials.

## 2. Zero telemetry

The telemetry surface (`racs.on(listener)`) is an in-process event emitter you subscribe to yourself. Nothing leaves your process unless you wire it to leave. No usage statistics, no error reporting, no fingerprinting, no third-party SDK that phones home, the package has zero runtime dependencies, verifiable with `npm ls --all`.

## 3. Hash-only mode: content is never required

Every prompt segment accepts `contentHash` in place of `content`. When you pass only a hash (any stable digest you compute, sha-256 hex is conventional) plus a token count, RACS never sees and never stores the text. Plans, lint findings, drift reports, persisted snapshots, and telemetry then carry hashes and token counts only.

When you do pass `content`, it is used in memory for two things: deriving the segment hash and running the content-shape lints (`timestamp-in-stable`, `identifier-in-stable`). Lint messages reference matches by a short digest, never by the matched substring, so findings can be logged and persisted without leaking prompt text. Segment content is never persisted and never emitted in any telemetry event.

## 4. What the /otel entry reads

`usageFromSpan` reads exactly: the `gen_ai.system` attribute (provider identity), the request and response model attributes, the token usage counters (input, cached read, cache write), and the span end timestamp. It never reads `gen_ai.prompt`, `gen_ai.completion`, event bodies, or any other content-bearing attribute. Wiring it into a span pipeline leaks nothing beyond counts.

## 5. What persistence stores

State snapshots (memory, file, or KV backend) contain: ledger aggregates (token counts per prefix key), drift fingerprints (segment ids, content hashes, declared stabilities), keep-warm schedule entries, and the resource registry (resource keys and TTLs). Hashes and aggregates, never text. A snapshot is safe to store in a shared Redis or KV namespace from a confidentiality standpoint; it does reveal operational metadata (how often which prefix was used), so treat it according to your own threat model.

With the KV backend, RACS receives a ready client object from you and never sees connection credentials.

## 6. Upstream provider traffic

RACS produces none. Your application calls its providers directly; those flows are governed by each provider's own data-handling policy and your agreements with them. RACS only ever sees the token counters you choose to report back.

## 7. GDPR and LGPD posture

RACS processes prompt structure metadata and token counters, not end-user personal data. If your prompts contain personal data, that data stays in your application; in hash-only mode it never even transits RACS, and in content mode it is processed transiently in memory and never persisted.

For operators in scope of GDPR or LGPD:

- **Minimization**: only hashes, counts, and timestamps are ever persisted, and only when you configure a state backend.
- **Right to erasure**: delete the snapshot (the state file, or the KV key, default `racs:state`) to remove all persisted RACS state; `racs.invalidate()` clears live bookkeeping.
- **Portability**: snapshots are plain JSON, versioned (`version: 1`), and portable by construction.

## 8. Children

RACS is developer infrastructure with no user-facing surface and no features directed at children. It is not intended for direct use by children under 13.

## 9. Changes to this notice

This file is versioned in git alongside the code. Material changes are announced in [CHANGELOG.md](./CHANGELOG.md) and in the release notes on GitHub.

## 10. Contact

- General (author): **davcavalcante@proton.me**
- Takk relay: **say@takk.ag**
- Security: **davcavalcante@proton.me** with the `[SECURITY]` prefix, see [SECURITY.md](./SECURITY.md)
- Project site: <https://racs.takk.ag/>
