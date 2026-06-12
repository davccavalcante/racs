import { defineConfig } from 'tsup';

/**
 * Build configuration for @takk/racs.
 *
 * Six library entry points (dual ESM + CJS, each with its own .d.ts) plus
 * the Node-only CLI (ESM with shebang). The core entry is universal: it
 * pulls no Node built-ins statically; the file state backend loads
 * `node:fs` lazily inside function bodies so the same bundle stays
 * importable in browsers and edge runtimes.
 */
export default defineConfig([
  {
    entry: {
      index: 'src/index.ts',
      'otel/index': 'src/otel/index.ts',
      'vercel/index': 'src/vercel/index.ts',
      'integrations/index': 'src/integrations/index.ts',
      'web/index': 'src/web/index.ts',
      'edge/index': 'src/edge/index.ts',
    },
    format: ['esm', 'cjs'],
    dts: true,
    sourcemap: true,
    clean: true,
    treeshake: true,
    splitting: false,
    minify: false,
    target: 'es2022',
    platform: 'neutral',
    removeNodeProtocol: false,
    // Node built-ins are loaded lazily inside function bodies (file state);
    // leave the specifiers untouched so browser and edge bundlers can
    // tree-shake or stub them, and Node resolves them natively at runtime.
    external: [/^node:/],
  },
  {
    entry: {
      'cli/index': 'src/cli/index.ts',
    },
    format: ['esm'],
    dts: false,
    sourcemap: true,
    clean: false,
    treeshake: true,
    splitting: false,
    minify: false,
    target: 'es2022',
    platform: 'node',
    banner: {
      js: '#!/usr/bin/env node',
    },
  },
]);
