/**
 * Offline unit tests for the pipeline orchestrator (`runOnce`).
 *
 * NO network, NO real key material, NO database. The three I/O
 * boundaries are fakes:
 *   - the queue (an in-memory `Map` implementing `RunOnceQueue`),
 *   - the chain reads (`getWalletForGithubIdHash` only),
 *   - `submitAttestation` and `verifyContribution` (injected `submit` /
 *     `verify` seams returning canned results).
 *
 * The live, 2-transaction exercise is `runOnce.integration.test.ts`.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import type { AttestationSubmitter } from "../../src/chain/submit.js";
import { TESTNET_NETWORK_PASSPHRASE } from "../../src/chain/submit.js";
import type { ChainReadClient } from "../../src/chain/readClient.js";
import type {
  GitHubClient,
  LinkedPullRequest,
  ListRepoIssuesOptions,
} from "../../src/github/client.js";
import type {
  GitHubIssue,
  VerificationCandidate,
  VerificationResult,
} from "../../src/github/types.js";
import {
  hashGitHubPullRequestV1Hex,
  hashGitHubUserIdV1Hex,
} from "../../src/hashing/identifiers.js";
import type { PendingContributionRow, EnqueueInput } from "../../src/queue/repository.js";
import { PENDING_STATUS } from "../../src/queue/status.js";
import { createCollectingLogger } from "../../src/pipeline/log.js";
import {
  runOnce,
  type RunOnceDeps,
  type RunOnceQueue,
  type SubmitFn,
} from "../../src/pipeline/runOnce.js";
import type { SubmitAttestationResult } from "../../src/chain/submit.js";

// --- fixtures ----------------------------------------------------------

const WALLET = "GCNHX5ORRQLJOFQELVAXZ3PQMIAQ3B3QLKZQRV6FXGICZEMQRWY3TRKG";
const AUTHOR_ID = 4242042;

function candidate(over: Partial<VerificationCandidate> = {}): VerificationCandidate {
  return { owner: "stellar", repo: "soroban-examples", issueNumber: 7, prNumber: 42, ...over };
}

function prHashOf(c: VerificationCandidate): string {
  return hashGitHubPullRequestV1Hex(c.owner, c.repo, c.prNumber);
}

/** A VerificationResult for `c`; attestable unless `failing`/`indeterminate` say otherwise. */
function verification(
  c: VerificationCandidate,
  over: { failing?: string[]; indeterminate?: string[]; authorId?: number | null } = {},
): VerificationResult {
  const ids = [
    "repo_in_approved_orgs",
    "issue_has_wave_label",
    "wave_label_predates_pr_merge",
    "pr_closes_issue",
    "pr_is_merged",
  ] as const;
  const failing = new Set(over.failing ?? []);
  const indeterminate = new Set(over.indeterminate ?? []);
  const checks = ids.map((id) => ({
    id,
    status: failing.has(id)
      ? ("fail" as const)
      : indeterminate.has(id)
        ? ("indeterminate" as const)
        : ("pass" as const),
    detail: "",
    evidence: {},
  }));
  const authorId = over.authorId === undefined ? AUTHOR_ID : over.authorId;
  return {
    candidate: c,
    checks,
    flags: {
      selfMerge: {
        flagged: false,
        detail: "",
        prAuthorLogin: authorId === null ? null : "octo",
        prAuthorId: authorId,
        mergedByLogin: "maint",
        mergedById: 99,
      },
    },
    attestable: failing.size === 0 && indeterminate.size === 0,
    indeterminate: indeterminate.size > 0,
  };
}

// --- fake queue ------------------------------------------------------

interface FakeQueue {
  queue: RunOnceQueue;
  rows: Map<string, PendingContributionRow>;
  calls: Array<{ method: string; prHash?: string }>;
}

function row(over: Partial<PendingContributionRow> & { prHash: string }): PendingContributionRow {
  const now = new Date("2026-01-01T00:00:00Z");
  return {
    id: `id-${over.prHash.slice(0, 6)}`,
    githubIdHash: hashGitHubUserIdV1Hex(AUTHOR_ID),
    githubUserId: String(AUTHOR_ID),
    repo: "stellar/soroban-examples",
    prNumber: 42,
    issueId: 7n,
    complexity: 0,
    status: PENDING_STATUS.WAITING_FOR_WALLET_LINK,
    statusNote: "enqueued",
    selfMergeFlagged: false,
    attemptCount: 0,
    lastCheckedAt: null,
    createdAt: now,
    updatedAt: now,
    verification: verification(candidate()),
    ...over,
  };
}

function fakeQueue(seed: PendingContributionRow[] = []): FakeQueue {
  const rows = new Map(seed.map((r) => [r.prHash, r]));
  const calls: FakeQueue["calls"] = [];
  const must = (prHash: string): PendingContributionRow => {
    const r = rows.get(prHash);
    if (!r) throw new Error(`fake queue: no row for ${prHash}`);
    return r;
  };
  const queue: RunOnceQueue = {
    async listWaiting(limit = 100) {
      calls.push({ method: "listWaiting" });
      return [...rows.values()]
        .filter((r) => r.status === PENDING_STATUS.WAITING_FOR_WALLET_LINK)
        .sort((a, b) => +a.createdAt - +b.createdAt)
        .slice(0, limit);
    },
    async getByPrHash(prHash) {
      calls.push({ method: "getByPrHash", prHash });
      return rows.get(prHash) ?? null;
    },
    async enqueue(input: EnqueueInput) {
      calls.push({ method: "enqueue", prHash: input.prHash });
      const existing = rows.get(input.prHash);
      const now = new Date();
      const r: PendingContributionRow = {
        id: existing?.id ?? `id-${input.prHash.slice(0, 6)}`,
        prHash: input.prHash,
        githubIdHash: input.githubIdHash,
        githubUserId: input.githubUserId,
        repo: input.repo,
        prNumber: input.prNumber,
        issueId: input.issueId ?? 0n,
        complexity: input.complexity ?? 0,
        status: PENDING_STATUS.WAITING_FOR_WALLET_LINK,
        statusNote: "enqueued",
        selfMergeFlagged: input.selfMergeFlagged ?? false,
        attemptCount: existing?.attemptCount ?? 0,
        lastCheckedAt: existing?.lastCheckedAt ?? null,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
        verification: input.verification,
      };
      rows.set(input.prHash, r);
      return r;
    },
    async markAlreadyAttested(prHash, note = "already recorded on-chain") {
      calls.push({ method: "markAlreadyAttested", prHash });
      const updated = {
        ...must(prHash),
        status: PENDING_STATUS.ALREADY_ATTESTED,
        statusNote: note,
      };
      rows.set(prHash, updated);
      return updated;
    },
    async recordCheckAttempt(prHash, note) {
      calls.push({ method: "recordCheckAttempt", prHash });
      const r = must(prHash);
      const updated = {
        ...r,
        attemptCount: r.attemptCount + 1,
        lastCheckedAt: new Date(),
        statusNote: note ?? r.statusNote,
      };
      rows.set(prHash, updated);
      return updated;
    },
    async dismiss(prHash, note) {
      calls.push({ method: "dismiss", prHash });
      const updated = { ...must(prHash), status: PENDING_STATUS.DISMISSED, statusNote: note };
      rows.set(prHash, updated);
      return updated;
    },
  };
  return { queue, rows, calls };
}

// --- fake chain reads + submitter ----------------------------------

function fakeReads(walletFor: (idHash: string) => string | null): ChainReadClient {
  return {
    getWalletForGithubIdHash: async (idHash: string | Uint8Array) =>
      walletFor(typeof idHash === "string" ? idHash : Buffer.from(idHash).toString("hex")),
  } as unknown as ChainReadClient;
}

const NEVER_LINKED = fakeReads(() => null);
const ALWAYS_LINKED = fakeReads(() => WALLET);

const STUB_SUBMITTER: AttestationSubmitter = {
  network: TESTNET_NETWORK_PASSPHRASE,
  prepare: async () => {
    throw new Error("submitter.prepare must not be called — `submit` is stubbed");
  },
};

const SPENDS_ATTEMPT = new Set<SubmitAttestationResult["kind"]>(["submitted", "submission-failed"]);

/** A `submit` seam that returns `results[i]` for call i (last one repeats). */
function submitReturning(...results: SubmitAttestationResult[]): {
  fn: SubmitFn;
  inputs: Parameters<SubmitFn>[0][];
} {
  const inputs: Parameters<SubmitFn>[0][] = [];
  let i = 0;
  const fn: SubmitFn = async (input, deps) => {
    inputs.push(input);
    const r = results[Math.min(i, results.length - 1)] ?? {
      kind: "rpc-error",
      during: "prepare",
      detail: "no stub",
    };
    i += 1;
    if (input.dryRun !== true && SPENDS_ATTEMPT.has(r.kind)) {
      deps.onSubmissionAttempt?.({
        prHashHex: "ph",
        githubIdHashHex: "gh",
        repo: "stellar/soroban-examples",
        prNumber: 42,
      });
    }
    return r;
  };
  return { fn, inputs };
}

// --- result factories --------------------------------------------

const submittedResult = (
  c: VerificationCandidate,
  txHash = "tx-deadbeef",
): SubmitAttestationResult => ({
  kind: "submitted",
  txHash,
  ledger: 4_600_000,
  creditedWallet: WALLET,
  prHashHex: prHashOf(c),
  githubIdHashHex: hashGitHubUserIdV1Hex(AUTHOR_ID),
  repo: `${c.owner}/${c.repo}`,
  prNumber: c.prNumber,
  complexity: 0,
});

const alreadyAttestedResult = (c: VerificationCandidate): SubmitAttestationResult => ({
  kind: "already-attested",
  prHashHex: prHashOf(c),
  githubIdHashHex: hashGitHubUserIdV1Hex(AUTHOR_ID),
  linkedWallet: WALLET,
  match: {
    githubIdHashHex: hashGitHubUserIdV1Hex(AUTHOR_ID),
    repo: `${c.owner}/${c.repo}`,
    prNumber: c.prNumber,
    issueId: BigInt(c.issueNumber),
    complexity: 0,
    prHashHex: prHashOf(c),
    timestamp: 1_788_000_000n,
    sequence: 0,
  },
});

const notSubmittableResult = (c: VerificationCandidate): SubmitAttestationResult => ({
  kind: "not-submittable",
  reason: "wallet-not-linked",
  prHashHex: prHashOf(c),
  githubIdHashHex: hashGitHubUserIdV1Hex(AUTHOR_ID),
});

const contractRejectedResult = (): SubmitAttestationResult => ({
  kind: "contract-rejected",
  phase: "simulation",
  errorCode: 6,
  errorName: "DuplicateAttestation",
  detail: "HostError: Error(Contract, #6)",
});

const submissionFailedResult = (): SubmitAttestationResult => ({
  kind: "submission-failed",
  stage: "send",
  txHash: "tx-err",
  status: "ERROR",
  detail: "rejected at submission",
});

const rpcErrorResult = (): SubmitAttestationResult => ({
  kind: "rpc-error",
  during: "send",
  detail: "socket hang up",
});

const dryRunOkResult = (c: VerificationCandidate): SubmitAttestationResult => ({
  kind: "dry-run-ok",
  prHashHex: prHashOf(c),
  githubIdHashHex: hashGitHubUserIdV1Hex(AUTHOR_ID),
  repo: `${c.owner}/${c.repo}`,
  prNumber: c.prNumber,
  complexity: 0,
  simulatedCreditWallet: WALLET,
  minResourceFee: "12345",
});

// --- fake GitHub client for discovery -----------------------------

/** One issue + one merged linked PR per candidate, so `discoverCandidates` emits exactly them. */
function githubYielding(
  candidates: VerificationCandidate[],
  opts: { merged?: boolean } = {},
): { client: GitHubClient; listCalls: string[] } {
  const merged = opts.merged ?? true;
  const byRepo = new Map<string, VerificationCandidate[]>();
  for (const c of candidates) {
    const key = `${c.owner}/${c.repo}`;
    byRepo.set(key, [...(byRepo.get(key) ?? []), c]);
  }
  const listCalls: string[] = [];
  const unused = (): never => {
    throw new Error("unused in runOnce discovery");
  };
  const client: GitHubClient = {
    getPullRequest: unused,
    getIssue: unused,
    getIssueLabeledEvents: unused,
    getClosingIssueNumbers: unused,
    async listRepoIssues(owner, repo, _options?: ListRepoIssuesOptions) {
      const key = `${owner}/${repo}`;
      listCalls.push(key);
      return (byRepo.get(key) ?? []).map((c): GitHubIssue => ({
        number: c.issueNumber,
        state: "closed",
        labels: [{ name: "Wave" }],
        html_url: `https://github.com/${key}/issues/${c.issueNumber}`,
      }));
    },
    async getIssueLinkedPullRequests(owner, repo, issueNumber): Promise<LinkedPullRequest[]> {
      const key = `${owner}/${repo}`;
      const c = (byRepo.get(key) ?? []).find((x) => x.issueNumber === issueNumber);
      return c ? [{ number: c.prNumber, merged }] : [];
    },
  };
  return { client, listCalls };
}

function seedsFor(candidates: VerificationCandidate[]): RunOnceDeps["seeds"] {
  const seen = new Set<string>();
  const seeds: RunOnceDeps["seeds"] = [];
  for (const c of candidates) {
    const ownerRepo = `${c.owner}/${c.repo}`;
    if (seen.has(ownerRepo)) continue;
    seen.add(ownerRepo);
    seeds.push({ owner: c.owner, repo: c.repo, ownerRepo });
  }
  return seeds;
}

/** Base deps: no seeds, no queue rows, wallet never linked. Override per test. */
function baseDeps(over: Partial<RunOnceDeps> = {}): RunOnceDeps {
  return {
    queue: fakeQueue().queue,
    reads: NEVER_LINKED,
    submitter: STUB_SUBMITTER,
    github: githubYielding([]).client,
    approvedOrgs: {
      listApprovedOrgs: async () => ({ status: "ok", orgs: [], source: "test", fetchedAt: "" }),
    },
    seeds: [],
    submit: submitReturning(rpcErrorResult()).fn,
    verify: async (c) => verification(c),
    ...over,
  };
}

// ================================================================
// 1. queue drain runs first
// ================================================================

test("the queue is drained before discovery runs", async () => {
  const c = candidate();
  const fq = fakeQueue([row({ prHash: prHashOf(c) })]);
  const { client, listCalls } = githubYielding([candidate({ prNumber: 100 })]);
  const order: string[] = [];

  const reads = fakeReads(() => {
    order.push("wallet-recheck");
    return null; // still unlinked
  });
  const gh: GitHubClient = {
    ...client,
    async listRepoIssues(o, r, opt) {
      order.push("discovery-list");
      return client.listRepoIssues(o, r, opt);
    },
  };

  await runOnce(
    baseDeps({
      queue: fq.queue,
      reads,
      github: gh,
      seeds: seedsFor([candidate({ prNumber: 100 })]),
    }),
  );

  assert.deepEqual(order, ["wallet-recheck", "discovery-list"]);
  assert.ok(listCalls); // referenced
});

// ================================================================
// 2. drain: still unlinked
// ================================================================

test("drain: a still-unlinked item is left queued and only re-checked (no submit)", async () => {
  const c = candidate();
  const fq = fakeQueue([row({ prHash: prHashOf(c) })]);
  const { fn, inputs } = submitReturning(submittedResult(c));

  const summary = await runOnce(baseDeps({ queue: fq.queue, reads: NEVER_LINKED, submit: fn }));

  assert.equal(inputs.length, 0, "submit is never called for an unlinked item");
  assert.equal(summary.queueDrain.scanned, 1);
  assert.equal(summary.queueDrain.stillWaiting, 1);
  assert.equal(fq.rows.get(prHashOf(c))!.status, PENDING_STATUS.WAITING_FOR_WALLET_LINK);
  assert.equal(fq.rows.get(prHashOf(c))!.attemptCount, 1);
  assert.ok(fq.calls.some((x) => x.method === "recordCheckAttempt"));
});

// ================================================================
// 3-6. drain: wallet now linked -> route each submit outcome
// ================================================================

test("drain: wallet linked + submitted -> marked ALREADY_ATTESTED, tx hash + attempt counted", async () => {
  const c = candidate();
  const fq = fakeQueue([row({ prHash: prHashOf(c) })]);
  const logger = createCollectingLogger();
  const { fn } = submitReturning(submittedResult(c, "tx-abc123"));

  const summary = await runOnce(
    baseDeps({ queue: fq.queue, reads: ALWAYS_LINKED, submit: fn, logger }),
  );

  assert.equal(summary.queueDrain.submitOutcomes.submitted, 1);
  assert.deepEqual(summary.submittedTxHashes, ["tx-abc123"]);
  assert.equal(summary.realSubmissionAttempts, 1);
  assert.equal(fq.rows.get(prHashOf(c))!.status, PENDING_STATUS.ALREADY_ATTESTED);
  assert.equal(logger.byEvent("drain.submitted").length, 1);
});

test("drain: wallet linked + already-attested -> cleared from queue, no attempt", async () => {
  const c = candidate();
  const fq = fakeQueue([row({ prHash: prHashOf(c) })]);
  const { fn } = submitReturning(alreadyAttestedResult(c));

  const summary = await runOnce(baseDeps({ queue: fq.queue, reads: ALWAYS_LINKED, submit: fn }));

  assert.equal(summary.queueDrain.submitOutcomes["already-attested"], 1);
  assert.equal(summary.realSubmissionAttempts, 0);
  assert.equal(fq.rows.get(prHashOf(c))!.status, PENDING_STATUS.ALREADY_ATTESTED);
});

test("drain: contract-rejected -> logged distinctly, left queued, no retry", async () => {
  const c = candidate();
  const fq = fakeQueue([row({ prHash: prHashOf(c) })]);
  const logger = createCollectingLogger();
  const { fn, inputs } = submitReturning(contractRejectedResult());

  const summary = await runOnce(
    baseDeps({ queue: fq.queue, reads: ALWAYS_LINKED, submit: fn, logger }),
  );

  assert.equal(inputs.length, 1, "submit attempted exactly once — no retry inside the pass");
  assert.equal(summary.queueDrain.submitOutcomes["contract-rejected"], 1);
  assert.equal(fq.rows.get(prHashOf(c))!.status, PENDING_STATUS.WAITING_FOR_WALLET_LINK);
  assert.equal(logger.byEvent("drain.contract_rejected").length, 1);
});

test("drain: rpc-error -> logged, left queued, no retry", async () => {
  const c = candidate();
  const fq = fakeQueue([row({ prHash: prHashOf(c) })]);
  const logger = createCollectingLogger();
  const { fn, inputs } = submitReturning(rpcErrorResult());

  const summary = await runOnce(
    baseDeps({ queue: fq.queue, reads: ALWAYS_LINKED, submit: fn, logger }),
  );

  assert.equal(inputs.length, 1);
  assert.equal(summary.queueDrain.submitOutcomes["rpc-error"], 1);
  assert.equal(fq.rows.get(prHashOf(c))!.status, PENDING_STATUS.WAITING_FOR_WALLET_LINK);
  assert.equal(logger.byEvent("drain.rpc_error").length, 1);
});

test("drain: submission-failed -> logged distinctly, left queued, attempt counted", async () => {
  const c = candidate();
  const fq = fakeQueue([row({ prHash: prHashOf(c) })]);
  const logger = createCollectingLogger();
  const { fn } = submitReturning(submissionFailedResult());

  const summary = await runOnce(
    baseDeps({ queue: fq.queue, reads: ALWAYS_LINKED, submit: fn, logger }),
  );

  assert.equal(summary.queueDrain.submitOutcomes["submission-failed"], 1);
  assert.equal(summary.realSubmissionAttempts, 1);
  assert.equal(fq.rows.get(prHashOf(c))!.status, PENDING_STATUS.WAITING_FOR_WALLET_LINK);
  assert.equal(logger.byEvent("drain.submission_failed").length, 1);
});

test("drain: a queued row whose stored verification is unusable -> dismissed", async () => {
  const c = candidate();
  const fq = fakeQueue([row({ prHash: prHashOf(c), verification: { not: "a result" } })]);
  const { fn, inputs } = submitReturning(submittedResult(c));

  const summary = await runOnce(baseDeps({ queue: fq.queue, reads: ALWAYS_LINKED, submit: fn }));

  assert.equal(inputs.length, 0, "no submit for an unreadable row");
  assert.equal(summary.queueDrain.dismissed, 1);
  assert.equal(fq.rows.get(prHashOf(c))!.status, PENDING_STATUS.DISMISSED);
});

test("drain: not-attestable at submit time -> dismissed (stuck-row guard)", async () => {
  const c = candidate();
  const fq = fakeQueue([row({ prHash: prHashOf(c) })]);
  const { fn } = submitReturning({
    kind: "not-attestable",
    failingCheckIds: ["pr_is_merged"],
    indeterminate: false,
  });

  const summary = await runOnce(baseDeps({ queue: fq.queue, reads: ALWAYS_LINKED, submit: fn }));

  assert.equal(summary.queueDrain.dismissed, 1);
  assert.equal(fq.rows.get(prHashOf(c))!.status, PENDING_STATUS.DISMISSED);
});

// ================================================================
// 7-14. discovery -> verify -> submit routing
// ================================================================

test("discovery: attestable + not-submittable -> enqueued once", async () => {
  const c = candidate();
  const fq = fakeQueue();
  const logger = createCollectingLogger();
  const { fn } = submitReturning(notSubmittableResult(c));

  const summary = await runOnce(
    baseDeps({
      queue: fq.queue,
      github: githubYielding([c]).client,
      seeds: seedsFor([c]),
      submit: fn,
      logger,
    }),
  );

  assert.equal(summary.discovery.candidates, 1);
  assert.equal(summary.discovery.attestable, 1);
  assert.equal(summary.discovery.enqueued, 1);
  const r = fq.rows.get(prHashOf(c))!;
  assert.equal(r.status, PENDING_STATUS.WAITING_FOR_WALLET_LINK);
  assert.equal(r.githubIdHash, hashGitHubUserIdV1Hex(AUTHOR_ID));
  assert.equal(r.githubUserId, String(AUTHOR_ID));
  assert.equal(r.issueId, BigInt(c.issueNumber));
  assert.equal(logger.byEvent("submit.enqueued").length, 1);
});

test("discovery: not-submittable but already queued -> no duplicate, alreadyQueued counted", async () => {
  const c = candidate();
  const fq = fakeQueue([row({ prHash: prHashOf(c) })]);
  const { fn } = submitReturning(notSubmittableResult(c));
  const enqueueCallsBefore = fq.calls.filter((x) => x.method === "enqueue").length;

  const summary = await runOnce(
    baseDeps({
      queue: fq.queue,
      reads: NEVER_LINKED,
      github: githubYielding([c]).client,
      seeds: seedsFor([c]),
      submit: fn,
    }),
  );

  assert.equal(summary.discovery.enqueued, 0);
  assert.equal(summary.discovery.alreadyQueued, 1);
  assert.equal(
    fq.calls.filter((x) => x.method === "enqueue").length,
    enqueueCallsBefore,
    "enqueue was not called again",
  );
});

test("discovery: not-submittable but an operator dismissed the row -> not revived", async () => {
  const c = candidate();
  const fq = fakeQueue([row({ prHash: prHashOf(c), status: PENDING_STATUS.DISMISSED })]);
  const { fn } = submitReturning(notSubmittableResult(c));

  const summary = await runOnce(
    baseDeps({
      queue: fq.queue,
      github: githubYielding([c]).client,
      seeds: seedsFor([c]),
      submit: fn,
    }),
  );

  assert.equal(summary.discovery.enqueueSkippedDismissed, 1);
  assert.equal(summary.discovery.enqueued, 0);
  assert.equal(fq.rows.get(prHashOf(c))!.status, PENDING_STATUS.DISMISSED);
  assert.ok(!fq.calls.some((x) => x.method === "enqueue"));
});

test("discovery: verify fails a gating check -> skipped, not queued, submit never called", async () => {
  const c = candidate();
  const fq = fakeQueue();
  const { fn, inputs } = submitReturning(submittedResult(c));

  const summary = await runOnce(
    baseDeps({
      queue: fq.queue,
      github: githubYielding([c]).client,
      seeds: seedsFor([c]),
      verify: async (cc) => verification(cc, { failing: ["pr_is_merged"] }),
      submit: fn,
    }),
  );

  assert.equal(inputs.length, 0);
  assert.equal(summary.discovery.notAttestable, 1);
  assert.equal(summary.discovery.attestable, 0);
  assert.equal(fq.rows.size, 0);
});

test("discovery: verify indeterminate -> skipped, not queued, submit never called", async () => {
  const c = candidate();
  const fq = fakeQueue();
  const { fn, inputs } = submitReturning(submittedResult(c));

  const summary = await runOnce(
    baseDeps({
      queue: fq.queue,
      github: githubYielding([c]).client,
      seeds: seedsFor([c]),
      verify: async (cc) => verification(cc, { indeterminate: ["repo_in_approved_orgs"] }),
      submit: fn,
    }),
  );

  assert.equal(inputs.length, 0);
  assert.equal(summary.discovery.indeterminate, 1);
  assert.equal(fq.rows.size, 0);
});

test("discovery: attestable but PR has no resolvable author id -> skipped", async () => {
  const c = candidate();
  const fq = fakeQueue();
  const { fn, inputs } = submitReturning(submittedResult(c));

  const summary = await runOnce(
    baseDeps({
      queue: fq.queue,
      github: githubYielding([c]).client,
      seeds: seedsFor([c]),
      verify: async (cc) => verification(cc, { authorId: null }),
      submit: fn,
    }),
  );

  assert.equal(inputs.length, 0);
  assert.equal(summary.discovery.unresolvedAuthor, 1);
});

test("discovery: submitted -> success logged, tx hash surfaced, not queued", async () => {
  const c = candidate();
  const fq = fakeQueue();
  const logger = createCollectingLogger();
  const { fn } = submitReturning(submittedResult(c, "tx-live-1"));

  const summary = await runOnce(
    baseDeps({
      queue: fq.queue,
      reads: ALWAYS_LINKED,
      github: githubYielding([c]).client,
      seeds: seedsFor([c]),
      submit: fn,
      logger,
    }),
  );

  assert.equal(summary.discovery.submitOutcomes.submitted, 1);
  assert.deepEqual(summary.submittedTxHashes, ["tx-live-1"]);
  assert.equal(summary.realSubmissionAttempts, 1);
  assert.equal(fq.rows.size, 0);
  assert.equal(logger.byEvent("submit.submitted").length, 1);
});

test("discovery: already-attested -> no-op skip, not queued", async () => {
  const c = candidate();
  const fq = fakeQueue();
  const logger = createCollectingLogger();
  const { fn } = submitReturning(alreadyAttestedResult(c));

  const summary = await runOnce(
    baseDeps({
      queue: fq.queue,
      github: githubYielding([c]).client,
      seeds: seedsFor([c]),
      submit: fn,
      logger,
    }),
  );

  assert.equal(summary.discovery.submitOutcomes["already-attested"], 1);
  assert.equal(summary.realSubmissionAttempts, 0);
  assert.equal(fq.rows.size, 0);
  assert.equal(logger.byEvent("submit.already_attested").length, 1);
});

for (const [label, make, event] of [
  ["contract-rejected", contractRejectedResult, "submit.contract_rejected"],
  ["submission-failed", submissionFailedResult, "submit.submission_failed"],
  ["rpc-error", rpcErrorResult, "submit.rpc_error"],
] as const) {
  test(`discovery: ${label} -> logged distinctly, not queued, no retry`, async () => {
    const c = candidate();
    const fq = fakeQueue();
    const logger = createCollectingLogger();
    const { fn, inputs } = submitReturning(make());

    const summary = await runOnce(
      baseDeps({
        queue: fq.queue,
        reads: ALWAYS_LINKED,
        github: githubYielding([c]).client,
        seeds: seedsFor([c]),
        submit: fn,
        logger,
      }),
    );

    assert.equal(inputs.length, 1, "submit attempted once, not retried");
    assert.equal(summary.discovery.submitOutcomes[make().kind], 1);
    assert.equal(fq.rows.size, 0, "nothing queued for a hard failure");
    assert.equal(logger.byEvent(event).length, 1);
  });
}

// ================================================================
// 15. idempotency
// ================================================================

test("running twice: first enqueues, second finds it queued — no duplicate, no extra enqueue", async () => {
  const c = candidate();
  const fq = fakeQueue();
  const { fn } = submitReturning(notSubmittableResult(c));
  const deps = baseDeps({
    queue: fq.queue,
    reads: NEVER_LINKED,
    github: githubYielding([c]).client,
    seeds: seedsFor([c]),
    submit: fn,
  });

  const first = await runOnce(deps);
  const second = await runOnce(deps);

  assert.equal(first.discovery.enqueued, 1);
  assert.equal(second.discovery.enqueued, 0);
  assert.equal(second.discovery.alreadyQueued, 1);
  assert.equal(fq.rows.size, 1);
  assert.equal(fq.calls.filter((x) => x.method === "enqueue").length, 1);
});

// ================================================================
// 16. dry-run mode
// ================================================================

test("dryRun: forwarded to submit; dry-run-ok routed; nothing enqueued or marked", async () => {
  const c = candidate();
  const fq = fakeQueue([row({ prHash: prHashOf(c) })]);
  const { fn, inputs } = submitReturning(dryRunOkResult(c), dryRunOkResult(c));

  const summary = await runOnce(
    baseDeps({
      queue: fq.queue,
      reads: ALWAYS_LINKED,
      github: githubYielding([candidate({ prNumber: 99 })]).client,
      seeds: seedsFor([candidate({ prNumber: 99 })]),
      verify: async (cc) => verification(cc),
      submit: fn,
      dryRun: true,
    }),
  );

  assert.ok(inputs.length >= 1);
  assert.ok(
    inputs.every((i) => i.dryRun === true),
    "every submit call carried dryRun:true",
  );
  assert.equal(summary.dryRun, true);
  assert.equal(summary.realSubmissionAttempts, 0);
  assert.equal(summary.queueDrain.submitOutcomes["dry-run-ok"], 1);
  assert.equal(fq.rows.get(prHashOf(c))!.status, PENDING_STATUS.WAITING_FOR_WALLET_LINK);
});

// ================================================================
// 17. summary shape
// ================================================================

test("summary: timestamps, duration, and every outcome-count key initialised", async () => {
  const summary = await runOnce(baseDeps());

  assert.match(summary.startedAt, /^\d{4}-\d\d-\d\dT/);
  assert.match(summary.finishedAt, /^\d{4}-\d\d-\d\dT/);
  assert.ok(summary.durationMs >= 0);
  const kinds = [
    "submitted",
    "dry-run-ok",
    "already-attested",
    "not-submittable",
    "not-attestable",
    "contract-rejected",
    "submission-failed",
    "rpc-error",
  ];
  for (const k of kinds) {
    assert.equal(
      summary.queueDrain.submitOutcomes[k as keyof typeof summary.queueDrain.submitOutcomes],
      0,
    );
    assert.equal(
      summary.discovery.submitOutcomes[k as keyof typeof summary.discovery.submitOutcomes],
      0,
    );
  }
  assert.deepEqual(summary.submittedTxHashes, []);
  assert.equal(summary.realSubmissionAttempts, 0);
});

test("maxQueueDrain caps how many waiting rows are examined in a pass", async () => {
  const cands = [1, 2, 3, 4, 5].map((n) => candidate({ prNumber: n }));
  const seedRows = cands.map((c, i) =>
    row({ prHash: prHashOf(c), createdAt: new Date(2026, 0, 1, 0, i) }),
  );
  const fq = fakeQueue(seedRows);

  const summary = await runOnce(
    baseDeps({ queue: fq.queue, reads: NEVER_LINKED, maxQueueDrain: 2 }),
  );

  assert.equal(summary.queueDrain.scanned, 2);
});
