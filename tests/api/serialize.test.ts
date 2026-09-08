import { test } from "node:test";
import assert from "node:assert/strict";

import { serializeAttestation } from "../../src/api/serialize.js";
import type { AttestationRecord } from "../../src/chain/index.js";

const rec: AttestationRecord = {
  sequence: 3,
  repo: "proofowl/proofowl-contracts",
  prNumber: 7,
  prHashHex: "be9b713cbcbacdc44d593cd3e37f8680f6e7e229af9c2182cde3ee05a2bf6cef0",
  githubIdHashHex: "a69a5d6eaad01f548a793f28ee34f154d56e4a21eb6de3f23a5543ebd8ea9ca4",
  issueId: 18446744073709551000n, // near u64 max — must NOT be a JS number
  complexity: 150,
  timestamp: 1788784892n,
};

test("serializeAttestation is JSON.stringify-safe (no bigint escapes)", () => {
  const out = serializeAttestation(rec);
  assert.doesNotThrow(() => JSON.stringify(out));
  const round = JSON.parse(JSON.stringify(out));
  assert.deepEqual(round, out);
});

test("issueId -> decimal string (u64-safe), timestamp -> number", () => {
  const out = serializeAttestation(rec);
  assert.equal(typeof out.issueId, "string");
  assert.equal(out.issueId, "18446744073709551000");
  assert.equal(typeof out.timestamp, "number");
  assert.equal(out.timestamp, 1788784892);
});

test("scalar fields pass through unchanged", () => {
  const out = serializeAttestation(rec);
  assert.equal(out.sequence, 3);
  assert.equal(out.repo, "proofowl/proofowl-contracts");
  assert.equal(out.prNumber, 7);
  assert.equal(out.complexity, 150);
  assert.equal(out.prHashHex, rec.prHashHex);
  assert.equal(out.githubIdHashHex, rec.githubIdHashHex);
});
