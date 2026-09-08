/**
 * Read-only REST API for proofowl-backend — exposes what already exists
 * on-chain and in the local queue (reputation, attestation history,
 * identity↔wallet lookup, queue status). No write path of any kind.
 * See ./router.ts.
 */

export type { ApiDeps } from "./deps.js";
export { createApiRouter, createApiDeps, type ApiRouterOptions } from "./router.js";
export {
  DEFAULT_RATE_LIMIT_MAX,
  DEFAULT_RATE_LIMIT_WINDOW_MS,
  type RateLimitOptions,
} from "./rateLimit.js";
export {
  DEFAULT_CACHE_TTL_MS,
  DEFAULT_CACHE_MAX_ENTRIES,
  type ResponseCacheOptions,
} from "./cache.js";
export { MAX_PAGE_SIZE } from "./pagination.js";
