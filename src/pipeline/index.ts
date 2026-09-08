/**
 * The automation pipeline: discover → verify → submit / queue → retry.
 *
 * Library surface only. The executable entrypoint (`./main.ts`, run via
 * `npm run pipeline:once` / `pipeline:loop`) is intentionally NOT
 * re-exported here — importing it runs it.
 */

export * from "./config.js";
export * from "./log.js";
export * from "./seed.js";
export * from "./discover.js";
export * from "./runOnce.js";
