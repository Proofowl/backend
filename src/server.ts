/**
 * Process entrypoint. `npm run dev` / `npm start` run this; it only
 * starts the liveness server described in src/app.ts. It does NOT begin
 * polling GitHub or touch the contract on boot.
 */

import { buildApp } from "./app.js";
import { config } from "./config.js";

const app = buildApp();

const server = app.listen(config.port, () => {
  console.log(`proofowl-backend listening on :${config.port} (${config.nodeEnv})`);
  console.log(`chain reads target contract ${config.chain.contractId} via ${config.chain.rpcUrl}`);
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    console.log(`${signal} received, shutting down`);
    server.close(() => process.exit(0));
  });
}
