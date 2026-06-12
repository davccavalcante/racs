# Hermes Agent bridge recipe

RACS (Remote Agent Context Store) ships a `hermes` provider profile because Hermes Agent rides Anthropic `cache_control` semantics with a fixed system_and_3 cache layout, the system prompt plus the last 3 messages. That layout leaves stable tool definitions and document context uncovered, and the Hermes ecosystem has multiple open issues asking for exactly the capabilities below. This recipe wires a Hermes deployment to a RACS sidecar over `racs serve`: plan before the provider call, report usage after it, all without touching the agent's transport.

## 1. Start the sidecar

```bash
export RACS_TOKEN="$(openssl rand -hex 24)"
racs serve --port 4378 --token "$RACS_TOKEN" --state .racs/state.json
```

The bridge binds 127.0.0.1 by default, requires the bearer on everything but `/healthz`, rejects non-JSON bodies (415) and bodies over 1 MB (413), and flushes state on SIGINT and SIGTERM. Keep it loopback; if you must cross hosts, front it with your own TLS and keep `--token` set.

## 2. Plan before the call

A pre-call shell hook builds the `PlanInput` from the parts Hermes already knows (the system prompt, the tool definitions, the rolling history, the live turn) and asks the sidecar where the cache markers belong:

```bash
#!/usr/bin/env bash
# hooks/pre-call.sh: ask RACS for the cache plan of the upcoming call.
set -euo pipefail

PLAN=$(curl -sf -X POST http://127.0.0.1:4378/plan \
  -H "authorization: Bearer $RACS_TOKEN" \
  -H "content-type: application/json" \
  -d @- <<JSON
{
  "agentId": "hermes-main",
  "provider": "hermes",
  "model": "$HERMES_MODEL",
  "segments": [
    { "id": "system", "role": "system", "stability": "stable",
      "contentHash": "$(sha256sum < "$HERMES_SYSTEM_FILE" | cut -d' ' -f1)",
      "tokens": $SYSTEM_TOKENS },
    { "id": "tools", "role": "tools", "stability": "stable",
      "contentHash": "$(sha256sum < "$HERMES_TOOLS_FILE" | cut -d' ' -f1)",
      "tokens": $TOOLS_TOKENS },
    { "id": "history", "role": "history", "stability": "semi",
      "contentHash": "$HISTORY_HASH", "tokens": $HISTORY_TOKENS },
    { "id": "turn", "role": "dynamic", "stability": "volatile",
      "contentHash": "$TURN_HASH", "tokens": $TURN_TOKENS }
  ],
  "reuse": { "intervalSeconds": 45 }
}
JSON
)

echo "$PLAN" | jq -r '.prefixKey' > /tmp/racs-prefix-key
echo "$PLAN" | jq -c '.directives'
echo "$PLAN" | jq -r '.findings[] | "\(.severity) \(.code): \(.message)"' >&2
```

Hashing instead of content is deliberate: the sidecar plans, lints structure, detects drift, and accounts savings without ever seeing prompt text (hash-only mode). The directives come back as `breakpoint` entries naming segment ids and a TTL tier; apply them as `cache_control` markers on the corresponding blocks of the request Hermes is about to send.

## 3. Report usage after the call

A post-call hook forwards the counters the provider response already carries:

```bash
#!/usr/bin/env bash
# hooks/post-call.sh: report the usage counters back to RACS.
set -euo pipefail

curl -sf -X POST http://127.0.0.1:4378/usage \
  -H "authorization: Bearer $RACS_TOKEN" \
  -H "content-type: application/json" \
  -d @- <<JSON
{
  "provider": "hermes",
  "model": "$HERMES_MODEL",
  "prefixKey": "$(cat /tmp/racs-prefix-key)",
  "inputTokens": $USAGE_INPUT_TOKENS,
  "cacheReadTokens": $USAGE_CACHE_READ_TOKENS,
  "cacheWriteTokens5m": $USAGE_CACHE_WRITE_TOKENS
}
JSON
```

From there, the analytics are one curl away:

```bash
curl -s http://127.0.0.1:4378/stats -H "authorization: Bearer $RACS_TOKEN" | jq '{hitRatio, savedUsd, netUsd}'
curl -s http://127.0.0.1:4378/schedule -H "authorization: Bearer $RACS_TOKEN"   # keep-warm touches due now
```

When a refresh entry comes due, run any cheap call sharing the prefix, then `POST /refreshed` with the prefix key. On credential rotation, `POST /invalidate` with `{"provider": "hermes"}` clears the bookkeeping so the next plan rebuilds from scratch.

## 4. config.yaml notes

Wire the hooks where your Hermes deployment exposes lifecycle commands, and keep the sidecar settings next to them:

```yaml
# config.yaml (excerpt)
hooks:
  pre_call: hooks/pre-call.sh     # plan + lint gate before the provider call
  post_call: hooks/post-call.sh   # usage report after the response

racs:
  endpoint: http://127.0.0.1:4378
  token_env: RACS_TOKEN
  state: .racs/state.json          # survives sidecar restarts
```

If your build has no hook surface, tail the session log and replay usage records into `/usage`; the ledger accepts historical timestamps.

## 5. Honest limits of an out-of-process bridge

- **The bridge plans; Hermes must apply.** If the agent's request builder cannot place `cache_control` markers per segment, the plan degrades to whatever placement the host honors. The lint findings and drift reports remain fully accurate either way; they depend only on the declared segments.
- **Token counts are yours to supply.** Over HTTP with hashes, RACS cannot estimate from content, so segments without `tokens` count as zero in break-even math. Pass real counts (the provider's usage from prior calls is a fine source).
- **One engine, one process.** The sidecar learns per process; its state file makes that durable, not distributed. Run one sidecar per agent host rather than one shared sidecar per fleet, or aggregate usage centrally before reporting.
- **Latency is real but small.** A loopback plan round trip is sub-millisecond engine work plus HTTP overhead; budget for it in tight loops, or batch lint checks into CI with `racs analyze` instead of planning every call.
- **The trust boundary is the operator's.** Anything holding the bearer token can record usage and skew analytics (never directives). Treat the token like any other operational secret.
