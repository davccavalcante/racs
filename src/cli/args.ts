/**
 * Argument parsing of the RACS (Remote Agent Context Store) CLI, the family pattern: one
 * pure function turning an argv slice into flags and positionals, no schema, no defaults,
 * no I/O. Commands own their own flag names, type coercion, and error messages, so this
 * module never prints and never exits.
 *
 * Parsing contract, identical across the package family:
 * - `--key value` binds `value` to `key` when the next token is not flag-shaped.
 * - `--key=value` binds inline, the value may be empty or contain further `=` characters.
 * - `--key` with no usable value becomes the boolean `true`.
 * - Flag-lookalike values are never consumed: in `--key --other` the `--other` token stays
 *   a flag and `key` becomes boolean, so a typo never swallows the next flag.
 * - A literal `--` ends flag parsing, everything after it is positional.
 * - A lone `-` is positional by convention (the stdin placeholder).
 * - Repeated flags keep the last occurrence.
 *
 * Determinism: pure function of the input array, no clock, no randomness, no platform
 * globals, safe to call anywhere.
 *
 * @packageDocumentation
 */

/** Result of one {@link parseArgs} pass, plain data, trivially serializable. */
export interface ParsedArgs {
  /** Flag name (dashes stripped) to its string value, or `true` for bare flags. */
  readonly flags: Readonly<Record<string, string | true>>;
  /** Non-flag tokens in input order, including everything after a literal `--`. */
  readonly positionals: readonly string[];
}

/** True for tokens that look like a flag: leading dash, more than the dash itself. */
function isFlagShaped(token: string): boolean {
  return token.startsWith('-') && token !== '-' && token !== '--';
}

/**
 * Parses one argv slice into flags and positionals per the module-level contract.
 *
 * @param argv - Tokens after the command name, typically `process.argv.slice(3)`.
 * @returns Flags and positionals, see {@link ParsedArgs}.
 */
export function parseArgs(argv: readonly string[]): ParsedArgs {
  const flags: Record<string, string | true> = {};
  const positionals: string[] = [];
  let literal = false;
  let index = 0;
  while (index < argv.length) {
    const token = argv[index];
    index += 1;
    if (token === undefined) {
      break;
    }
    if (literal) {
      positionals.push(token);
      continue;
    }
    if (token === '--') {
      literal = true;
      continue;
    }
    if (!isFlagShaped(token)) {
      positionals.push(token);
      continue;
    }
    const body = token.replace(/^-+/, '');
    if (body === '') {
      positionals.push(token);
      continue;
    }
    const equals = body.indexOf('=');
    if (equals !== -1) {
      const name = body.slice(0, equals);
      if (name === '') {
        positionals.push(token);
        continue;
      }
      flags[name] = body.slice(equals + 1);
      continue;
    }
    const next = argv[index];
    if (next !== undefined && !isFlagShaped(next)) {
      flags[body] = next;
      index += 1;
    } else {
      flags[body] = true;
    }
  }
  return { flags, positionals };
}

/** True when the flag was given at all, with or without a value. */
export function flagPresent(args: ParsedArgs, name: string): boolean {
  return args.flags[name] !== undefined;
}

/** The flag's string value, `undefined` when absent or given bare (boolean). */
export function readString(args: ParsedArgs, name: string): string | undefined {
  const value = args.flags[name];
  return typeof value === 'string' ? value : undefined;
}

/** True when the flag was given at all, the boolean-flag reading. */
export function readBoolean(args: ParsedArgs, name: string): boolean {
  return args.flags[name] !== undefined;
}

/**
 * The flag's numeric value: `fallback` when absent, the parsed number when present and
 * finite, `undefined` when present but bare or not a finite number, which the caller
 * should treat as a usage error.
 */
export function readNumber(args: ParsedArgs, name: string, fallback: number): number | undefined {
  const value = args.flags[name];
  if (value === undefined) {
    return fallback;
  }
  if (value === true || value === '') {
    return undefined;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}
