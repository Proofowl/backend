import { test } from "node:test";
import assert from "node:assert/strict";

import express from "express";

import {
  apiRateLimiter,
  DEFAULT_RATE_LIMIT_MAX,
  DEFAULT_RATE_LIMIT_WINDOW_MS,
} from "../../src/api/rateLimit.js";
import { startServer, getJson, type RunningServer } from "./support.js";

test("defaults are the documented 60 req / 60 s", () => {
  assert.equal(DEFAULT_RATE_LIMIT_MAX, 60);
  assert.equal(DEFAULT_RATE_LIMIT_WINDOW_MS, 60_000);
});

test("the (max+1)th request in a window is 429 with a clean body", async () => {
  const app = express();
  app.use(apiRateLimiter({ max: 3, windowMs: 60_000 }));
  app.get("/x", (_req, res) => res.json({ ok: true }));

  let srv: RunningServer | undefined;
  try {
    srv = await startServer(app);
    const codes: number[] = [];
    let limited: Awaited<ReturnType<typeof getJson>> | undefined;
    for (let i = 0; i < 4; i++) {
      const r = await getJson(`${srv.url}/x`);
      codes.push(r.status);
      if (r.status === 429) limited = r;
    }
    assert.deepEqual(codes, [200, 200, 200, 429]);
    assert.ok(limited);
    assert.deepEqual(limited.body, { error: "rate limit exceeded", retryAfterSeconds: 60 });
    // no limiter internals / client identity in the body
    assert.doesNotMatch(limited.text, /127\.0\.0\.1|::1|windowMs|keyGenerator|store/i);
  } finally {
    await srv?.close();
  }
});

test("standard RateLimit headers are present; legacy X-RateLimit-* are not", async () => {
  const app = express();
  app.use(apiRateLimiter({ max: 5, windowMs: 60_000 }));
  app.get("/x", (_req, res) => res.json({ ok: true }));

  let srv: RunningServer | undefined;
  try {
    srv = await startServer(app);
    const r = await getJson(`${srv.url}/x`);
    assert.ok(r.headers.get("ratelimit") ?? r.headers.get("ratelimit-limit"), "draft-7 header set");
    assert.equal(r.headers.get("x-ratelimit-limit"), null, "legacy header suppressed");
  } finally {
    await srv?.close();
  }
});
