/**
 * The read-only REST API, as one mountable Express `Router`.
 *
 * Middleware order (per request):
 *   1. response cache  — an identical GET within a few seconds is served
 *      from memory and never reaches step 2 or a route, so repeated
 *      reads do not burn rate-limit budget or hit the RPC;
 *   2. per-IP rate limiter — every cache *miss* counts; a scraper's
 *      distinct-key requests are all misses and are limited;
 *   3. the four route handlers (each validates its path/query params and
 *      turns a bad one into a 400 before any chain read);
 *   4. `apiNotFound` for an unknown `/api/*` path;
 *   5. `apiErrorHandler` — the only place an error becomes a response;
 *      no stack / RPC / DB detail ever leaves in the body.
 *
 * Everything is a read. There is no route here that writes to the
 * contract, signs anything, or touches the queue beyond a COUNT.
 */

import { Router } from "express";

import type { AppConfig } from "../config.js";
import { createChainModule } from "../chain/index.js";
import { createQueue } from "../queue/index.js";
import { responseCache, type ResponseCacheOptions } from "./cache.js";
import type { ApiDeps } from "./deps.js";
import { apiErrorHandler, apiNotFound } from "./errors.js";
import { apiRateLimiter, type RateLimitOptions } from "./rateLimit.js";
import { attestationsRoute } from "./routes/attestations.js";
import { queueStatusRoute } from "./routes/queueStatus.js";
import { reputationRoute } from "./routes/reputation.js";
import { walletForGithubRoute } from "./routes/walletForGithub.js";

export interface ApiRouterOptions {
  /** Overrides for the per-IP rate limiter (see ./rateLimit.ts). */
  rateLimit?: RateLimitOptions;
  /** Overrides for the response cache (see ./cache.ts). */
  cache?: ResponseCacheOptions;
  /** Skip the rate limiter entirely (tests). Default: enabled. */
  disableRateLimit?: boolean;
  /** Skip the response cache entirely (tests). Default: enabled. */
  disableCache?: boolean;
}

/** Build the `/api` router over an already-constructed `ApiDeps`. */
export function createApiRouter(deps: ApiDeps, options: ApiRouterOptions = {}): Router {
  const router = Router();

  if (!options.disableCache) router.use(responseCache(options.cache));
  if (!options.disableRateLimit) router.use(apiRateLimiter(options.rateLimit));

  router.get("/reputation/:wallet", reputationRoute(deps));
  router.get("/attestations/:wallet", attestationsRoute(deps));
  router.get("/wallet-for-github/:githubIdHash", walletForGithubRoute(deps));
  router.get("/queue/status", queueStatusRoute(deps));

  router.use(apiNotFound);
  router.use(apiErrorHandler);
  return router;
}

/**
 * Build the real `ApiDeps` from app config: a read-only chain client and
 * the queue repository. Pure construction — no RPC call, no DB
 * connection happens here (both are lazy), so calling this at server
 * boot does not poll or touch the contract.
 */
export function createApiDeps(config: AppConfig): ApiDeps {
  return {
    chain: createChainModule(config.chain),
    queue: createQueue(),
  };
}
