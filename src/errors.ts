/**
 * Error model for RACS (Remote Agent Context Store).
 *
 * RACS throws exactly one error class so that host applications can catch and branch on a
 * single type, then dispatch on the stable machine-readable {@link RacsError.code}. New codes
 * may be added in minor versions, so consumers must treat the code space as open and fall back
 * gracefully on codes they do not recognize.
 *
 * @packageDocumentation
 */

/**
 * The only error type thrown by RACS.
 *
 * Invariants:
 * - `name` is always the literal string `'RacsError'`, safe for cross-realm checks where
 *   `instanceof` fails (multiple bundles, workers, iframes).
 * - `code` is a stable, machine-readable, SCREAMING_SNAKE identifier prefixed with `ERR_`.
 *   It never changes meaning across versions, although new codes may appear in minors.
 * - `message` is human-readable English prose intended for logs, never for parsing.
 *
 * @example
 * ```ts
 * try {
 *   racs.plan(input);
 * } catch (error) {
 *   if (error instanceof RacsError && error.code === 'ERR_INVALID_INPUT') {
 *     // The caller sent a malformed PlanInput, fix the call site.
 *   }
 * }
 * ```
 */
export class RacsError extends Error {
  /**
   * Stable machine-readable error code, for example `'ERR_INVALID_INPUT'`.
   *
   * Branch on this field, never on `message`. The code space is minor-extensible.
   */
  readonly code: string;

  /**
   * @param message - Human-readable description of what went wrong and how to fix it.
   * @param code - Stable machine-readable code, see {@link RacsError.code}.
   */
  constructor(message: string, code: string) {
    super(message);
    this.name = 'RacsError';
    this.code = code;
  }

  /**
   * Builds a {@link RacsError} with code `'ERR_INVALID_INPUT'`.
   *
   * Used for every caller-side contract violation: malformed segments, a segment carrying
   * neither `content` nor `contentHash`, negative token counts, unknown TTL strings, and any
   * other input the type system cannot reject for untyped JavaScript callers.
   *
   * @param message - Human-readable description of the invalid input.
   * @returns A new error instance, never thrown by this factory itself.
   */
  static invalid(message: string): RacsError {
    return new RacsError(message, 'ERR_INVALID_INPUT');
  }
}
