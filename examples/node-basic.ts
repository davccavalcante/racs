/**
 * node-basic.ts: the core RACS (Remote Agent Context Store) loop in one file,
 * plan, lint, record, stats, with user-supplied pricing.
 *
 * RACS never calls a provider API. This example fakes the provider side with
 * plain numbers, exactly the counters a real Anthropic response carries in
 * `usage.cache_read_input_tokens` and `usage.cache_creation_input_tokens`.
 *
 * Run from the repository root:
 *   node --import tsx examples/node-basic.ts
 */

import { createRACS } from '@takk/racs';

// Pricing is ALWAYS user-supplied; RACS hardcodes no prices because providers
// change terms without notice. Without this table you still get every
// token-denominated statistic, just no USD figures.
const racs = createRACS({
  seed: 7,
  pricing: {
    'claude-sonnet-4-5': {
      inputPerMTok: 3,
      cacheReadPerMTok: 0.3,
      cacheWrite5mPerMTok: 3.75,
      cacheWrite1hPerMTok: 6,
    },
  },
});

const SYSTEM_PROMPT = [
  'You are the support agent for an industrial sensor fleet.',
  'Answer from the runbook excerpts provided, escalate hardware faults,',
  'and never speculate about firmware versions you have not seen.',
]
  .join(' ')
  .repeat(60); // long enough to clear the 1024-token provider minimum

const TOOLS_JSON = JSON.stringify([
  { name: 'lookup_ticket', description: 'Fetch a support ticket by id.' },
  { name: 'escalate', description: 'Escalate to the hardware on-call rotation.' },
]).repeat(20);

// 1. Plan: where do the cache markers go, and is caching worth it?
const plan = racs.plan({
  agentId: 'support-agent',
  provider: 'anthropic',
  model: 'claude-sonnet-4-5',
  segments: [
    { id: 'system', role: 'system', stability: 'stable', content: SYSTEM_PROMPT },
    { id: 'tools', role: 'tools', stability: 'stable', content: TOOLS_JSON },
    { id: 'turn', role: 'dynamic', stability: 'volatile', content: 'Sensor 41 reports NaN.' },
  ],
  reuse: { intervalSeconds: 60 },
});

console.log('prefixKey :', plan.prefixKey);
console.log('directives:', JSON.stringify(plan.directives, null, 2));
console.log('reasoning :', plan.reasoning);
if (plan.breakEven !== undefined) {
  console.log('break-even:', plan.breakEven.reasoning);
}

// 2. Lint as a gate: an error-severity finding means the prompt as declared
// cannot achieve cache hits. This prompt is clean; a timestamp in the system
// segment would change that.
const findings = racs.lint({
  provider: 'anthropic',
  model: 'claude-sonnet-4-5',
  segments: [
    { id: 'system', role: 'system', stability: 'stable', content: SYSTEM_PROMPT },
    { id: 'turn', role: 'dynamic', stability: 'volatile', content: 'Sensor 41 reports NaN.' },
  ],
});
console.log('lint findings:', findings.length === 0 ? 'clean' : findings);

// 3. Record: report the usage counters your own provider call returned.
// First call writes the cache (the 5m write premium) ...
racs.record({
  provider: 'anthropic',
  model: 'claude-sonnet-4-5',
  prefixKey: plan.prefixKey,
  inputTokens: plan.totalTokens,
  cacheReadTokens: 0,
  cacheWriteTokens5m: plan.stableTokens,
});
// ... and the following calls read it back at a tenth of the input price.
for (let call = 0; call < 9; call += 1) {
  racs.record({
    provider: 'anthropic',
    model: 'claude-sonnet-4-5',
    prefixKey: plan.prefixKey,
    inputTokens: plan.totalTokens,
    cacheReadTokens: plan.stableTokens,
  });
}

// 4. Stats: the normalized hit ratio and the USD effect of caching.
const stats = racs.stats();
console.log('calls     :', stats.calls);
console.log('hit ratio :', stats.hitRatio.toFixed(3));
console.log('saved USD :', stats.savedUsd?.toFixed(6));
console.log('net USD   :', stats.netUsd?.toFixed(6), '(savings minus write premiums)');

// 5. Keep-warm: when is a refresh touch due? (90 percent of the TTL window)
const due = racs.schedule(Date.now() + 5 * 60 * 1000);
console.log('refresh due in 5 minutes:', due.length, 'prefix(es)');

await racs.close();
