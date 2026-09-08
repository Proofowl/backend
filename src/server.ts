/**
 * Process entrypoint. `npm run dev` / `npm start` run this; it starts
 * the HTTP server described in src/app.ts — liveness plus the read-only
 * `/api`. It does NOT begin polling GitHub, does NOT start the pipeline
 * scheduler, and makes NO contract or RPC call on boot: `createApiDeps`
 * only constructs the read client and queue handle (both connect
 * lazily, on the first request).
 */

import { buildApp } from "./app.js";
import { createApiDeps } from "./api/index.js";
import { config } from "./config.js";
import { disconnectPrisma } from "./queue/index.js";

const app = buildApp({ apiDeps: createApiDeps(config) });

const server = app.listen(config.port, () => {
  console.log(`proofowl-backend listening on :${config.port} (${config.nodeEnv})`);
  console.log(
    `read-only /api reads contract ${config.chain.contractId} via ${config.chain.rpcUrl}`,
  );
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    console.log(`${signal} received, shutting down`);
    server.close(() => {
      void disconnectPrisma().finally(() => process.exit(0));
    });
  });
}
