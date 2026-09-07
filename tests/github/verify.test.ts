import { test } from "node:test";
import assert from "node:assert/strict";

import type { ApprovedOrgsSource } from "../../src/github/approvedOrgs.js";
import { StaticApprovedOrgsSource } from "../../src/github/approvedOrgs.js";
import { parseApprovedOrgsAllowlist } from "../../src/github/approvedOrgsAllowlist.js";
import { StaticApprovedOrgsAllowlistSource } from "../../src/github/approvedOrgsAllowlistSource.js";
import { verifyContribution, getCheck } from "../../src/github/verify.js";
import type { VerificationCandidate } from "../../src/github/types.js";
import { ALICE, BOB, fakeGitHubClient, labeledEvent, mergedPr, waveIssue } from "./fixtures.js";

const CANDIDATE: VerificationCandidate = {
  owner: "stellar",
  repo: "soroban-examples",
  issueNumber: 7,
  prNumber: 42,
};

const approvedOrgs = new StaticApprovedOrgsSource(["stellar", "OtherOrg"]);

/** A live source that is always unavailable — for the fallback cases. */
const liveUnavailable: ApprovedOrgsSource = {
  async listApprovedOrgs() {
    return {
      status: "indeterminate" as const,
      reason: "drips.network/wave/stellar/orgs is client-rendered; no public JSON endpoint",
      source: "https://drips.network/wave/stellar/orgs",
      fetchedAt: new Date().toISOString(),
    };
  },
};

/** An allowlist source holding one entry for the CANDIDATE repo. */
function allowlistWithCandidate() {
  return new StaticApprovedOrgsAllowlistSource(
    parseApprovedOrgsAllowlist(
      [
        {
          repo: "stellar/soroban-examples",
          assertedBy: "test operator",
          assertedAt: "2026-09-07",
          evidenceUrl: "https://github.com/stellar/soroban-examples",
          note: "seed for tests",
        },
      ],
      "test-allowlist.json",
    ),
  );
}

test("happy path: every gating check passes, not a self-merge", async () => {
  const result = await verifyContribution(CANDIDATE, {
    github: fakeGitHubClient(),
    approvedOrgs,
  });

  assert.equal(result.attestable, true);
  assert.equal(result.indeterminate, false);
  assert.deepEqual(
    result.checks.map((c) => [c.id, c.status]),
    [
      ["repo_in_approved_orgs", "pass"],
      ["issue_has_wave_label", "pass"],
      ["wave_label_predates_pr_merge", "pass"],
      ["pr_closes_issue", "pass"],
      ["pr_is_merged", "pass"],
    ],
  );
  assert.equal(result.flags.selfMerge.flagged, false);
});

test("self-merge is flagged but does NOT change attestable", async () => {
  const result = await verifyContribution(CANDIDATE, {
    github: fakeGitHubClient({ pr: mergedPr({ user: ALICE, merged_by: ALICE }) }),
    approvedOrgs,
  });

  assert.equal(result.flags.selfMerge.flagged, true);
  assert.equal(result.flags.selfMerge.prAuthorId, ALICE.id);
  assert.equal(result.flags.selfMerge.mergedById, ALICE.id);
  assert.equal(result.attestable, true, "policy on self-merge is the caller's, not baked in");
});

test("merged_by missing: self-merge undeterminable, flagged=false with a reason", async () => {
  const result = await verifyContribution(CANDIDATE, {
    github: fakeGitHubClient({ pr: mergedPr({ merged_by: null }) }),
    approvedOrgs,
  });
  assert.equal(result.flags.selfMerge.flagged, false);
  assert.match(result.flags.selfMerge.detail, /cannot be determined/);
});

test("repo not in approved-orgs list -> that check fails, others still evaluated", async () => {
  const result = await verifyContribution(CANDIDATE, {
    github: fakeGitHubClient(),
    approvedOrgs: new StaticApprovedOrgsSource(["someone-else"]),
  });
  assert.equal(getCheck(result, "repo_in_approved_orgs").status, "fail");
  assert.equal(getCheck(result, "pr_is_merged").status, "pass");
  assert.equal(result.attestable, false);
  assert.equal(result.indeterminate, false);
});

// --- repo_in_approved_orgs: allowlist fallback, four cases ------------

test("case 1: live source returns a real list -> used as-is, allowlist ignored, no confidence marker", async () => {
  // Live 'ok' AND an allowlist that would also match — the live answer wins.
  const result = await verifyContribution(CANDIDATE, {
    github: fakeGitHubClient(),
    approvedOrgs: new StaticApprovedOrgsSource(["stellar"]),
    approvedOrgsAllowlist: allowlistWithCandidate(),
  });
  const check = getCheck(result, "repo_in_approved_orgs");
  assert.equal(check.status, "pass");
  assert.equal(
    check.confidence,
    undefined,
    "a live-sourced pass carries no manual-assertion marker",
  );
  assert.equal(check.evidence.source, "static");
  assert.equal(check.evidence.decidedBy, undefined);
});

test("case 1: live source returns a list NOT containing the owner -> fail from live, not the allowlist", async () => {
  const result = await verifyContribution(CANDIDATE, {
    github: fakeGitHubClient(),
    approvedOrgs: new StaticApprovedOrgsSource(["someone-else"]),
    approvedOrgsAllowlist: allowlistWithCandidate(), // would say pass — but live wins
  });
  const check = getCheck(result, "repo_in_approved_orgs");
  assert.equal(check.status, "fail");
  assert.equal(check.confidence, undefined);
});

test("case 4: live source unavailable, NO allowlist configured -> indeterminate (unchanged)", async () => {
  const result = await verifyContribution(CANDIDATE, {
    github: fakeGitHubClient(),
    approvedOrgs: liveUnavailable,
  });
  const check = getCheck(result, "repo_in_approved_orgs");
  assert.equal(check.status, "indeterminate");
  assert.equal(check.confidence, undefined);
  assert.equal(result.attestable, false);
  assert.equal(result.indeterminate, true);
});

test("case 4: live source unavailable, allowlist source present but file absent (load()->null) -> still indeterminate", async () => {
  const result = await verifyContribution(CANDIDATE, {
    github: fakeGitHubClient(),
    approvedOrgs: liveUnavailable,
    approvedOrgsAllowlist: new StaticApprovedOrgsAllowlistSource(null),
  });
  const check = getCheck(result, "repo_in_approved_orgs");
  assert.equal(check.status, "indeterminate");
  assert.equal(check.confidence, undefined);
  assert.equal(result.indeterminate, true);
});

test("issue carries no Wave label -> issue_has_wave_label fails", async () => {
  const result = await verifyContribution(CANDIDATE, {
    github: fakeGitHubClient({ issue: waveIssue({ labels: [{ name: "bug" }, { name: "docs" }] }) }),
    approvedOrgs,
  });
  assert.equal(getCheck(result, "issue_has_wave_label").status, "fail");
  assert.equal(result.attestable, false);
});

test("candidate 'issue' is actually a PR -> issue_has_wave_label fails", async () => {
  const result = await verifyContribution(CANDIDATE, {
    github: fakeGitHubClient({ issue: waveIssue({ pull_request: { url: "..." } }) }),
    approvedOrgs,
  });
  const c = getCheck(result, "issue_has_wave_label");
  assert.equal(c.status, "fail");
  assert.match(c.detail, /pull request, not a Wave issue/);
});

test("Wave label applied AFTER the PR merged -> wave_label_predates_pr_merge fails", async () => {
  const result = await verifyContribution(CANDIDATE, {
    github: fakeGitHubClient({
      pr: mergedPr({ merged_at: "2026-02-01T00:00:00Z" }),
      labeledEvents: [labeledEvent("Wave", "2026-03-01T00:00:00Z")],
    }),
    approvedOrgs,
  });
  const c = getCheck(result, "wave_label_predates_pr_merge");
  assert.equal(c.status, "fail");
  assert.equal((c.evidence.deltaSeconds as number) < 0, true);
});

test("no 'labeled' event on the timeline -> wave_label_predates_pr_merge indeterminate", async () => {
  const result = await verifyContribution(CANDIDATE, {
    github: fakeGitHubClient({ labeledEvents: [] }),
    approvedOrgs,
  });
  assert.equal(getCheck(result, "wave_label_predates_pr_merge").status, "indeterminate");
  assert.equal(result.indeterminate, true);
});

test("PR not linked to the issue -> pr_closes_issue fails", async () => {
  const result = await verifyContribution(CANDIDATE, {
    github: fakeGitHubClient({ closingIssueNumbers: [999] }),
    approvedOrgs,
  });
  const c = getCheck(result, "pr_closes_issue");
  assert.equal(c.status, "fail");
  assert.deepEqual(c.evidence.closingIssueNumbers, [999]);
});

test("closing-issue lookup throws -> pr_closes_issue indeterminate, rest unaffected", async () => {
  const result = await verifyContribution(CANDIDATE, {
    github: fakeGitHubClient({
      throwOn: { getClosingIssueNumbers: new Error("GraphQL 502") },
    }),
    approvedOrgs,
  });
  assert.equal(getCheck(result, "pr_closes_issue").status, "indeterminate");
  assert.equal(getCheck(result, "pr_is_merged").status, "pass");
});

test("PR closed but NOT merged -> pr_is_merged fails, predates-check indeterminate", async () => {
  const result = await verifyContribution(CANDIDATE, {
    github: fakeGitHubClient({
      pr: mergedPr({ merged: false, merged_at: null, merged_by: null, state: "closed" }),
    }),
    approvedOrgs,
  });
  assert.equal(getCheck(result, "pr_is_merged").status, "fail");
  assert.equal(getCheck(result, "wave_label_predates_pr_merge").status, "indeterminate");
  assert.equal(result.attestable, false);
});

test("a 404 on the PR itself propagates (bogus candidate, not five indeterminates)", async () => {
  await assert.rejects(
    verifyContribution(CANDIDATE, {
      github: fakeGitHubClient({ throwOn: { getPullRequest: new Error("GitHub 404") } }),
      approvedOrgs,
    }),
    /404/,
  );
});

test("custom Wave-label matcher (exact allow-list) is honoured", async () => {
  const result = await verifyContribution(CANDIDATE, {
    github: fakeGitHubClient({ issue: waveIssue({ labels: [{ name: "🌊 wave" }] }) }),
    approvedOrgs,
    isWaveLabel: (n) => n === "🌊 wave",
  });
  assert.equal(getCheck(result, "issue_has_wave_label").status, "pass");
});

test("distinct accounts author vs merge -> not flagged", async () => {
  const result = await verifyContribution(CANDIDATE, {
    github: fakeGitHubClient({ pr: mergedPr({ user: ALICE, merged_by: BOB }) }),
    approvedOrgs,
  });
  assert.equal(result.flags.selfMerge.flagged, false);
  assert.equal(result.flags.selfMerge.prAuthorLogin, "alice");
  assert.equal(result.flags.selfMerge.mergedByLogin, "bob");
});
