/**
 * Small shared error taxonomy. Kept deliberately minimal for this
 * scaffold — the modules that do real work (hashing, GitHub
 * verification, on-chain reads) throw plain `Error` subclasses so a
 * future HTTP layer can map them without importing framework types
 * here.
 */

/** A caller-supplied value failed validation (bad repo name, malformed id, …). */
export class ValidationError extends Error {
  override readonly name = "ValidationError";
}

/** An upstream service (GitHub, Soroban RPC, Wave) failed or returned an unusable shape. */
export class UpstreamError extends Error {
  override readonly name = "UpstreamError";
  override readonly cause: unknown;
  constructor(message: string, cause?: unknown) {
    super(message);
    this.cause = cause;
  }
}

/** A read we expected to succeed returned "not found" (e.g. no such PR / issue). */
export class NotFoundError extends Error {
  override readonly name = "NotFoundError";
}
