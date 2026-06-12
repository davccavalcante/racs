/**
 * Deterministic, non-cryptographic hashing primitives for RACS (Remote Agent Context
 * Store): prefix keys, combined keys, and seeded short identifiers.
 *
 * Everything here is pure, allocation-light, dependency-free, and runs identically in
 * browsers, edge runtimes, workers, and Node. No randomness, no clock, no platform globals.
 *
 * Security stance: FNV-1a is NOT a cryptographic hash. It is trivially invertible and
 * collision-constructible by an adversary, so values produced by this module must never
 * gate a security decision (authentication, authorization, integrity verification). They
 * exist solely to give byte-equal inputs equal keys for cache bookkeeping.
 *
 * @packageDocumentation
 */

/**
 * FNV-1a 64-bit offset basis and prime, per the reference parameters published by
 * Fowler, Noll, and Vo (http://www.isthe.com/chongo/tech/comp/fnv/, retrieved June 2026).
 */
const FNV_OFFSET_BASIS = 0xcbf29ce484222325n;
const FNV_PRIME = 0x100000001b3n;
const MASK_64 = 0xffffffffffffffffn;

/**
 * Joins key parts with the ASCII unit separator (U+001F). Hex output is confined to
 * `[0-9a-f]`, so the separator can never occur inside a hash and joined keys cannot
 * collide by concatenation ambiguity ("ab" + "c" versus "a" + "bc").
 */
const KEY_SEPARATOR = '\u001f';

/**
 * Core FNV-1a 64-bit loop over the UTF-16 code units of `text`, two bytes per unit, low
 * byte first. Hashing code units directly, instead of UTF-8 bytes, keeps the function free
 * of any encoder dependency and free of per-call allocations, at the cost of producing
 * digests that differ from byte-wise UTF-8 FNV implementations. That is fine: these
 * digests are compared only against other digests produced by this same function.
 */
function fnv1a64Value(text: string): bigint {
  let hash = FNV_OFFSET_BASIS;
  for (let index = 0; index < text.length; index += 1) {
    const unit = text.charCodeAt(index);
    hash ^= BigInt(unit & 0xff);
    hash = (hash * FNV_PRIME) & MASK_64;
    hash ^= BigInt(unit >>> 8);
    hash = (hash * FNV_PRIME) & MASK_64;
  }
  return hash;
}

/**
 * Hashes `text` with FNV-1a 64-bit over its UTF-16 code units (two bytes per code unit,
 * low byte first) and returns the digest as a fixed-width 16-character lowercase hex
 * string.
 *
 * Determinism: pure function of the input, identical across runtimes and runs.
 *
 * Collision odds, non-adversarial inputs: with a 64-bit digest the birthday bound puts the
 * probability of any collision among n distinct inputs at roughly n^2 / 2^65, about 1 in
 * 37 million for one million distinct prefixes, reaching 50 percent only near 5 billion
 * inputs. Acceptable for cache-key bookkeeping, where a collision costs at worst one
 * misattributed statistic, never a wrong answer to the host.
 *
 * Non-cryptographic: an adversary can construct collisions at will. Never use the result
 * for security decisions, see the module-level security stance.
 *
 * @param text - The string to hash, hashed as-is with no normalization.
 * @returns 16 lowercase hex characters, zero-padded, for example '0a1b2c3d4e5f6789'.
 */
export function fnv1a64(text: string): string {
  return fnv1a64Value(text).toString(16).padStart(16, '0');
}

/**
 * Derives one key from several parts by joining them with a separator that cannot appear
 * in hex output (U+001F) and hashing the joined string with {@link fnv1a64}.
 *
 * The separator guarantees that part boundaries contribute to the digest, so
 * `combineKeys(['ab', 'c'])` and `combineKeys(['a', 'bc'])` differ even though their
 * concatenations are equal. Used to fuse segment hashes, provider, model, and agent
 * identity into one prefix key.
 *
 * Same non-cryptographic caveats and collision odds as {@link fnv1a64}.
 *
 * @param parts - Key components in significance order, empty parts are preserved.
 * @returns 16 lowercase hex characters identifying the part sequence.
 */
export function combineKeys(parts: readonly string[]): string {
  return fnv1a64(parts.join(KEY_SEPARATOR));
}

/**
 * Produces a deterministic short identifier from a seeded counter and a salt: the FNV-1a
 * 64-bit digest of `salt`, the separator, and the counter rendered in decimal, encoded in
 * base36. Same counter and salt always yield the same id, which is how plan ids stay
 * reproducible under {@link https://www.npmjs.com/package/@takk/racs | RACS}'s
 * never-call-the-global-random-generator rule.
 *
 * Output is 1 to 13 lowercase base36 characters (a 64-bit value needs at most 13 digits
 * in base36), typically 13.
 *
 * Non-cryptographic and predictable by design: anyone knowing the salt and counter can
 * recompute the id. Never use it as a secret, a session token, or any security-relevant
 * value. Collision odds follow {@link fnv1a64}.
 *
 * @param seededCounter - Monotonic counter from the engine's seeded id generator.
 * @param salt - Stable namespace string, for example the engine seed rendered as text.
 * @returns Deterministic base36 identifier, for example '2kgal12c8744o'.
 */
export function shortId(seededCounter: number, salt: string): string {
  return fnv1a64Value(`${salt}${KEY_SEPARATOR}${String(seededCounter)}`).toString(36);
}
