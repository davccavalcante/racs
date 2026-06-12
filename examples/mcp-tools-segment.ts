/**
 * mcp-tools-segment.ts: caching MCP tool descriptions with RACS (Remote Agent
 * Context Store).
 *
 * An MCP server's tools/list response is the ideal prefix-cache segment: tool
 * schemas and descriptions routinely run thousands of tokens, the list is
 * byte-stable between calls, and the agent replays it on every request. This
 * example is structural on purpose, no MCP SDK is imported: the literal below
 * is the JSON shape a tools/list call answers, and any real client response
 * slots into the same segment the same way.
 *
 * Run from the repository root:
 *   node --import tsx examples/mcp-tools-segment.ts
 */

import { createRACS, type PromptSegment } from '@takk/racs';

// The literal shape of an MCP tools/list response. Real servers answer exactly
// this structure; swap in `await client.listTools()` and nothing else changes.
const TOOL_LIST = {
  tools: [
    {
      name: 'lookup_ticket',
      description:
        'Fetch a support ticket by id, including its full comment thread, current assignee, severity, and the device serial it was filed against.',
      inputSchema: {
        type: 'object',
        properties: {
          ticketId: { type: 'string', description: 'Ticket identifier, for example TCK-4711.' },
        },
        required: ['ticketId'],
      },
    },
    {
      name: 'query_telemetry',
      description:
        'Read the rolling telemetry window for one sensor: temperature, vibration, duty cycle, and the most recent fault codes in arrival order.',
      inputSchema: {
        type: 'object',
        properties: {
          sensorId: { type: 'string', description: 'Sensor serial number.' },
          window: { type: 'string', description: 'Lookback window, one of 1h, 24h, 7d.' },
        },
        required: ['sensorId'],
      },
    },
    {
      name: 'escalate',
      description:
        'Escalate a fault to the hardware on-call rotation with a structured summary; returns the page id and the acknowledging engineer.',
      inputSchema: {
        type: 'object',
        properties: {
          ticketId: { type: 'string', description: 'Ticket to escalate.' },
          summary: { type: 'string', description: 'One-paragraph fault summary.' },
        },
        required: ['ticketId', 'summary'],
      },
    },
    {
      name: 'schedule_maintenance',
      description:
        'Book a maintenance slot for a device, checking the site calendar and the spare-part inventory before confirming the window.',
      inputSchema: {
        type: 'object',
        properties: {
          deviceId: { type: 'string', description: 'Device serial number.' },
          window: { type: 'string', description: 'Preferred service window.' },
        },
        required: ['deviceId'],
      },
    },
  ],
};

// One MCP server rarely travels alone: a production agent merges the catalogs
// of several namespaced servers into one tool list, which is what pushes the
// serialized segment well past the 1024-token cacheable minimum.
const NAMESPACES = ['tickets', 'telemetry', 'firmware', 'billing'] as const;
const mergedTools = NAMESPACES.flatMap((namespace) =>
  TOOL_LIST.tools.map((tool) => ({ ...tool, name: `${namespace}_${tool.name}` })),
);

// Keep the serialization deterministic: JSON.stringify preserves insertion
// order, so build the catalog the same way on every call. A reordered key or a
// timestamp in a description would change the bytes, and the 'unstable-tools'
// lint exists to name exactly that bug.
const toolsJson = JSON.stringify(mergedTools);

const toolsSegment = {
  id: 'mcp-tools',
  role: 'tools',
  stability: 'stable',
  content: toolsJson,
} satisfies PromptSegment;

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

// The 'tools' role carries the highest breakpoint placement weight, so the
// marker lands exactly where the provider hashes first.
const plan = racs.plan({
  agentId: 'mcp-agent',
  provider: 'anthropic',
  model: 'claude-sonnet-4-5',
  segments: [
    toolsSegment,
    { id: 'turn', role: 'dynamic', stability: 'volatile', content: 'Sensor 41 reports NaN.' },
  ],
  reuse: { intervalSeconds: 60 },
});

console.log('tools      :', mergedTools.length, 'tools across', NAMESPACES.length, 'namespaces');
console.log('segment    :', toolsJson.length, 'chars,', plan.stableTokens, 'estimated tokens');
console.log('directives :', JSON.stringify(plan.directives));
if (plan.breakEven !== undefined) {
  console.log('break-even :', plan.breakEven.reasoning);
}

// Report the counters your own provider calls return. inputTokens is the
// all-in billed input (fresh input + cached reads + cache writes); the otel
// and vercel adapters normalize raw exclusive provider counts automatically.
racs.record({
  provider: 'anthropic',
  model: 'claude-sonnet-4-5',
  prefixKey: plan.prefixKey,
  inputTokens: plan.totalTokens,
  cacheReadTokens: 0,
  cacheWriteTokens5m: plan.stableTokens,
});
for (let call = 0; call < 4; call += 1) {
  racs.record({
    provider: 'anthropic',
    model: 'claude-sonnet-4-5',
    prefixKey: plan.prefixKey,
    inputTokens: plan.totalTokens,
    cacheReadTokens: plan.stableTokens,
  });
}

const stats = racs.stats();
console.log('calls      :', stats.calls);
console.log('hit ratio  :', stats.hitRatio.toFixed(3));
console.log('net USD    :', stats.netUsd?.toFixed(6), '(savings minus the single write premium)');

await racs.close();
