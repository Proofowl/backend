import { test } from "node:test";
import assert from "node:assert/strict";

import express from "express";

import { createApiRouter } from "../../src/api/router.js";
import type { AttestationRecord } from "../../src/chain/index.js";
import {
  emptyState,
  fakeDeps,
  startServer,
  getJson,
  type FakeApiState,
  type RunningServer,
} from "./support.js";

const WALLET = "GCNHX5ORRQLJOFQELVAXZ3PQMIAQ3B3QLKZQRV6FXGICZEMQRWY3TRKG";
const HASH = "a69a5d6eaad01f548a793f28ee34f154d56e4a21eb6de3f23a5543ebd8ea9ca4";

function seededState(): FakeApiState {
  const s = emptyState();
  s.reputation.set(WALLET, { attestationCount: 2, reputationScore: 250 });
  const a: AttestationRecord = {
    sequence: 0,
    repo: "proofowl/proofowl-contracts",
    prNumber: 1,
    prHashHex: "b".repeat(64),
    githubIdHashHex: HASH,
    issueId: 7n,
    complexity: 150,
    timestamp: 1788784892n,
  };
  s.attestations.set(WALLET, [a, { ...a, sequence: 1, prNumber: 2, complexity: 100 }]);
  s.linkedWallet.set(HASH, WALLET);
  s.queueCounts = {
    WAITING_FOR_WALLET_LINK: 4,
    READY_TO_SUBMIT: 1,
    ALREADY_ATTESTED: 3,
    DISMISSED: 0,
  };
  return s;
}

function mount(state: FakeApiState, opts = {}) {
  const app = express();
  app.use(
    "/api",
    createApiRouter(fakeDeps(state), { disableRateLimit: true, disableCache: true, ...opts }),
  );
  return app;
}

test("all four endpoints route and shape correctly under one /api mount", async () => {
  const state = seededState();
  let srv: RunningServer | undefined;
  try {
    srv = await startServer(mount(state));
    const rep = await getJson(`${srv.url}/api/reputation/${WALLET}`);
    assert.deepEqual(rep.body, { wallet: WALLET, reputationScore: 250, attestationCount: 2 });

    const att = await getJson(`${srv.url}/api/attestations/${WALLET}?limit=1`);
    const ab = att.body as { pagination: { nextCursor: number | null }; attestations: unknown[] };
    assert.equal(ab.attestations.length, 1);
    assert.equal(ab.pagination.nextCursor, 1);

    const w4g = await getJson(`${srv.url}/api/wallet-for-github/${HASH}`);
    assert.deepEqual(w4g.body, { githubIdHash: HASH, wallet: WALLET });

    const q = await getJson(`${srv.url}/api/queue/status`);
    assert.deepEqual((q.body as { total: number }).total, 8);

    const missing = await getJson(`${srv.url}/api/nope`);
    assert.equal(missing.status, 404);
    assert.deepEqual(missing.body, { error: "not found" });
  } finally {
    await srv?.close();
  }
});

test("cache: a repeated identical read hits the fake dep once", async () => {
  const state = seededState();
  let srv: RunningServer | undefined;
  try {
    srv = await startServer(mount(state, { disableCache: false, cache: { ttlMs: 2000 } }));
    await getJson(`${srv.url}/api/reputation/${WALLET}`);
    const second = await getJson(`${srv.url}/api/reputation/${WALLET}`);
    assert.equal(second.headers.get("x-proofowl-cache"), "hit");
    assert.equal(
      state.calls.filter((c) => c.startsWith("getWalletReputation")).length,
      1,
      "downstream chain read ran once for two identical requests",
    );
  } finally {
    await srv?.close();
  }
});

test("rate limit: the (max+1)th request in the window is 429", async () => {
  const state = seededState();
  let srv: RunningServer | undefined;
  try {
    srv = await startServer(
      mount(state, {
        disableRateLimit: false,
        disableCache: true,
        rateLimit: { max: 3, windowMs: 60_000 },
      }),
    );
    const codes: number[] = [];
    for (let i = 0; i < 4; i++) {
      codes.push((await getJson(`${srv.url}/api/queue/status`)).status);
    }
    assert.deepEqual(codes, [200, 200, 200, 429]);
  } finally {
    await srv?.close();
  }
});

test("cache-first: identical cached reads do not spend rate-limit budget", async () => {
  const state = seededState();
  let srv: RunningServer | undefined;
  try {
    srv = await startServer(
      mount(state, {
        disableRateLimit: false,
        disableCache: false,
        rateLimit: { max: 2, windowMs: 60_000 },
        cache: { ttlMs: 5000 },
      }),
    );
    // 5 identical requests: 1 miss (counts) + 4 hits (bypass the limiter)
    const codes: number[] = [];
    for (let i = 0; i < 5; i++) {
      codes.push((await getJson(`${srv.url}/api/reputation/${WALLET}`)).status);
    }
    assert.deepEqual(codes, [200, 200, 200, 200, 200], "cache hits are not rate-limited");
  } finally {
    await srv?.close();
  }
});

test("a malformed param anywhere still 400s through the mounted router", async () => {
  const state = seededState();
  let srv: RunningServer | undefined;
  try {
    srv = await startServer(mount(state));
    for (const path of [
      "/api/reputation/nope",
      "/api/attestations/nope",
      "/api/attestations/" + WALLET + "?limit=999",
      "/api/wallet-for-github/xyz",
    ]) {
      const r = await getJson(`${srv.url}${path}`);
      assert.equal(r.status, 400, path);
      assert.ok((r.body as { error?: string }).error);
    }
  } finally {
    await srv?.close();
  }
});
