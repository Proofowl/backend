/**
 * GitHub contribution verification — the five gating checks from the
 * task brief plus the self-merge flag, each independently inspectable
 * (never collapsed into one opaque boolean):
 *
 *   a. repo_in_approved_orgs        — owner is in Wave's approved-orgs list
 *   b. issue_has_wave_label         — the issue carries the Wave label
 *   c. wave_label_predates_pr_merge — label applied-at < PR merged-at
 *   d. pr_closes_issue              — PR is linked to the issue via GitHub's
 *                                     own closing-issue mechanism
 *   e. pr_is_merged                 — PR.merged is true (not merely closed)
 *
 *   flag: selfMerge                 — PR author === the account that merged it
 *
 * A check that cannot be evaluated (upstream unavailable, ambiguous
 * data) is `indeterminate`, not a silent pass/fail. `attestable` is
 * true iff every gating check is `pass`; the self-merge flag never
 * affects it — the caller decides that policy.
 */

import { orgIsApproved, type ApprovedOrgsSource } from "./approvedOrgs.js";
import type { GitHubClient } from "./client.js";
import type {
  CheckOutcome,
  GitHubIssue,
  GitHubLabeledEvent,
  GitHubPullRequest,
  SelfMergeFlag,
  VerificationCandidate,
  VerificationResult,
} from "./types.js";

/** Returns true if a label name is the Stellar Wave label. */
export type WaveLabelMatcher = (labelName: string) => boolean;

/**
 * Default Wave-label matcher. The exact label text on drips.network Wave
 * issues is not pinned in the contracts repo, so this is deliberately
 * permissive (case-insensitive) and overridable. Set `WAVE_LABEL_NAMES`
 * (comma-separated) for an exact allow-list.
 */
export const defaultWaveLabelMatcher: WaveLabelMatcher = (name) => {
  const n = name.trim().toLowerCase();
  return n === "wave" || n === "stellar wave" || n.startsWith("wave:") || n.startsWith("wave ");
};

export function waveLabelMatcherFromNames(names: string[]): WaveLabelMatcher {
  const set = new Set(names.map((n) => n.trim().toLowerCase()).filter(Boolean));
  return (name) => set.has(name.trim().toLowerCase());
}

export interface VerifyDeps {
  github: GitHubClient;
  approvedOrgs: ApprovedOrgsSource;
  isWaveLabel?: WaveLabelMatcher;
}

export async function verifyContribution(
  candidate: VerificationCandidate,
  deps: VerifyDeps,
): Promise<VerificationResult> {
  const isWaveLabel = deps.isWaveLabel ?? defaultWaveLabelMatcher;
  const { owner, repo, issueNumber, prNumber } = candidate;

  // The PR and issue must exist — a 404 here means the candidate itself
  // is bogus, so let it propagate rather than reporting five
  // indeterminate checks.
  const [pr, issue] = await Promise.all([
    deps.github.getPullRequest(owner, repo, prNumber),
    deps.github.getIssue(owner, repo, issueNumber),
  ]);

  const checks: CheckOutcome[] = [
    await checkRepoInApprovedOrgs(owner, deps.approvedOrgs),
    checkIssueHasWaveLabel(issue, isWaveLabel),
    await checkWaveLabelPredatesMerge(candidate, pr, issue, isWaveLabel, deps.github),
    await checkPrClosesIssue(candidate, deps.github),
    checkPrIsMerged(pr),
  ];

  return {
    candidate,
    checks,
    flags: { selfMerge: buildSelfMergeFlag(pr) },
    attestable: checks.every((c) => c.status === "pass"),
    indeterminate: checks.some((c) => c.status === "indeterminate"),
  };
}

// --- a ---------------------------------------------------------------

async function checkRepoInApprovedOrgs(
  owner: string,
  source: ApprovedOrgsSource,
): Promise<CheckOutcome> {
  let snapshot;
  try {
    snapshot = await source.listApprovedOrgs();
  } catch (err) {
    return {
      id: "repo_in_approved_orgs",
      status: "indeterminate",
      detail: `could not fetch Wave approved-orgs list: ${(err as Error).message}`,
      evidence: { owner },
    };
  }
  if (snapshot.status === "indeterminate") {
    return {
      id: "repo_in_approved_orgs",
      status: "indeterminate",
      detail: snapshot.reason,
      evidence: { owner, source: snapshot.source },
    };
  }
  const approved = orgIsApproved(snapshot, owner);
  return {
    id: "repo_in_approved_orgs",
    status: approved ? "pass" : "fail",
    detail: approved
      ? `${owner} is in the Wave approved-orgs list (${snapshot.orgs.length} orgs)`
      : `${owner} is not in the Wave approved-orgs list (${snapshot.orgs.length} orgs)`,
    evidence: {
      owner,
      source: snapshot.source,
      approvedCount: snapshot.orgs.length,
      sample: snapshot.orgs.slice(0, 20),
    },
  };
}

// --- b ---------------------------------------------------------------

function checkIssueHasWaveLabel(issue: GitHubIssue, isWaveLabel: WaveLabelMatcher): CheckOutcome {
  if (issue.pull_request !== undefined) {
    return {
      id: "issue_has_wave_label",
      status: "fail",
      detail: `#${issue.number} is a pull request, not a Wave issue`,
      evidence: { number: issue.number },
    };
  }
  const labels = issue.labels.map((l) => l.name);
  const matched = labels.filter((l) => isWaveLabel(l));
  return {
    id: "issue_has_wave_label",
    status: matched.length > 0 ? "pass" : "fail",
    detail:
      matched.length > 0
        ? `issue #${issue.number} carries Wave label(s): ${matched.join(", ")}`
        : `issue #${issue.number} carries no Wave label (labels: ${labels.join(", ") || "none"})`,
    evidence: { labels, matched },
  };
}

// --- c ---------------------------------------------------------------

async function checkWaveLabelPredatesMerge(
  candidate: VerificationCandidate,
  pr: GitHubPullRequest,
  issue: GitHubIssue,
  isWaveLabel: WaveLabelMatcher,
  github: GitHubClient,
): Promise<CheckOutcome> {
  const base = { issueNumber: issue.number, prNumber: pr.number };

  if (!pr.merged || !pr.merged_at) {
    return {
      id: "wave_label_predates_pr_merge",
      status: "indeterminate",
      detail: "PR has no merge timestamp — cannot compare (see pr_is_merged)",
      evidence: { ...base, prMerged: pr.merged, prMergedAt: pr.merged_at },
    };
  }

  let events: GitHubLabeledEvent[];
  try {
    events = await github.getIssueLabeledEvents(candidate.owner, candidate.repo, issue.number);
  } catch (err) {
    return {
      id: "wave_label_predates_pr_merge",
      status: "indeterminate",
      detail: `could not read issue timeline: ${(err as Error).message}`,
      evidence: base,
    };
  }

  const waveLabelings = events
    .filter((e) => e.event === "labeled" && e.label && isWaveLabel(e.label.name))
    .map((e) => e.created_at)
    .filter((t): t is string => typeof t === "string")
    .sort();
  const firstWaveLabelAt = waveLabelings[0];

  if (!firstWaveLabelAt) {
    return {
      id: "wave_label_predates_pr_merge",
      status: "indeterminate",
      detail:
        "no 'labeled' event for the Wave label found on the issue timeline " +
        "(may predate timeline retention, or the label was applied at issue creation)",
      evidence: { ...base, prMergedAt: pr.merged_at, labeledEventCount: events.length },
    };
  }

  const labelMs = Date.parse(firstWaveLabelAt);
  const mergeMs = Date.parse(pr.merged_at);
  const predates = labelMs < mergeMs;
  return {
    id: "wave_label_predates_pr_merge",
    status: predates ? "pass" : "fail",
    detail: predates
      ? `Wave label applied ${firstWaveLabelAt} — before PR merge ${pr.merged_at}`
      : `Wave label applied ${firstWaveLabelAt} — NOT before PR merge ${pr.merged_at}`,
    evidence: {
      ...base,
      waveLabelAppliedAt: firstWaveLabelAt,
      prMergedAt: pr.merged_at,
      deltaSeconds: Math.round((mergeMs - labelMs) / 1000),
    },
  };
}

// --- d ---------------------------------------------------------------

async function checkPrClosesIssue(
  candidate: VerificationCandidate,
  github: GitHubClient,
): Promise<CheckOutcome> {
  let closing: number[];
  try {
    closing = await github.getClosingIssueNumbers(
      candidate.owner,
      candidate.repo,
      candidate.prNumber,
    );
  } catch (err) {
    return {
      id: "pr_closes_issue",
      status: "indeterminate",
      detail: `could not read PR closing-issue references: ${(err as Error).message}`,
      evidence: { issueNumber: candidate.issueNumber, prNumber: candidate.prNumber },
    };
  }
  const linked = closing.includes(candidate.issueNumber);
  return {
    id: "pr_closes_issue",
    status: linked ? "pass" : "fail",
    detail: linked
      ? `PR #${candidate.prNumber} closes issue #${candidate.issueNumber} (GitHub closing-issue link)`
      : `PR #${candidate.prNumber} is not linked to close issue #${candidate.issueNumber} ` +
        `(closes: ${closing.length ? closing.join(", ") : "none"})`,
    evidence: {
      issueNumber: candidate.issueNumber,
      prNumber: candidate.prNumber,
      closingIssueNumbers: closing,
    },
  };
}

// --- e ---------------------------------------------------------------

function checkPrIsMerged(pr: GitHubPullRequest): CheckOutcome {
  return {
    id: "pr_is_merged",
    status: pr.merged === true ? "pass" : "fail",
    detail:
      pr.merged === true
        ? `PR #${pr.number} is merged (merged_at ${pr.merged_at})`
        : `PR #${pr.number} is not merged (state=${pr.state}, merged=${pr.merged})`,
    evidence: { merged: pr.merged, state: pr.state, mergedAt: pr.merged_at },
  };
}

// --- f (flag, not a check) ---------------------------------------------

function buildSelfMergeFlag(pr: GitHubPullRequest): SelfMergeFlag {
  const prAuthorId = pr.user?.id ?? null;
  const prAuthorLogin = pr.user?.login ?? null;
  const mergedById = pr.merged_by?.id ?? null;
  const mergedByLogin = pr.merged_by?.login ?? null;

  if (mergedById === null) {
    return {
      flagged: false,
      detail: pr.merged
        ? "PR is merged but GitHub reports no merged_by account — self-merge cannot be determined"
        : "PR is not merged — no merge actor to compare",
      prAuthorLogin,
      prAuthorId,
      mergedByLogin,
      mergedById,
    };
  }
  const flagged = mergedById === prAuthorId;
  return {
    flagged,
    detail: flagged
      ? `self-merge: ${prAuthorLogin} (id ${prAuthorId}) authored and merged PR #${pr.number}`
      : `not a self-merge: authored by ${prAuthorLogin}, merged by ${mergedByLogin}`,
    prAuthorLogin,
    prAuthorId,
    mergedByLogin,
    mergedById,
  };
}

export { getCheck } from "./types.js";
