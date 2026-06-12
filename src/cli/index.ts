/**
 * Command dispatcher of the RACS (Remote Agent Context Store) CLI.
 *
 * Commands: help, version, analyze, simulate, inspect, serve. The dispatcher owns exit
 * codes, the help text, and nothing else; each command module owns its own flags, I/O,
 * and error messages. The CLI is Node-only by design, the one surface of the package
 * besides the file state backend where `node:` imports are allowed.
 *
 * Exit code contract:
 * - 0: success, including help and version.
 * - 1: gate or runtime failure (analyze found error-severity lints, serve refused to
 *   start).
 * - 2: usage errors, unknown commands, missing flags, unreadable inputs.
 *
 * @packageDocumentation
 */

import { runAnalyze } from './analyze.js';
import { runInspect } from './inspect.js';
import { runServe } from './serve.js';
import { runSimulate } from './simulate.js';

/**
 * The one version constant of the CLI, printed verbatim by `racs version` and embedded in
 * the help banner. A missing version command once turned a sibling package's first CI
 * push red, so the command and the banner share this single constant and neither can
 * drift from the other.
 */
export const VERSION = '1.0.0';

/** The binary name, the first word of every message the CLI prints about itself. */
const NAME = 'racs';

/** Full help text. The first line is a tested contract: exactly `racs 1.0.0`. */
const HELP = [
  `${NAME} ${VERSION}`,
  '',
  'RACS: prefix-cache management for production agents, stability-aware prompt planning, ' +
    'provider-faithful cache directives, TTL refresh scheduling, drift detection, and ' +
    'hit-ratio analytics.',
  '',
  'Usage:',
  `  ${NAME} <command> [options]`,
  '',
  'Commands:',
  '  help        Show this help text.',
  '  version     Print the CLI version.',
  '  analyze     Lint and plan PlanInput JSON documents, exit 1 on error findings.',
  '  simulate    Run the deterministic demonstration that planned caching pays.',
  '  inspect     Print a saved state snapshot, --watch for a live redraw.',
  '  serve       Start the local HTTP bridge around one engine.',
  '',
  'Examples:',
  `  ${NAME} help`,
  `  ${NAME} version`,
  `  ${NAME} analyze --input prompts.json --pricing prices.json`,
  `  ${NAME} simulate --calls 400 --seed 7 --interval 60 --provider anthropic`,
  `  ${NAME} inspect --state .racs/state.json`,
  `  ${NAME} serve --port 4378 --host 127.0.0.1 --token change-me --state .racs/state.json`,
].join('\n');

/** Dispatches one invocation to its command module and returns the exit code. */
async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  const command = argv[0];
  const rest = argv.slice(1);

  if (command === undefined || command === 'help' || command === '-h' || command === '--help') {
    console.log(HELP);
    return 0;
  }
  if (command === 'version' || command === '--version' || command === '-v') {
    console.log(VERSION);
    return 0;
  }
  switch (command) {
    case 'analyze':
      return runAnalyze(rest);
    case 'simulate':
      return runSimulate(rest);
    case 'inspect':
      return runInspect(rest);
    case 'serve':
      return runServe(rest);
    default: {
      console.error(`${NAME}: unknown command "${command}". Run "${NAME} help".`);
      return 2;
    }
  }
}

// process.exitCode instead of process.exit so stdout always flushes before the process
// leaves, and so long-lived commands (serve, inspect --watch) keep running on their own
// handles after the dispatcher resolved.
void main().then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    console.error(`${NAME}: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  },
);
