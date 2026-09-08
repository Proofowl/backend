import { test } from "node:test";
import assert from "node:assert/strict";

import { parseApprovedOrgsAllowlist } from "../../src/github/approvedOrgsAllowlist.js";
import { StaticApprovedOrgsAllowlistSource } from "../../src/github/approvedOrgsAllowlistSource.js";
import { seedReposFromAllowlist } from "../../src/pipeline/seed.js";

function allowlist(repos: string[]) {
  return new StaticApprovedOrgsAllowlistSource(
    parseApprovedOrgsAllowlist(
      repos.map((repo) => ({
        repo,
        assertedBy: "test operator",
        assertedAt: "2026-09-08",
        evidenceUrl: `https://github.com/${repo}`,
      })),
      "test-allowlist.json",
    ),
  );
}

test("maps every allowlist entry to an owner/repo seed", async () => {
  const seeds = await seedReposFromAllowlist(
    allowlist(["stellar/soroban-examples", "aquarius-fi/amm"]),
  );
  assert.deepEqual(seeds, [
    { owner: "stellar", repo: "soroban-examples", ownerRepo: "stellar/soroban-examples" },
    { owner: "aquarius-fi", repo: "amm", ownerRepo: "aquarius-fi/amm" },
  ]);
});

test("no allowlist configured -> empty seed list", async () => {
  const seeds = await seedReposFromAllowlist(new StaticApprovedOrgsAllowlistSource(null));
  assert.deepEqual(seeds, []);
});

test("a malformed allowlist still throws from load()", async () => {
  const bad = {
    async load() {
      throw new Error("allowlist at x is not valid JSON");
    },
  };
  await assert.rejects(seedReposFromAllowlist(bad), /not valid JSON/);
});
