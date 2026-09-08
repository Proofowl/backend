import { test } from "node:test";
import assert from "node:assert/strict";

import express from "express";

import { apiErrorHandler, apiNotFound } from "../../src/api/errors.js";
import { walletForGithubRoute } from "../../src/api/routes/walletForGithub.js";
import { emptyState, fakeDeps, startServer, getJson, type RunningServer } from "./support.js";

const HASH = "a69a5d6eaad01f548a793f28ee34f154d56e4a21eb6de3f23a5543ebd8ea9ca4";
const LINKED = "GCNHX5ORRQLJOFQELVAXZ3PQMIAQ3B3QLKZQRV6FXGICZEMQRWY3TRKG";

function appWith(state = emptyState()) {
  const app = express();
  app.get("/api/wallet-for-github/:githubIdHash", walletForGithubRoute(fakeDeps(state)));
  app.use(apiNotFound);
  app.use(apiErrorHandler);
  return { app, state };
}

test("linked identity -> { githubIdHash, wallet }", async () => {
  const { app, state } = appWith();
  state.linkedWallet.set(HASH, LINKED);
  let srv: RunningServer | undefined;
  try {
    srv = await startServer(app);
    const r = await getJson(`${srv.url}/api/wallet-for-github/${HASH}`);
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, { githubIdHash: HASH, wallet: LINKED });
  } finally {
    await srv?.close();
  }
});

test("well-formed but unlinked hash -> { wallet: null }, not 404", async () => {
  const { app } = appWith();
  let srv: RunningServer | undefined;
  try {
    srv = await startServer(app);
    const r = await getJson(`${srv.url}/api/wallet-for-github/${"f".repeat(64)}`);
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, { githubIdHash: "f".repeat(64), wallet: null });
  } finally {
    await srv?.close();
  }
});

test("uppercase hex is accepted and echoed back lowercased", async () => {
  const { app, state } = appWith();
  state.linkedWallet.set(HASH, LINKED);
  let srv: RunningServer | undefined;
  try {
    srv = await startServer(app);
    const r = await getJson(`${srv.url}/api/wallet-for-github/${HASH.toUpperCase()}`);
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, { githubIdHash: HASH, wallet: LINKED });
  } finally {
    await srv?.close();
  }
});

test("malformed hash -> 400, no chain call", async () => {
  const { app, state } = appWith();
  let srv: RunningServer | undefined;
  try {
    srv = await startServer(app);
    for (const bad of ["abc", "g".repeat(64), "a".repeat(63), "0x" + "a".repeat(62)]) {
      const r = await getJson(`${srv.url}/api/wallet-for-github/${bad}`);
      assert.equal(r.status, 400, bad);
      assert.match(String((r.body as { error?: string }).error), /64-character hex/);
    }
    assert.deepEqual(state.calls, []);
  } finally {
    await srv?.close();
  }
});
