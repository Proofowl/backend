/**
 * A tiny, short-TTL in-memory response cache for the read-only `/api`
 * GET routes.
 *
 * WHY: every uncached `/api` request can trigger a live Soroban RPC
 * simulation. A dashboard that mounts four widgets, a double-click, or a
 * frontend re-render all fire identical reads within a second or two.
 * Caching each response for a few seconds collapses those into one RPC
 * round-trip without meaningfully delaying how fast an on-chain change
 * becomes visible.
 *
 * Scope on purpose:
 *  - GET only; keyed by the full URL (path + query);
 *  - 2xx JSON responses only — a 400 / 429 / 500 is never cached;
 *  - a hard entry cap with FIFO eviction so it cannot grow unbounded;
 *  - `ttlMs <= 0` disables it entirely.
 * It is per-process and best-effort — not a correctness mechanism.
 */

import type { NextFunction, Request, Response } from "express";

/** Default response-cache TTL: 3 seconds. */
export const DEFAULT_CACHE_TTL_MS = 3_000;
/** Default hard cap on cached entries. */
export const DEFAULT_CACHE_MAX_ENTRIES = 500;

export interface ResponseCacheOptions {
  /** Milliseconds an entry stays fresh. `<= 0` disables caching. Default 3000. */
  ttlMs?: number;
  /** Hard cap on entries; oldest is evicted past this. Default 500. */
  maxEntries?: number;
  /** Injectable clock (tests). Default `Date.now`. */
  now?: () => number;
}

interface CacheEntry {
  expiresAt: number;
  status: number;
  body: unknown;
}

/** Build the caching middleware. */
export function responseCache(
  options: ResponseCacheOptions = {},
): (req: Request, res: Response, next: NextFunction) => void {
  const ttlMs = options.ttlMs ?? DEFAULT_CACHE_TTL_MS;
  const maxEntries = options.maxEntries ?? DEFAULT_CACHE_MAX_ENTRIES;
  const now = options.now ?? Date.now;
  const store = new Map<string, CacheEntry>();

  return function responseCacheMiddleware(req, res, next) {
    if (ttlMs <= 0 || req.method !== "GET") {
      next();
      return;
    }

    const key = req.originalUrl;
    const hit = store.get(key);
    if (hit && hit.expiresAt > now()) {
      res.setHeader("x-proofowl-cache", "hit");
      res.status(hit.status).json(hit.body);
      return;
    }
    if (hit) store.delete(key);
    res.setHeader("x-proofowl-cache", "miss");

    const sendJson = res.json.bind(res);
    res.json = (body: unknown): Response => {
      if (res.statusCode >= 200 && res.statusCode < 300) {
        if (store.size >= maxEntries) {
          const oldest = store.keys().next().value;
          if (oldest !== undefined) store.delete(oldest);
        }
        store.set(key, { expiresAt: now() + ttlMs, status: res.statusCode, body });
      }
      return sendJson(body);
    };

    next();
  };
}
