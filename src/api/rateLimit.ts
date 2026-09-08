/**
 * Per-IP rate limiting for the `/api` routes — the one genuinely new
 * risk this read-only API introduces, since every uncached request can
 * trigger a live Soroban RPC simulation.
 *
 * Chosen limits: **60 requests per IP per 60 s** (≈1 req/s sustained).
 * Rationale for a read-only *testnet demo*:
 *  - a human browsing a passport UI, or a frontend polling one wallet's
 *    reputation every few seconds, stays far under this;
 *  - the 3 s response cache absorbs duplicate bursts below the limit, so
 *    a bucket rarely fills from legitimate use;
 *  - a scraper is capped near 1 rps — comfortably inside what the public
 *    SDF testnet RPC tolerates from one client.
 * It is deliberately NOT sized for production, multi-tenant traffic: a
 * real deployment would rate-limit at the edge (CDN / gateway) and issue
 * per-key quotas rather than lean on one in-process IP bucket.
 *
 * The 429 body carries only `{ error, retryAfterSeconds }` — no client
 * identity, no limiter internals.
 */

import rateLimit from "express-rate-limit";
import type { RequestHandler } from "express";

/** Requests allowed per IP per window. */
export const DEFAULT_RATE_LIMIT_MAX = 60;
/** Rate-limit window length, in milliseconds. */
export const DEFAULT_RATE_LIMIT_WINDOW_MS = 60_000;

export interface RateLimitOptions {
  /** Max requests per IP per window. Default 60. */
  max?: number;
  /** Window length in ms. Default 60000. */
  windowMs?: number;
}

/** Build the `/api` rate-limiting middleware. */
export function apiRateLimiter(options: RateLimitOptions = {}): RequestHandler {
  const windowMs = options.windowMs ?? DEFAULT_RATE_LIMIT_WINDOW_MS;
  const max = options.max ?? DEFAULT_RATE_LIMIT_MAX;

  return rateLimit({
    windowMs,
    limit: max,
    standardHeaders: "draft-7",
    legacyHeaders: false,
    // No reverse proxy is assumed for this demo — key on the socket IP.
    // These flags just silence express-rate-limit's startup checks for
    // that setup; they change no behaviour.
    validate: { trustProxy: false, xForwardedForHeader: false },
    handler: (_req, res) => {
      res.status(429).json({
        error: "rate limit exceeded",
        retryAfterSeconds: Math.ceil(windowMs / 1000),
      });
    },
  });
}
