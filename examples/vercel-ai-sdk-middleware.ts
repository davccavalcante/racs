/**
 * vercel-ai-sdk-middleware.ts: the packaged Vercel AI SDK middleware,
 * exercised structurally so this example runs WITHOUT the `ai` package
 * installed. The middleware object is structurally compatible with
 * `LanguageModelV3Middleware`, which is all `wrapLanguageModel` requires.
 *
 * In a real host, the wiring is exactly this (uncomment with `ai` and
 * `@ai-sdk/anthropic` installed):
 *
 *   import { anthropic } from '@ai-sdk/anthropic';
 *   import { wrapLanguageModel } from 'ai';
 *   const model = wrapLanguageModel({
 *     model: anthropic('claude-sonnet-4-5'),
 *     middleware,
 *   });
 *   // then use `model` with generateText / streamText as usual.
 *
 * Run from the repository root:
 *   node --import tsx examples/vercel-ai-sdk-middleware.ts
 */

import { createRACS } from '@takk/racs';
import { racsMiddleware, type CallOptionsLike, type GenerateResultLike } from '@takk/racs/vercel';

const racs = createRACS({
  seed: 7,
  pricing: {
    'claude-sonnet-4-5': {
      inputPerMTok: 3,
      cacheReadPerMTok: 0.3,
      cacheWrite5mPerMTok: 3.75,
    },
  },
});

const middleware = racsMiddleware(racs, {
  provider: 'anthropic',
  model: 'claude-sonnet-4-5',
});

// The params shape the Vercel AI SDK hands to transformParams. The default
// segmenter maps: system -> stable, tools -> stable, prior messages -> semi
// history, final message -> volatile turn.
const params: CallOptionsLike = {
  system: 'You are a careful release-notes summarizer. '.repeat(150),
  tools: {
    summarize: { description: 'Summarize a changelog section.', parameters: {} },
  },
  prompt: [
    { role: 'user', content: 'Summarize the 1.0.0 entry.' },
    { role: 'assistant', content: 'It ships the planning engine and the CLI.' },
    { role: 'user', content: 'Now compare it with the 0.x prototypes.' },
  ],
};

// 1. transformParams plans the call and decorates providerOptions.
const transformed = await middleware.transformParams({ params });
console.log('providerOptions.anthropic:', JSON.stringify(transformed.providerOptions?.anthropic));
console.log('providerOptions.racs     :', JSON.stringify(transformed.providerOptions?.racs));

// 2. wrapGenerate runs the wrapped call and records its usage. Here the
// "model" is a structural fake returning the usage shape a real provider
// reports; in production `doGenerate` is the SDK's own call.
const fakeResult: GenerateResultLike = {
  usage: {
    inputTokens: 2400,
    inputTokenDetails: { cacheReadTokens: 2000, cacheWriteTokens: 0 },
  },
};
await middleware.wrapGenerate({
  doGenerate: () => Promise.resolve(fakeResult),
  params: transformed,
});

// 3. The engine accounted for the call, attributed to the planned prefix.
const stats = racs.stats();
console.log('calls    :', stats.calls);
console.log('hit ratio:', stats.hitRatio.toFixed(3));
console.log('saved USD:', stats.savedUsd?.toFixed(6));

await racs.close();
