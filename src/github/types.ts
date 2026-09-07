/**
 * Minimal typed views of the GitHub REST/GraphQL shapes this service
 * reads, plus the verification-result model.
 *
 * Only the fields the six checks actually use are modelled — these are
 * deliberately loose (`| null | undefined`) because they mirror
 * untrusted upstream JSON.
 */

// --- upstream shapes (subset) -----------------------------------------

export interface GitHubUserRef {
  /** Immutable numeric id — what identifier-spec-v1 §1.1 hashes. */
  id: number;
  login: string;
}

export interface GitHubLabelRef {
  name: string;
}

/** Subset of `GET /repos/{owner}/{repo}/pulls/{n}`. */
export interface GitHubPullRequest {
  number: number;
  state: "open" | "closed";
  /** True only for a genuinely merged PR — not just `state === "closed"`. */
  merged: boolean;
  merged_at: string | null;
  /** The account GitHub records as having merged the PR. `null` if unmerged. */
  merged_by: GitHubUserRef | null;
  user: GitHubUserRef;
  base: { repo: { full_name: string; owner: GitHubUserRef; name: string } };
  html_url: string;
}

/** Subset of `GET /repos/{owner}/{repo}/issues/{n}`. */
export interface GitHubIssue {
  number: number;
  state: "open" | "closed";
  labels: GitHubLabelRef[];
  /** Present on an issue, absent/undefined on a PR returned by the issues API. */
  pull_request?: unknown;
  html_url: string;
}

/**
 * Subset of a `labeled` entry from
 * `GET /repos/{owner}/{repo}/issues/{n}/timeline`.
 */
export interface GitHubLabeledEvent {
  event: "labeled" | string;
  created_at: string;
  label?: GitHubLabelRef;
  actor?: GitHubUserRef;
}

// --- verification model ---------------------------------------------

export interface VerificationCandidate {
  owner: string;
  repo: string;
  /** The Stellar Wave issue the contribution claims to resolve. */
  issueNumber: number;
  prNumber: number;
}

export type CheckId =
  | "repo_in_approved_orgs"
  | "issue_has_wave_label"
  | "wave_label_predates_pr_merge"
  | "pr_closes_issue"
  | "pr_is_merged";

export type CheckStatus = "pass" | "fail" | "indeterminate";

export interface CheckOutcome {
  id: CheckId;
  status: CheckStatus;
  /** One-line human summary of why this status. */
  detail: string;
  /** Raw values the decision was made from, for audit / debugging. */
  evidence: Record<string, unknown>;
}

/**
 * Self-merge is reported as a **flag**, never folded into pass/fail —
 * the caller decides policy (reject vs. attest-but-mark), per the task
 * brief and ADR 0005's "record facts, let consumers weight them".
 */
export interface SelfMergeFlag {
  flagged: boolean;
  detail: string;
  prAuthorLogin: string | null;
  prAuthorId: number | null;
  mergedByLogin: string | null;
  mergedById: number | null;
}

export interface VerificationResult {
  candidate: VerificationCandidate;
  /** The five gating checks, each independently inspectable. */
  checks: CheckOutcome[];
  flags: {
    selfMerge: SelfMergeFlag;
  };
  /** True iff every gating check is `pass`. Flags do NOT affect this. */
  attestable: boolean;
  /** True if any gating check is `indeterminate` (upstream unavailable / ambiguous). */
  indeterminate: boolean;
}

export function getCheck(result: VerificationResult, id: CheckId): CheckOutcome {
  const c = result.checks.find((x) => x.id === id);
  if (!c) throw new Error(`no such check ${id}`);
  return c;
}
