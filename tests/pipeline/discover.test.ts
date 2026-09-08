import { test } from "node:test";
import assert from "node:assert/strict";

import type {
  GitHubClient,
  ListRepoIssuesOptions,
  LinkedPullRequest,
} from "../../src/github/client.js";
import type { GitHubIssue } from "../../src/github/types.js";
import { waveLabelMatcherFromNames } from "../../src/github/verify.js";
import { discoverCandidates, discoveryLabelConfig } from "../../src/pipeline/discover.js";
import { createCollectingLogger } from "../../src/pipeline/log.js";
import type { SeedRepo } from "../../src/pipeline/seed.js";

function seed(ownerRepo: string): SeedRepo {
  const [owner, repo] = ownerRepo.split("/");
  return { owner: owner!, repo: repo!, ownerRepo };
}

function issue(number: number, labels: string[], extra: Partial<GitHubIssue> = {}): GitHubIssue {
  return {
    number,
    state: "closed",
    labels: labels.map((name) => ({ name })),
    html_url: `https://github.com/o/r/issues/${number}`,
    ...extra,
  };
}

interface RepoData {
  issues: GitHubIssue[];
  linked: Record<number, LinkedPullRequest[]>;
}

/** A GitHubClient mock that dispatches by `${owner}/${repo}`. */
function mockClient(
  repos: Record<string, RepoData>,
  opts: { throwListFor?: string; throwLinkedFor?: string } = {},
): { client: GitHubClient; listCalls: Array<{ repo: string; options?: ListRepoIssuesOptions }> } {
  const listCalls: Array<{ repo: string; options?: ListRepoIssuesOptions }> = [];
  const client: GitHubClient = {
    getPullRequest: () => {
      throw new Error("unused");
    },
    getIssue: () => {
      throw new Error("unused");
    },
    getIssueLabeledEvents: () => {
      throw new Error("unused");
    },
    getClosingIssueNumbers: () => {
      throw new Error("unused");
    },
    async listRepoIssues(owner, repo, options) {
      const key = `${owner}/${repo}`;
      listCalls.push({ repo: key, options });
      if (opts.throwListFor === key) throw new Error(`boom listing ${key}`);
      return repos[key]?.issues ?? [];
    },
    async getIssueLinkedPullRequests(owner, repo, issueNumber) {
      const key = `${owner}/${repo}`;
      if (opts.throwLinkedFor === key) throw new Error(`boom linked ${key}`);
      return repos[key]?.linked[issueNumber] ?? [];
    },
  };
  return { client, listCalls };
}

test("happy path: a Wave issue with one merged linked PR -> one candidate", async () => {
  const { client } = mockClient({
    "stellar/soroban-examples": {
      issues: [issue(7, ["bug", "Wave"])],
      linked: { 7: [{ number: 42, merged: true }] },
    },
  });
  const res = await discoverCandidates({
    github: client,
    seeds: [seed("stellar/soroban-examples")],
  });
  assert.deepEqual(res.candidates, [
    { owner: "stellar", repo: "soroban-examples", issueNumber: 7, prNumber: 42 },
  ]);
  assert.equal(res.stats.waveIssues, 1);
  assert.equal(res.stats.reposErrored, 0);
});

test("issues without a Wave label are skipped", async () => {
  const { client } = mockClient({
    "o/r": { issues: [issue(1, ["bug"]), issue(2, ["enhancement"])], linked: {} },
  });
  const res = await discoverCandidates({ github: client, seeds: [seed("o/r")] });
  assert.deepEqual(res.candidates, []);
  assert.equal(res.stats.issuesScanned, 2);
  assert.equal(res.stats.waveIssues, 0);
});

test("a Wave issue whose linked PR is not merged yields no candidate", async () => {
  const { client } = mockClient({
    "o/r": { issues: [issue(3, ["Wave"])], linked: { 3: [{ number: 9, merged: false }] } },
  });
  const res = await discoverCandidates({ github: client, seeds: [seed("o/r")] });
  assert.deepEqual(res.candidates, []);
  assert.equal(res.stats.waveIssuesWithoutMergedPr, 1);
});

test("a Wave issue with no linked PRs yields no candidate", async () => {
  const { client } = mockClient({ "o/r": { issues: [issue(4, ["Wave"])], linked: {} } });
  const res = await discoverCandidates({ github: client, seeds: [seed("o/r")] });
  assert.deepEqual(res.candidates, []);
  assert.equal(res.stats.waveIssuesWithoutMergedPr, 1);
});

test("multiple merged PRs on one issue -> one candidate each; duplicates collapse", async () => {
  const { client } = mockClient({
    "o/r": {
      issues: [issue(5, ["Wave"]), issue(5, ["Wave"])], // same issue listed twice
      linked: {
        5: [
          { number: 10, merged: true },
          { number: 11, merged: true },
          { number: 12, merged: false },
        ],
      },
    },
  });
  const res = await discoverCandidates({ github: client, seeds: [seed("o/r")] });
  assert.deepEqual(
    res.candidates.map((c) => c.prNumber).sort((a, b) => a - b),
    [10, 11],
  );
});

test("maxIssuesPerRepo and the label prefilter reach the client", async () => {
  const { client, listCalls } = mockClient({ "o/r": { issues: [], linked: {} } });
  await discoverCandidates({
    github: client,
    seeds: [seed("o/r")],
    maxIssuesPerRepo: 33,
    labelPrefilter: ["Wave"],
  });
  assert.equal(listCalls[0]!.options?.maxIssues, 33);
  assert.equal(listCalls[0]!.options?.state, "closed");
  assert.deepEqual(listCalls[0]!.options?.labels, ["Wave"]);
});

test("a repo whose issue list errors is logged and skipped; other seeds still run", async () => {
  const { client } = mockClient(
    {
      "o/bad": { issues: [], linked: {} },
      "o/good": { issues: [issue(1, ["Wave"])], linked: { 1: [{ number: 2, merged: true }] } },
    },
    { throwListFor: "o/bad" },
  );
  const logger = createCollectingLogger();
  const res = await discoverCandidates({
    github: client,
    seeds: [seed("o/bad"), seed("o/good")],
    logger,
  });
  assert.equal(res.stats.reposErrored, 1);
  assert.deepEqual(
    res.candidates.map((c) => c.prNumber),
    [2],
  );
  assert.equal(logger.byEvent("discovery.repo_error").length, 1);
});

test("a linked-PR lookup error is logged and skips just that issue", async () => {
  const { client } = mockClient(
    {
      "o/r": {
        issues: [issue(1, ["Wave"]), issue(2, ["Wave"])],
        linked: { 2: [{ number: 22, merged: true }] },
      },
    },
    { throwLinkedFor: "o/r" },
  );
  const logger = createCollectingLogger();
  const res = await discoverCandidates({ github: client, seeds: [seed("o/r")], logger });
  // both issues hit the throwing lookup -> no candidates, two error logs
  assert.deepEqual(res.candidates, []);
  assert.equal(logger.byEvent("discovery.linked_pr_error").length, 2);
});

test("PR rows in the issue list (pull_request present) are ignored", async () => {
  const { client } = mockClient({
    "o/r": {
      issues: [issue(1, ["Wave"], { pull_request: { url: "…" } })],
      linked: { 1: [{ number: 5, merged: true }] },
    },
  });
  const res = await discoverCandidates({ github: client, seeds: [seed("o/r")] });
  assert.deepEqual(res.candidates, []);
  assert.equal(res.stats.issuesScanned, 0);
});

test("a custom (exact-name) matcher is honoured", async () => {
  const { client } = mockClient({
    "o/r": {
      issues: [issue(1, ["wave"]), issue(2, ["Stellar Wave"])],
      linked: { 1: [{ number: 5, merged: true }], 2: [{ number: 6, merged: true }] },
    },
  });
  const res = await discoverCandidates({
    github: client,
    seeds: [seed("o/r")],
    isWaveLabel: waveLabelMatcherFromNames(["Stellar Wave"]),
  });
  assert.deepEqual(
    res.candidates.map((c) => c.prNumber),
    [6],
  );
});

test("discoveryLabelConfig: names set vs unset", () => {
  const withNames = discoveryLabelConfig(["Wave", "Stellar Wave"]);
  assert.deepEqual(withNames.labelPrefilter, ["Wave", "Stellar Wave"]);
  assert.equal(withNames.isWaveLabel("Stellar Wave"), true);
  assert.equal(withNames.isWaveLabel("wave:foo"), false);

  const unset = discoveryLabelConfig(undefined);
  assert.equal(unset.labelPrefilter, undefined);
  assert.equal(unset.isWaveLabel("wave:foo"), true); // permissive default
});
