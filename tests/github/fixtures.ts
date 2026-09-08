/**
 * MOCKED GitHub API responses, modelled on the real REST API v3
 * (`GET /repos/.../pulls/{n}`, `.../issues/{n}`, `.../issues/{n}/timeline`)
 * and the GraphQL `closingIssuesReferences` connection. Field subsets
 * only — enough to drive every branch of src/github/verify.ts.
 *
 * We use fixtures (not live PRs) so the suite is deterministic, needs no
 * token, and runs offline in CI. The one live path (a real read against
 * the deployed contract) is the on-chain integration test, not this.
 */

import type { GitHubClient } from "../../src/github/client.js";
import type { GitHubIssue, GitHubLabeledEvent, GitHubPullRequest } from "../../src/github/types.js";

export const ALICE = { id: 1001, login: "alice" };
export const BOB = { id: 1002, login: "bob" };

export function mergedPr(overrides: Partial<GitHubPullRequest> = {}): GitHubPullRequest {
  return {
    number: 42,
    state: "closed",
    merged: true,
    merged_at: "2026-03-10T12:00:00Z",
    merged_by: BOB,
    user: ALICE,
    base: {
      repo: {
        full_name: "stellar/soroban-examples",
        owner: { id: 9, login: "stellar" },
        name: "soroban-examples",
      },
    },
    html_url: "https://github.com/stellar/soroban-examples/pull/42",
    ...overrides,
  };
}

export function waveIssue(overrides: Partial<GitHubIssue> = {}): GitHubIssue {
  return {
    number: 7,
    state: "closed",
    labels: [{ name: "bug" }, { name: "Wave" }],
    html_url: "https://github.com/stellar/soroban-examples/issues/7",
    ...overrides,
  };
}

export function labeledEvent(name: string, createdAt: string, actor = BOB): GitHubLabeledEvent {
  return { event: "labeled", created_at: createdAt, label: { name }, actor };
}

export interface FakeGitHubOptions {
  pr?: GitHubPullRequest;
  issue?: GitHubIssue;
  labeledEvents?: GitHubLabeledEvent[];
  closingIssueNumbers?: number[];
  /** Issues returned by `listRepoIssues` (defaults to `[issue]`). */
  repoIssues?: GitHubIssue[];
  /** Make a specific method throw, to exercise the indeterminate branches. */
  throwOn?: Partial<Record<keyof GitHubClient, Error>>;
}

/** An in-memory GitHubClient backed by fixtures. */
export function fakeGitHubClient(opts: FakeGitHubOptions = {}): GitHubClient {
  const pr = opts.pr ?? mergedPr();
  const issue = opts.issue ?? waveIssue();
  const events = opts.labeledEvents ?? [labeledEvent("Wave", "2026-02-01T09:00:00Z")];
  const closing = opts.closingIssueNumbers ?? [issue.number];
  const repoIssues = opts.repoIssues ?? [issue];
  const maybeThrow = (m: keyof GitHubClient) => {
    const e = opts.throwOn?.[m];
    if (e) throw e;
  };
  return {
    async getPullRequest() {
      maybeThrow("getPullRequest");
      return pr;
    },
    async getIssue() {
      maybeThrow("getIssue");
      return issue;
    },
    async getIssueLabeledEvents() {
      maybeThrow("getIssueLabeledEvents");
      return events;
    },
    async getClosingIssueNumbers() {
      maybeThrow("getClosingIssueNumbers");
      return closing;
    },
    async listRepoIssues() {
      maybeThrow("listRepoIssues");
      return repoIssues;
    },
  };
}
