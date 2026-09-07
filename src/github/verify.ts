/**
 * GitHub contribution verification — the five gating checks from the
 * task brief plus the self-merge flag, each independently inspectable
 * (never collapsed into one opaque boolean):
 *
 *   a. repo_in_approved_orgs        — owner is in Wave's approved-orgs list
 *                                     (live source first; falls back to an
 *                                     operator-asserted allowlist — see
 *                                     checkRepoInApprovedOrgs below)
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

import {
  orgIsApproved,
  type ApprovedOrgsSnapshot,
  type ApprovedOrgsSource,
} from "./approvedOrgs.js";
import type { ApprovedOrgsAllowlistSource } from "./approvedOrgsAllowlistSource.js";
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
  /**
   * Operator-asserted fallback allowlist, consulted ONLY when
   * `approvedOrgs` is unavailable (indeterminate / errored). Omit it for
   * "no allowlist configured" — `repo_in_approved_orgs` then stays
   * `indeterminate` on a live-source failure, exactly as before this
   * fallback existed.
   */
  approvedOrgsAllowlist?: ApprovedOrgsAllowlistSource;
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
    await checkRepoInApprovedOrgs({ owner, repo }, deps.approvedOrgs, deps.approvedOrgsAllowlist),
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

/**
 * Layered:
 *  1. live Wave source (`approvedOrgs`) — if it returns a real list,
 *     `pass`/`fail` come from it, exactly as before, with no
 *     `confidence` marker.
 *  2. live source unavailable + an allowlist is configured:
 *       - repo present  -> `pass`, `confidence: "manually-asserted-allowlist"`,
 *         with assertedBy/assertedAt/evidenceUrl inline in `detail` and
 *         `evidence.assertion`;
 *       - repo absent    -> `fail`, `confidence: "operator-allowlist-absent"`
 *         (a curated set's absence is a decisive no).
 *  3. live source unavailable + no allowlist configured -> `indeterminate`,
 *     unchanged from before this fallback existed.
 *
 * The live path is never removed or weakened — it is always tried first.
 */
async function checkRepoInApprovedOrgs(
  target: { owner: string; repo: string },
  liveSource: ApprovedOrgsSource,
  allowlistSource: ApprovedOrgsAllowlistSource | undefined,
): Promise<CheckOutcome> {
  const { owner } = target;
  const ownerRepo = `${owner}/${target.repo}`.toLowerCase();

  // --- 1. live Wave source (tried first, unchanged) ---
  let liveSnapshot: ApprovedOrgsSnapshot | undefined;
  let liveErrorMessage: string | undefined;
  try {
    liveSnapshot = await liveSource.listApprovedOrgs();
  } catch (err) {
    liveErrorMessage = (err as Error).message;
  }

  if (liveSnapshot?.status === "ok") {
    const approved = orgIsApproved(liveSnapshot, owner);
    return {
      id: "repo_in_approved_orgs",
      status: approved ? "pass" : "fail",
      detail: approved
        ? `${owner} is in the Wave approved-orgs list (${liveSnapshot.orgs.length} orgs)`
        : `${owner} is not in the Wave approved-orgs list (${liveSnapshot.orgs.length} orgs)`,
      evidence: {
        owner,
        source: liveSnapshot.source,
        approvedCount: liveSnapshot.orgs.length,
        sample: liveSnapshot.orgs.slice(0, 20),
      },
    };
  }

  // Live source is unavailable — capture why for the evidence trail.
  const liveSourceStatus: "indeterminate" | "error" = liveSnapshot ? "indeterminate" : "error";
  const liveSourceReason =
    liveSnapshot?.status === "indeterminate"
      ? liveSnapshot.reason
      : `could not fetch Wave approved-orgs list: ${liveErrorMessage ?? "unknown error"}`;
  const liveInfo = { liveSourceStatus, liveSourceReason };

  // --- 3. no allowlist configured -> indeterminate (unchanged path) ---
  if (!allowlistSource) {
    return {
      id: "repo_in_approved_orgs",
      status: "indeterminate",
      detail: liveSourceReason,
      evidence: { owner, ...liveInfo },
    };
  }

  // --- 2. operator-asserted allowlist fallback ---
  let allowlist;
  try {
    allowlist = await allowlistSource.load();
  } catch (err) {
    return {
      id: "repo_in_approved_orgs",
      status: "indeterminate",
      detail:
        `Wave live source unavailable, and the operator allowlist is unusable: ` +
        `${(err as Error).message}`,
      evidence: { owner, repo: ownerRepo, allowlistError: (err as Error).message, ...liveInfo },
    };
  }

  if (!allowlist) {
    // File absent — same as "no allowlist configured".
    return {
      id: "repo_in_approved_orgs",
      status: "indeterminate",
      detail: liveSourceReason,
      evidence: { owner, ...liveInfo },
    };
  }

  const entry = allowlist.find(ownerRepo);
  if (entry) {
    return {
      id: "repo_in_approved_orgs",
      status: "pass",
      confidence: "manually-asserted-allowlist",
      detail:
        `${ownerRepo} is on the operator-asserted approved-orgs allowlist ` +
        `(NOT independently verified): asserted by ${entry.assertedBy} on ${entry.assertedAt}, ` +
        `evidence ${entry.evidenceUrl}. Live Wave source was ${liveSourceStatus} ` +
        `(${liveSourceReason}).`,
      evidence: {
        owner,
        repo: ownerRepo,
        decidedBy: "operator-allowlist",
        allowlistSource: allowlist.source,
        assertion: {
          repo: entry.repo,
          assertedBy: entry.assertedBy,
          assertedAt: entry.assertedAt,
          evidenceUrl: entry.evidenceUrl,
          ...(entry.note !== undefined ? { note: entry.note } : {}),
        },
        ...liveInfo,
      },
    };
  }

  const n = allowlist.entries.length;
  return {
    id: "repo_in_approved_orgs",
    status: "fail",
    confidence: "operator-allowlist-absent",
    detail:
      `${ownerRepo} is NOT on the operator-asserted approved-orgs allowlist ` +
      `(${n} entr${n === 1 ? "y" : "ies"}); the live Wave source was ${liveSourceStatus} ` +
      `(${liveSourceReason}). Absence from a curated list is a decisive no.`,
    evidence: {
      owner,
      repo: ownerRepo,
      decidedBy: "operator-allowlist",
      allowlistSource: allowlist.source,
      allowlistEntryCount: n,
      ...liveInfo,
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
