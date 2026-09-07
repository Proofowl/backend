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

test("case 2: live unavailable + repo IS on the allowlist -> pass, marked manually-asserted", async () => {
  const result = await verifyContribution(CANDIDATE, {
    github: fakeGitHubClient(),
    approvedOrgs: liveUnavailable,
    approvedOrgsAllowlist: allowlistWithCandidate(),
  });
  const check = getCheck(result, "repo_in_approved_orgs");
  assert.equal(check.status, "pass");
  assert.equal(check.confidence, "manually-asserted-allowlist");

  // provenance is in the RETURNED data, not just a log
  assert.match(check.detail, /NOT independently verified/);
  assert.match(check.detail, /asserted by test operator on 2026-09-07/);
  assert.match(check.detail, /evidence https:\/\/github\.com\/stellar\/soroban-examples/);
  assert.deepEqual(check.evidence.assertion, {
    repo: "stellar/soroban-examples",
    assertedBy: "test operator",
    assertedAt: "2026-09-07",
    evidenceUrl: "https://github.com/stellar/soroban-examples",
    note: "seed for tests",
  });
  assert.equal(check.evidence.decidedBy, "operator-allowlist");
  assert.equal(check.evidence.liveSourceStatus, "indeterminate");

  // a manually-asserted pass still lets the whole result be attestable
  assert.equal(result.attestable, true);
  assert.equal(result.indeterminate, false);
});

test("case 3: live unavailable + repo NOT on the allowlist -> indeterminate (not yet reviewed, not rejected)", async () => {
  const result = await verifyContribution(
    { ...CANDIDATE, owner: "randouser", repo: "randorepo" },
    {
      github: fakeGitHubClient(),
      approvedOrgs: liveUnavailable,
      approvedOrgsAllowlist: allowlistWithCandidate(), // only has stellar/soroban-examples
    },
  );
  const check = getCheck(result, "repo_in_approved_orgs");
  assert.equal(check.status, "indeterminate");
  // marker kept, so downstream can still tell this apart from case 4
  assert.equal(check.confidence, "operator-allowlist-absent");
  assert.match(
    check.detail,
    /not yet on the operator-asserted approved-orgs allowlist \(1 entry\)/,
  );
  assert.match(
    check.detail,
    /does not mean the repo is rejected, only that no operator has reviewed it yet/,
  );
  assert.doesNotMatch(check.detail, /decisive/i);
  assert.equal(check.evidence.decidedBy, "operator-allowlist");
  assert.equal(check.evidence.allowlistEntryCount, 1);
  // the bug fix: an unlisted repo is now a "maybe", so it blocks attestable
  // via indeterminate, not via a false rejection.
  assert.equal(result.attestable, false);
  assert.equal(result.indeterminate, true, "an unreviewed repo is a maybe, not a no");
});

test("live unavailable + allowlist file present but MALFORMED -> indeterminate, loudly", async () => {
  const brokenAllowlist = {
    async load(): Promise<never> {
      throw new Error("approved-orgs allowlist at /x is not valid JSON: Unexpected token");
    },
  };
  const result = await verifyContribution(CANDIDATE, {
    github: fakeGitHubClient(),
    approvedOrgs: liveUnavailable,
    approvedOrgsAllowlist: brokenAllowlist,
  });
  const check = getCheck(result, "repo_in_approved_orgs");
  assert.equal(check.status, "indeterminate");
  assert.match(check.detail, /operator allowlist is unusable/);
  assert.match(String(check.evidence.allowlistError), /not valid JSON/);
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
