import { test } from "node:test";
import assert from "node:assert/strict";

import express from "express";

import { apiErrorHandler, apiNotFound } from "../../src/api/errors.js";
import { attestationsRoute } from "../../src/api/routes/attestations.js";
import type { AttestationRecord } from "../../src/chain/index.js";
import { emptyState, fakeDeps, startServer, getJson, type RunningServer } from "./support.js";

const WALLET = "GCNHX5ORRQLJOFQELVAXZ3PQMIAQ3B3QLKZQRV6FXGICZEMQRWY3TRKG";

function att(sequence: number): AttestationRecord {
  return {
    sequence,
    repo: "proofowl/proofowl-contracts",
    prNumber: sequence + 1,
    prHashHex: sequence.toString(16).padStart(64, "0"),
    githubIdHashHex: "a".repeat(64),
    issueId: BigInt(sequence),
    complexity: 100,
    timestamp: 1788784000n + BigInt(sequence),
  };
}

function appWith(state = emptyState()) {
  const app = express();
  app.get("/api/attestations/:wallet", attestationsRoute(fakeDeps(state)));
  app.use(apiNotFound);
  app.use(apiErrorHandler);
  return { app, state };
}

test("happy path: defaults return the whole (small) history, nextCursor null", async () => {
  const { app, state } = appWith();
  state.attestations.set(WALLET, [att(0), att(1), att(2)]);
  let srv: RunningServer | undefined;
  try {
    srv = await startServer(app);
    const r = await getJson(`${srv.url}/api/attestations/${WALLET}`);
    assert.equal(r.status, 200);
    const b = r.body as {
      wallet: string;
      pagination: Record<string, unknown>;
      attestations: unknown[];
    };
    assert.equal(b.wallet, WALLET);
    assert.deepEqual(b.pagination, {
      cursor: 0,
      limit: 50,
      count: 3,
      nextCursor: null,
      maxPageSize: 50,
    });
    assert.equal(b.attestations.length, 3);
    assert.equal((b.attestations[0] as { issueId: unknown }).issueId, "0"); // string, not bigint
    assert.equal(typeof (b.attestations[0] as { timestamp: unknown }).timestamp, "number");
    assert.deepEqual(state.calls, [`getAttestationsPage(${WALLET},0,50)`]);
  } finally {
    await srv?.close();
  }
});

test("pagination: a full page returns nextCursor = cursor + count", async () => {
  const { app, state } = appWith();
  state.attestations.set(
    WALLET,
    Array.from({ length: 7 }, (_v, i) => att(i)),
  );
  let srv: RunningServer | undefined;
  try {
    srv = await startServer(app);
    const p1 = await getJson(`${srv.url}/api/attestations/${WALLET}?cursor=0&limit=3`);
    const b1 = (p1.body as { pagination: { nextCursor: number | null; count: number } }).pagination;
    assert.deepEqual(b1, { cursor: 0, limit: 3, count: 3, nextCursor: 3, maxPageSize: 50 });

    const p2 = await getJson(`${srv.url}/api/attestations/${WALLET}?cursor=3&limit=3`);
    assert.equal(
      (p2.body as { pagination: { nextCursor: number | null } }).pagination.nextCursor,
      6,
    );

    const p3 = await getJson(`${srv.url}/api/attestations/${WALLET}?cursor=6&limit=3`);
    const b3 = (p3.body as { pagination: { nextCursor: number | null; count: number } }).pagination;
    assert.equal(b3.count, 1);
    assert.equal(b3.nextCursor, null, "short page -> end");
  } finally {
    await srv?.close();
  }
});

test("valid-but-unseen wallet -> 200 empty list, not 404", async () => {
  const { app } = appWith();
  let srv: RunningServer | undefined;
  try {
    srv = await startServer(app);
    const r = await getJson(`${srv.url}/api/attestations/${WALLET}`);
    assert.equal(r.status, 200);
    const b = r.body as {
      attestations: unknown[];
      pagination: { count: number; nextCursor: null };
    };
    assert.deepEqual(b.attestations, []);
    assert.equal(b.pagination.count, 0);
    assert.equal(b.pagination.nextCursor, null);
  } finally {
    await srv?.close();
  }
});

test("malformed :wallet or ?cursor/?limit -> 400, no chain call", async () => {
  const { app, state } = appWith();
  let srv: RunningServer | undefined;
  try {
    srv = await startServer(app);
    const badWallet = await getJson(`${srv.url}/api/attestations/nope`);
    assert.equal(badWallet.status, 400);

    const badCursor = await getJson(`${srv.url}/api/attestations/${WALLET}?cursor=-1`);
    assert.equal(badCursor.status, 400);
    assert.match(String((badCursor.body as { error?: string }).error), /cursor/);

    const badLimit = await getJson(`${srv.url}/api/attestations/${WALLET}?limit=100`);
    assert.equal(badLimit.status, 400);
    assert.match(String((badLimit.body as { error?: string }).error), /1\.\.50/);

    assert.deepEqual(state.calls, [], "no getAttestationsPage before a 400");
  } finally {
    await srv?.close();
  }
});
