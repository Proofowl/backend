/**
 * Library entrypoint — re-exports the pieces this scaffold provides so
 * they can be consumed as modules (and so the follow-up passes that add
 * a polling loop / submission path / REST API have a stable surface to
 * build on). Module re-exports are added here as each lands.
 */

export * from "./config.js";
export * from "./lib/errors.js";
export * as hashing from "./hashing/index.js";
export * as github from "./github/index.js";
export * as chain from "./chain/index.js";
export * as queue from "./queue/index.js";
export * as pipeline from "./pipeline/index.js";
export * as api from "./api/index.js";
export { buildApp } from "./app.js";
