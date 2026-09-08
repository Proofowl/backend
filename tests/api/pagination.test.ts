import { test } from "node:test";
import assert from "node:assert/strict";

import { MAX_PAGE_SIZE, nextCursor, parsePageParams } from "../../src/api/pagination.js";
import { ValidationError } from "../../src/lib/errors.js";

test("MAX_PAGE_SIZE is the contract's 50", () => {
  assert.equal(MAX_PAGE_SIZE, 50);
});

test("defaults: no query -> start 0, limit MAX_PAGE_SIZE", () => {
  assert.deepEqual(parsePageParams({}), { start: 0, limit: 50 });
  assert.deepEqual(parsePageParams({ cursor: "", limit: "" }), { start: 0, limit: 50 });
});

test("valid cursor / limit are parsed", () => {
  assert.deepEqual(parsePageParams({ cursor: "10", limit: "25" }), { start: 10, limit: 25 });
  assert.deepEqual(parsePageParams({ cursor: "0", limit: "1" }), { start: 0, limit: 1 });
  assert.deepEqual(parsePageParams({ limit: "50" }), { start: 0, limit: 50 });
});

test("malformed / out-of-range -> ValidationError (route makes it a 400)", () => {
  const bad: Array<Record<string, unknown>> = [
    { cursor: "-1" },
    { cursor: "abc" },
    { cursor: "1.5" },
    { cursor: ["1", "2"] },
    { cursor: { x: "1" } },
    { limit: "0" },
    { limit: "51" },
    { limit: "-3" },
    { limit: "100" },
    { limit: "9999999999999999999999" },
  ];
  for (const q of bad) {
    assert.throws(() => parsePageParams(q), ValidationError, JSON.stringify(q));
  }
});

test("nextCursor: full page -> next offset; short page -> null", () => {
  assert.equal(nextCursor(0, 50, 50), 50);
  assert.equal(nextCursor(50, 50, 50), 100);
  assert.equal(nextCursor(0, 50, 12), null);
  assert.equal(nextCursor(0, 50, 0), null);
  assert.equal(nextCursor(10, 10, 10), 20);
});
