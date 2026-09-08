import { test } from "node:test";
import assert from "node:assert/strict";

import express from "express";

import { responseCache } from "../../src/api/cache.js";
import { startServer, getJson, type RunningServer } from "./support.js";

/**
 * Mini app: a controllable clock, a hit-counter, and a downstream that
 * echoes `?n=` and can be told to return a given status.
 */
function makeApp(opts: { ttlMs?: number; maxEntries?: number }) {
  let clock = 1_000_000;
  const calls: string[] = [];
  const app = express();
  app.use(responseCache({ ...opts, now: () => clock }));
  app.get("/thing", (req, res) => {
    calls.push(req.originalUrl);
    const status = Number(req.query.status ?? 200);
    res.status(status).json({ n: req.query.n ?? null, served: calls.length });
  });
  return { app, calls, advance: (ms: number) => (clock += ms) };
}

test("identical GET within the TTL is served from cache (downstream hit once)", async () => {
  const { app, calls } = makeApp({ ttlMs: 3000 });
  let srv: RunningServer | undefined;
  try {
    srv = await startServer(app);
    const a = await getJson(`${srv.url}/thing?n=1`);
    const b = await getJson(`${srv.url}/thing?n=1`);
    assert.equal(a.headers.get("x-proofowl-cache"), "miss");
    assert.equal(b.headers.get("x-proofowl-cache"), "hit");
    assert.deepEqual(a.body, b.body);
    assert.equal(calls.length, 1, "downstream ran once");
  } finally {
    await srv?.close();
  }
});

test("different query string is a different cache key", async () => {
  const { app, calls } = makeApp({ ttlMs: 3000 });
  let srv: RunningServer | undefined;
  try {
    srv = await startServer(app);
    await getJson(`${srv.url}/thing?n=1`);
    await getJson(`${srv.url}/thing?n=2`);
    assert.equal(calls.length, 2);
  } finally {
    await srv?.close();
  }
});

test("entry expires after the TTL — downstream runs again", async () => {
  const { app, calls, advance } = makeApp({ ttlMs: 3000 });
  let srv: RunningServer | undefined;
  try {
    srv = await startServer(app);
    await getJson(`${srv.url}/thing?n=1`);
    advance(3001);
    const again = await getJson(`${srv.url}/thing?n=1`);
    assert.equal(again.headers.get("x-proofowl-cache"), "miss");
    assert.equal(calls.length, 2);
  } finally {
    await srv?.close();
  }
});

test("non-2xx responses are never cached", async () => {
  const { app, calls } = makeApp({ ttlMs: 3000 });
  let srv: RunningServer | undefined;
  try {
    srv = await startServer(app);
    const a = await getJson(`${srv.url}/thing?n=1&status=500`);
    const b = await getJson(`${srv.url}/thing?n=1&status=500`);
    assert.equal(a.status, 500);
    assert.equal(b.headers.get("x-proofowl-cache"), "miss");
    assert.equal(calls.length, 2, "a 500 is re-run, not cached");
  } finally {
    await srv?.close();
  }
});

test("ttlMs <= 0 disables the cache entirely", async () => {
  const { app, calls } = makeApp({ ttlMs: 0 });
  let srv: RunningServer | undefined;
  try {
    srv = await startServer(app);
    await getJson(`${srv.url}/thing?n=1`);
    const b = await getJson(`${srv.url}/thing?n=1`);
    assert.equal(b.headers.get("x-proofowl-cache"), null);
    assert.equal(calls.length, 2);
  } finally {
    await srv?.close();
  }
});

test("FIFO eviction keeps the store bounded at maxEntries", async () => {
  const { app, calls } = makeApp({ ttlMs: 60_000, maxEntries: 2 });
  let srv: RunningServer | undefined;
  try {
    srv = await startServer(app);
    await getJson(`${srv.url}/thing?n=1`); // stored
    await getJson(`${srv.url}/thing?n=2`); // stored
    await getJson(`${srv.url}/thing?n=3`); // stored -> evicts n=1
    assert.equal(calls.length, 3);
    const one = await getJson(`${srv.url}/thing?n=1`); // evicted -> miss, re-run
    assert.equal(one.headers.get("x-proofowl-cache"), "miss");
    assert.equal(calls.length, 4);
    const three = await getJson(`${srv.url}/thing?n=3`); // still cached
    assert.equal(three.headers.get("x-proofowl-cache"), "hit");
    assert.equal(calls.length, 4);
  } finally {
    await srv?.close();
  }
});
