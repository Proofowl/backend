import { test } from "node:test";
import assert from "node:assert/strict";

import express from "express";

import { apiErrorHandler, apiNotFound, asyncHandler } from "../../src/api/errors.js";
import { ValidationError } from "../../src/lib/errors.js";
import { startServer, getJson, type RunningServer } from "./support.js";

/** A mini app that routes everything through the real error middleware. */
function appThatThrows(err: unknown): express.Express {
  const app = express();
  app.get(
    "/boom",
    asyncHandler(async () => {
      throw err;
    }),
  );
  app.use(apiNotFound);
  app.use(apiErrorHandler);
  return app;
}

test("ValidationError -> 400 with its (input-shape) message verbatim", async () => {
  let srv: RunningServer | undefined;
  try {
    srv = await startServer(
      appThatThrows(new ValidationError("wallet must be a Stellar public key")),
    );
    const r = await getJson(`${srv.url}/boom`);
    assert.equal(r.status, 400);
    assert.deepEqual(r.body, { error: "wallet must be a Stellar public key" });
  } finally {
    await srv?.close();
  }
});

test("any other error -> 500 with a fixed body; NO message / stack / internals leak", async () => {
  const secret = "postgres://user:s3cr3t@db.internal:5432/proofowl";
  const err = new Error(`connection failed ${secret}`);
  const origErr = console.error;
  const logged: unknown[][] = [];
  console.error = (...a: unknown[]) => {
    logged.push(a);
  };
  let srv: RunningServer | undefined;
  try {
    srv = await startServer(appThatThrows(err));
    const r = await getJson(`${srv.url}/boom`);
    assert.equal(r.status, 500);
    assert.deepEqual(r.body, { error: "internal error" });
    // nothing sensitive in the wire response
    assert.doesNotMatch(
      r.text,
      /postgres|s3cr3t|db\.internal|connection failed|at Object|\.test\.js/,
    );
    // ...but the real error WAS written to the server log
    assert.equal(logged.length, 1);
    assert.ok(
      logged[0]?.some((x) => x === err || (typeof x === "string" && x.includes("/boom"))),
      "the unhandled error is logged server-side",
    );
  } finally {
    console.error = origErr;
    await srv?.close();
  }
});

test("a non-Error throw (string) is still 500, still no leak", async () => {
  const origErr = console.error;
  console.error = () => {};
  let srv: RunningServer | undefined;
  try {
    srv = await startServer(appThatThrows("raw string boom with a token abc123"));
    const r = await getJson(`${srv.url}/boom`);
    assert.equal(r.status, 500);
    assert.deepEqual(r.body, { error: "internal error" });
    assert.doesNotMatch(r.text, /raw string boom|abc123/);
  } finally {
    console.error = origErr;
    await srv?.close();
  }
});

test("unknown path under the router -> 404 { error: 'not found' }", async () => {
  let srv: RunningServer | undefined;
  try {
    srv = await startServer(appThatThrows(new Error("unused")));
    const r = await getJson(`${srv.url}/nope`);
    assert.equal(r.status, 404);
    assert.deepEqual(r.body, { error: "not found" });
  } finally {
    await srv?.close();
  }
});
