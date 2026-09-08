/**
 * Error handling for the read-only REST API (`src/api/`).
 *
 * One rule: **no internal detail ever reaches a response body.** A
 * `ValidationError` (malformed path param / query — see
 * `src/lib/errors.ts`) becomes a 400 carrying its message, which by
 * construction describes the *input shape* and nothing else. Everything
 * else — a Soroban RPC failure, a Prisma error, a bug — becomes a fixed
 * `500 {"error":"internal error"}` with no message, no stack, no cause;
 * the real error is written to the server log only.
 *
 * Express's default error handler leaks the stack trace outside
 * `NODE_ENV=production`, so this handler must be registered explicitly
 * on the `/api` router (it is, in ./router.ts).
 */

import type { NextFunction, Request, Response } from "express";

import { ValidationError } from "../lib/errors.js";

/** The body shape every `/api` error response uses. */
export interface ApiErrorBody {
  error: string;
}

/**
 * Wrap an async route handler so a rejected promise is forwarded to the
 * error middleware. Express 5 already forwards async rejections; this
 * keeps the behaviour explicit and version-independent.
 */
export function asyncHandler(
  fn: (req: Request, res: Response, next: NextFunction) => unknown,
): (req: Request, res: Response, next: NextFunction) => void {
  return (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

/** 404 for an unknown path under `/api`. */
export function apiNotFound(_req: Request, res: Response): void {
  const body: ApiErrorBody = { error: "not found" };
  res.status(404).json(body);
}

/**
 * The only place an `/api` error turns into a response.
 *  - `ValidationError` → `400 { error: <message> }` (input-shape text, safe)
 *  - anything else      → `500 { error: "internal error" }`, detail to the log only
 */
export function apiErrorHandler(
  err: unknown,
  req: Request,
  res: Response,
  _next: NextFunction,
): void {
  if (res.headersSent) return;

  if (err instanceof ValidationError) {
    const body: ApiErrorBody = { error: err.message };
    res.status(400).json(body);
    return;
  }

  console.error(`[api] ${req.method} ${req.originalUrl} -> unhandled error:`, err);
  const body: ApiErrorBody = { error: "internal error" };
  res.status(500).json(body);
}
