import { test } from "node:test";
import assert from "node:assert/strict";

import express from "express";

import { apiErrorHandler, apiNotFound } from "../../src/api/errors.js";
import { reputationRoute } from "../../src/api/routes/reputation.js";
import { emptyState, fakeDeps, startServer, getJson, type RunningServer } from "./support.js";

const SEEN = "GCNHX5ORRQLJOFQELVAXZ3PQMIAQ3B3QLKZQRV6FXGICZEMQRWY3TRKG";
const UNSEEN = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF";

function appWith(state = emptyState()) {
  const app = express();
  app.get("/api/reputation/:wallet", reputationRoute(fakeDeps(state)));
  app.use(apiNotFound);
  app.use(apiErrorHandler);
  return { app, state };
}

test("happy path: valid wallet -> { wallet, reputationScore, attestationCount }", async () => {
  const { app, state } = appWith();
  state.reputation.set(SEEN, { attestationCount: 2, reputationScore: 250 });
  let srv: RunningServer | undefined;
  try {
    srv = await startServer(app);
    const r = await getJson(`${srv.url}/api/reputation/${SEEN}`);
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, { wallet: SEEN, reputationScore: 250, attestationCount: 2 });
  } finally {
    await srv?.close();
  }
});

test("valid-but-unseen wallet -> 200 with zeros, NOT a 404", async () => {
  const { app } = appWith();
  let srv: RunningServer | undefined;
  try {
    srv = await startServer(app);
    const r = await getJson(`${srv.url}/api/reputation/${UNSEEN}`);
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, { wallet: UNSEEN, reputationScore: 0, attestationCount: 0 });
  } finally {
    await srv?.close();
  }
});

test("malformed :wallet -> 400 and no chain call happens", async () => {
  const { app, state } = appWith();
  let srv: RunningServer | undefined;
  try {
    srv = await startServer(app);
    for (const bad of ["not-a-wallet", "GABC", SEEN.toLowerCase(), SEEN.slice(0, 55)]) {
      const r = await getJson(`${srv.url}/api/reputation/${bad}`);
      assert.equal(r.status, 400, bad);
      assert.match(String((r.body as { error?: string }).error), /Stellar public key/);
    }
    assert.deepEqual(state.calls, [], "validator rejected before any getWalletReputation");
  } finally {
    await srv?.close();
  }
});
