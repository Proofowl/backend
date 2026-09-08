/**
 * Guards the committed seed file at config/approved-orgs-allowlist.json:
 * it must always parse, and it must contain exactly the two
 * honestly-sourced seed entries with full provenance.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { DEFAULT_APPROVED_ORGS_ALLOWLIST_PATH } from "../../src/config.js";
import { FileApprovedOrgsAllowlistSource } from "../../src/github/approvedOrgsAllowlistSource.js";

/** Walk up from this file (src or test-build) until config/ is found. */
function repoRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 12; i++) {
    if (existsSync(join(dir, DEFAULT_APPROVED_ORGS_ALLOWLIST_PATH))) return dir;
    dir = dirname(dir);
  }
  throw new Error("could not locate repo root (config/ dir) from " + import.meta.url);
}

test("the default path constant points at config/approved-orgs-allowlist.json", () => {
  assert.equal(DEFAULT_APPROVED_ORGS_ALLOWLIST_PATH, "config/approved-orgs-allowlist.json");
});

test("the committed seed allowlist parses and holds the two seed entries", async () => {
  const path = join(repoRoot(), DEFAULT_APPROVED_ORGS_ALLOWLIST_PATH);
  const list = await new FileApprovedOrgsAllowlistSource({ path, cache: false }).load();

  assert.ok(list, "seed file must exist and parse");
  assert.deepEqual(list.entries.map((e) => e.repo).sort(), [
    "proofowl/backend",
    "proofowl/proofowl-contracts",
  ]);

  for (const e of list.entries) {
    assert.ok(e.assertedBy.length > 0, `${e.repo}: assertedBy`);
    assert.match(e.assertedAt, /^\d{4}-\d{2}-\d{2}/, `${e.repo}: assertedAt is an ISO date`);
    assert.match(e.evidenceUrl, /^https:\/\/github\.com\/Proofowl/, `${e.repo}: evidenceUrl`);
  }

  assert.ok(list.find("ProofOwl/ProofOwl-Contracts"), "lookup is case-insensitive");
});
