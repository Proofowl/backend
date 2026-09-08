import { test } from "node:test";
import assert from "node:assert/strict";

import express from "express";

import { apiErrorHandler, apiNotFound } from "../../src/api/errors.js";
import { queueStatusRoute } from "../../src/api/routes/queueStatus.js";
import { emptyState, fakeDeps, startServer, getJson, type RunningServer } from "./support.js";

function appWith(state = emptyState()) {
  const app = express();
  app.get("/api/queue/status", queueStatusRoute(fakeDeps(state)));
  app.use(apiNotFound);
  app.use(apiErrorHandler);
  return { app, state };
}

test("empty queue -> all four statuses at 0, total 0", async () => {
  const { app } = appWith();
  let srv: RunningServer | undefined;
  try {
    srv = await startServer(app);
    const r = await getJson(`${srv.url}/api/queue/status`);
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, {
      counts: {
        WAITING_FOR_WALLET_LINK: 0,
        READY_TO_SUBMIT: 0,
        ALREADY_ATTESTED: 0,
        DISMISSED: 0,
      },
      total: 0,
    });
  } finally {
    await srv?.close();
  }
});

test("counts are echoed and total is their sum", async () => {
  const { app, state } = appWith();
  state.queueCounts = {
    WAITING_FOR_WALLET_LINK: 5,
    READY_TO_SUBMIT: 2,
    ALREADY_ATTESTED: 9,
    DISMISSED: 1,
  };
  let srv: RunningServer | undefined;
  try {
    srv = await startServer(app);
    const r = await getJson(`${srv.url}/api/queue/status`);
    assert.equal(r.status, 200);
    const b = r.body as { counts: Record<string, number>; total: number };
    assert.equal(b.counts.WAITING_FOR_WALLET_LINK, 5);
    assert.equal(b.counts.ALREADY_ATTESTED, 9);
    assert.equal(b.total, 17);
    assert.deepEqual(state.calls, ["countByStatus()"]);
  } finally {
    await srv?.close();
  }
});

test("no individual-item fields are exposed", async () => {
  const { app, state } = appWith();
  state.queueCounts.WAITING_FOR_WALLET_LINK = 3;
  let srv: RunningServer | undefined;
  try {
    srv = await startServer(app);
    const r = await getJson(`${srv.url}/api/queue/status`);
    assert.doesNotMatch(r.text, /prHash|githubIdHash|verification|repo|prNumber|items|rows/);
    assert.deepEqual(Object.keys(r.body as object).sort(), ["counts", "total"]);
  } finally {
    await srv?.close();
  }
});
