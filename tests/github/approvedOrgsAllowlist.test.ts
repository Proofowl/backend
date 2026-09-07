import { test } from "node:test";
import assert from "node:assert/strict";

import { parseApprovedOrgsAllowlist } from "../../src/github/approvedOrgsAllowlist.js";

const GOOD_ENTRY = {
  repo: "proofowl/proofowl-contracts",
  assertedBy: "akerityonoah (maintainer)",
  assertedAt: "2026-09-07",
  evidenceUrl: "https://github.com/Proofowl/proofowl-contracts",
};

test("accepts {entries:[...]} and a bare array, normalizes repo to lowercase", () => {
  const a = parseApprovedOrgsAllowlist({ entries: [GOOD_ENTRY] }, "x.json");
  const b = parseApprovedOrgsAllowlist([GOOD_ENTRY], "x.json");
  assert.equal(a.entries.length, 1);
  assert.deepEqual(a.entries, b.entries);
  assert.equal(a.entries[0]?.repo, "proofowl/proofowl-contracts");
  assert.equal(a.source, "x.json");

  const mixedCase = parseApprovedOrgsAllowlist(
    [{ ...GOOD_ENTRY, repo: "ProofOwl/Proofowl-Contracts" }],
    "x",
  );
  assert.equal(mixedCase.entries[0]?.repo, "proofowl/proofowl-contracts");
});

test("find() is a case-insensitive exact owner/name lookup", () => {
  const list = parseApprovedOrgsAllowlist([GOOD_ENTRY], "x");
  assert.ok(list.find("proofowl/proofowl-contracts"));
  assert.ok(list.find("  ProofOwl/Proofowl-Contracts  "));
  assert.equal(list.find("proofowl/other"), undefined);
  assert.equal(list.find("proofowl"), undefined); // owner only is not a match
});

test("rejects a bare repo string entry (provenance is required)", () => {
  assert.throws(
    () => parseApprovedOrgsAllowlist(["proofowl/proofowl-contracts"], "x"),
    /bare string — provenance is required/,
  );
});

test("rejects each missing / malformed provenance field", () => {
  const cases: Array<[Record<string, unknown>, RegExp]> = [
    [{ ...GOOD_ENTRY, repo: undefined }, /"repo" must be a non-empty/],
    [{ ...GOOD_ENTRY, repo: "no-slash" }, /not a valid "owner\/name"/],
    [{ ...GOOD_ENTRY, repo: "a/b/c" }, /not a valid "owner\/name"/],
    [{ ...GOOD_ENTRY, assertedBy: "" }, /"assertedBy" must be a non-empty/],
    [{ ...GOOD_ENTRY, assertedAt: "last tuesday" }, /"assertedAt" must be an ISO date/],
    [{ ...GOOD_ENTRY, assertedAt: "2026-13-40" }, /is not a real date/],
    [{ ...GOOD_ENTRY, evidenceUrl: "not a url" }, /"evidenceUrl"/],
    [{ ...GOOD_ENTRY, evidenceUrl: "ftp://example.com" }, /must be http\(s\)/],
    [{ ...GOOD_ENTRY, note: 5 }, /"note" must be a string/],
  ];
  for (const [entry, re] of cases) {
    assert.throws(() => parseApprovedOrgsAllowlist([entry], "x"), re, JSON.stringify(entry));
  }
});

test("rejects duplicate repo entries (case-insensitive)", () => {
  assert.throws(
    () =>
      parseApprovedOrgsAllowlist(
        [GOOD_ENTRY, { ...GOOD_ENTRY, repo: "ProofOwl/Proofowl-Contracts" }],
        "x",
      ),
    /duplicate repo entry/,
  );
});

test("rejects a top-level shape that is neither array nor {entries:[]}", () => {
  assert.throws(() => parseApprovedOrgsAllowlist({ repos: [] }, "x"), /JSON array of entries/);
  assert.throws(() => parseApprovedOrgsAllowlist("nope", "x"), /JSON array of entries/);
});

test("keeps an optional note and accepts a full ISO datetime for assertedAt", () => {
  const list = parseApprovedOrgsAllowlist(
    [{ ...GOOD_ENTRY, assertedAt: "2026-09-07T12:00:00Z", note: "context" }],
    "x",
  );
  assert.equal(list.entries[0]?.note, "context");
  assert.equal(list.entries[0]?.assertedAt, "2026-09-07T12:00:00Z");
});
