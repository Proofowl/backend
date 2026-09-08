/**
 * Orchestration — one idempotent pass of the automation pipeline:
 *
 *   1. DRAIN the queue first. For every `WAITING_FOR_WALLET_LINK` row,
 *      re-read `get_wallet_for_github`. Still unlinked ⇒ leave it queued
 *      (just record the re-check). Now linked ⇒ hand it to
 *      {@link submitAttestation} for a real submission and route the
 *      result.
 *   2. DISCOVER new candidates (see ./discover.ts), then
 *      {@link verifyContribution} each one. Not attestable ⇒ log and
 *      skip, never queue. Attestable ⇒ hand to {@link submitAttestation}
 *      and route: `not-submittable` (wallet not linked) ⇒ enqueue (once);
 *      `submitted` / `already-attested` ⇒ reconcile any stale queue row;
 *      everything else ⇒ log distinctly, no retry inside this pass.
 *   3. Return a structured {@link RunOnceSummary} — counts keyed by
 *      `submit_attestation` outcome kind, plus the submitted tx hashes.
 *
 * The pass is idempotent: `enqueue` is an upsert on `pr_hash`,
 * `submitAttestation` short-circuits an already-credited PR to
 * `already-attested` before assembling anything, and a drained row that
 * was already submitted is no longer `WAITING`. Running twice in a row
 * therefore broadcasts nothing the first run already did.
 *
 * NOTHING here is wired to server startup or a timer — `runOnce` is a
 * plain function. The scheduler that calls it on an interval
 * (./schedule.ts) is only ever reached through the explicit
 * `pipeline:once` / `pipeline:loop` entrypoints. `ATTESTOR_SECRET_KEY`
 * is only ever read by the injected `submitter`; it never reaches this
 * module, a log line, or the summary.
 */

import {
  submitAttestation,
  type AttestationSubmitter,
  type ComplexityTier,
  type SubmissionAttemptContext,
  type SubmitAttestationDeps,
  type SubmitAttestationInput,
  type SubmitAttestationResult,
} from "../chain/submit.js";
import type { ChainReadClient } from "../chain/readClient.js";
import type { GitHubClient } from "../github/client.js";
import type { ApprovedOrgsSource } from "../github/approvedOrgs.js";
import type { ApprovedOrgsAllowlistSource } from "../github/approvedOrgsAllowlistSource.js";
import { verifyContribution, type WaveLabelMatcher } from "../github/verify.js";
import type { VerificationCandidate, VerificationResult } from "../github/types.js";
import { hashGitHubUserIdV1Hex } from "../hashing/identifiers.js";
import type { PendingContributionRepository, PendingContributionRow } from "../queue/repository.js";
import { PENDING_STATUS } from "../queue/status.js";
import { discoverCandidates } from "./discover.js";
import { silentPipelineLogger, type PipelineLogger } from "./log.js";
import type { SeedRepo } from "./seed.js";

/** The subset of {@link PendingContributionRepository} `runOnce` touches. */
export type RunOnceQueue = Pick<
  PendingContributionRepository,
  | "listWaiting"
  | "getByPrHash"
  | "enqueue"
  | "markAlreadyAttested"
  | "recordCheckAttempt"
  | "dismiss"
>;

/** Inject-for-tests seam over {@link submitAttestation}. */
export type SubmitFn = (
  input: SubmitAttestationInput,
  deps: SubmitAttestationDeps,
) => Promise<SubmitAttestationResult>;

/** Inject-for-tests seam over {@link verifyContribution}. */
export type VerifyFn = (candidate: VerificationCandidate) => Promise<VerificationResult>;

export interface RunOnceDeps {
  queue: RunOnceQueue;
  /** Read-only chain client — wallet-link re-checks + already-attested guard. */
  reads: ChainReadClient;
  /** The write boundary. Bound to testnet; refuses anything else. */
  submitter: AttestationSubmitter;
  github: GitHubClient;
  approvedOrgs: ApprovedOrgsSource;
  approvedOrgsAllowlist?: ApprovedOrgsAllowlistSource;
  /** Repos discovery scans — from the approved-orgs allowlist (see ./seed.ts). */
  seeds: SeedRepo[];
  isWaveLabel?: WaveLabelMatcher;
  /** Exact label names for discovery's server-side prefilter. */
  labelPrefilter?: string[];
  /** Per-repo issue ceiling for the discovery pass. Default 100. */
  maxIssuesPerRepo?: number;
  /** Ceiling on queued rows re-checked this pass. Default 100. */
  maxQueueDrain?: number;
  /**
   * Simulate every submission, never sign or send. Discovery still runs
   * and unlinked contributions are still enqueued.
   */
  dryRun?: boolean;
  logger?: PipelineLogger;
  /** Forwarded to every real (non-dry-run) submission — budget counting. */
  onSubmissionAttempt?: (ctx: SubmissionAttemptContext) => void;
  /** Defaults to {@link submitAttestation}. Overridden only in tests. */
  submit?: SubmitFn;
  /** Defaults to {@link verifyContribution}. Overridden only in tests. */
  verify?: VerifyFn;
}

/** Every `submit_attestation` outcome kind, counted. */
export type OutcomeCounts = Record<SubmitAttestationResult["kind"], number>;

export interface RunOnceSummary {
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  /** True if this pass simulated submissions only. */
  dryRun: boolean;
  queueDrain: {
    /** `WAITING_FOR_WALLET_LINK` rows examined (bounded by `maxQueueDrain`). */
    scanned: number;
    /** Still unlinked — left queued, only the re-check was recorded. */
    stillWaiting: number;
    /** A queued row's stored verification was unusable ⇒ dismissed. */
    dismissed: number;
    /** `submitAttestation` outcomes for rows whose wallet became linked. */
    submitOutcomes: OutcomeCounts;
  };
  discovery: {
    seedRepos: number;
    /** Raw (issue, merged PR) pairs discovery emitted. */
    candidates: number;
    /** Passed every gating check. */
    attestable: number;
    /** At least one gating check `fail` (and none `indeterminate`). */
    notAttestable: number;
    /** At least one gating check `indeterminate` (upstream unavailable). */
    indeterminate: number;
    /** Attestable, but the PR carried no resolvable author id ⇒ skipped. */
    unresolvedAuthor: number;
    /** `submitAttestation` outcomes for attestable candidates. */
    submitOutcomes: OutcomeCounts;
    /** New `WAITING_FOR_WALLET_LINK` rows written (wallet not linked yet). */
    enqueued: number;
    /** Rediscovered while already queued — refreshed, not duplicated. */
    alreadyQueued: number;
    /** Rediscovered but an operator had dismissed the row — left dismissed. */
    enqueueSkippedDismissed: number;
  };
  /** Real (non-dry-run) submission attempts this pass — link + send budget. */
  realSubmissionAttempts: number;
  /** Transaction hashes of everything `submitted` this pass (drain + discovery). */
  submittedTxHashes: string[];
}

function emptyOutcomeCounts(): OutcomeCounts {
  return {
    submitted: 0,
    "dry-run-ok": 0,
    "already-attested": 0,
    "not-submittable": 0,
    "not-attestable": 0,
    "contract-rejected": 0,
    "submission-failed": 0,
    "rpc-error": 0,
  };
}

function looksLikeVerificationResult(v: unknown): v is VerificationResult {
  if (v === null || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o.attestable === "boolean" &&
    Array.isArray(o.checks) &&
    o.candidate !== null &&
    typeof o.candidate === "object"
  );
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export async function runOnce(deps: RunOnceDeps): Promise<RunOnceSummary> {
  const logger = deps.logger ?? silentPipelineLogger;
  const submit = deps.submit ?? submitAttestation;

  const startedAtMs = Date.now();
  const startedAt = new Date(startedAtMs).toISOString();

  let realSubmissionAttempts = 0;
  const submittedTxHashes: string[] = [];
  const submitDeps: SubmitAttestationDeps = {
    reads: deps.reads,
    submitter: deps.submitter,
    onSubmissionAttempt: (ctx) => {
      realSubmissionAttempts += 1;
      deps.onSubmissionAttempt?.(ctx);
    },
  };

  const summary: RunOnceSummary = {
    startedAt,
    finishedAt: startedAt,
    durationMs: 0,
    dryRun: deps.dryRun === true,
    queueDrain: {
      scanned: 0,
      stillWaiting: 0,
      dismissed: 0,
      submitOutcomes: emptyOutcomeCounts(),
    },
    discovery: {
      seedRepos: deps.seeds.length,
      candidates: 0,
      attestable: 0,
      notAttestable: 0,
      indeterminate: 0,
      unresolvedAuthor: 0,
      submitOutcomes: emptyOutcomeCounts(),
      enqueued: 0,
      alreadyQueued: 0,
      enqueueSkippedDismissed: 0,
    },
    realSubmissionAttempts: 0,
    submittedTxHashes,
  };

  logger.log({
    level: "info",
    event: "runOnce.start",
    message: `pipeline pass starting${summary.dryRun ? " (dry run)" : ""}`,
    fields: { seedRepos: summary.discovery.seedRepos, dryRun: summary.dryRun },
  });

  // ---- 1. drain the queue first ------------------------------------------
  await drainQueue(deps, { logger, submit, submitDeps, summary, submittedTxHashes });

  // ---- 2. discover -> verify -> submit / queue --------------------------
  await discoverVerifySubmit(deps, { logger, submit, submitDeps, summary, submittedTxHashes });

  const finishedAtMs = Date.now();
  summary.finishedAt = new Date(finishedAtMs).toISOString();
  summary.durationMs = finishedAtMs - startedAtMs;
  summary.realSubmissionAttempts = realSubmissionAttempts;

  logger.log({
    level: "info",
    event: "runOnce.done",
    message: "pipeline pass complete",
    fields: {
      durationMs: summary.durationMs,
      realSubmissionAttempts: summary.realSubmissionAttempts,
      drainSubmitted: summary.queueDrain.submitOutcomes.submitted,
      discoverySubmitted: summary.discovery.submitOutcomes.submitted,
      enqueued: summary.discovery.enqueued,
    },
  });

  return summary;
}

interface Ctx {
  logger: PipelineLogger;
  submit: SubmitFn;
  submitDeps: SubmitAttestationDeps;
  summary: RunOnceSummary;
  submittedTxHashes: string[];
}

async function drainQueue(deps: RunOnceDeps, ctx: Ctx): Promise<void> {
  const { logger, submit, submitDeps, summary } = ctx;
  const limit = deps.maxQueueDrain ?? 100;

  let waiting: PendingContributionRow[];
  try {
    waiting = await deps.queue.listWaiting(limit);
  } catch (err) {
    logger.log({
      level: "error",
      event: "drain.list_error",
      message: `could not list the wallet-link queue: ${messageOf(err)}`,
    });
    return;
  }

  logger.log({
    level: "info",
    event: "drain.start",
    message: `draining ${waiting.length} queued contribution(s)`,
    fields: { queued: waiting.length, limit },
  });

  for (const row of waiting) {
    summary.queueDrain.scanned += 1;

    let linkedWallet: string | null;
    try {
      linkedWallet = await deps.reads.getWalletForGithubIdHash(row.githubIdHash);
    } catch (err) {
      logger.log({
        level: "warn",
        event: "drain.rpc_error",
        message: `wallet-link re-check failed for ${row.repo}#${row.prNumber}; left queued`,
        fields: { prHash: row.prHash, repo: row.repo, pr: row.prNumber, error: messageOf(err) },
      });
      await recordCheckSafely(deps, logger, row.prHash, "wallet-link re-check errored");
      continue;
    }

    if (linkedWallet === null) {
      summary.queueDrain.stillWaiting += 1;
      logger.log({
        level: "info",
        event: "drain.still_waiting",
        message: `${row.repo}#${row.prNumber} still has no linked wallet; left queued`,
        fields: {
          prHash: row.prHash,
          repo: row.repo,
          pr: row.prNumber,
          attempts: row.attemptCount,
        },
      });
      await recordCheckSafely(deps, logger, row.prHash, "wallet still not linked on-chain");
      continue;
    }

    if (!looksLikeVerificationResult(row.verification)) {
      summary.queueDrain.dismissed += 1;
      logger.log({
        level: "warn",
        event: "drain.unreadable_dismissed",
        message: `${row.repo}#${row.prNumber}: stored verification is unusable; dismissed`,
        fields: { prHash: row.prHash, repo: row.repo, pr: row.prNumber },
      });
      await dismissSafely(
        deps,
        logger,
        row.prHash,
        "stored verification JSON was not a usable result",
      );
      continue;
    }

    const input: SubmitAttestationInput = {
      verification: row.verification,
      githubIdHash: row.githubIdHash,
      issueId: row.issueId,
      complexity: row.complexity as ComplexityTier,
      ...(deps.dryRun ? { dryRun: true } : {}),
    };

    const result = await submit(input, submitDeps);
    summary.queueDrain.submitOutcomes[result.kind] += 1;
    await routeDrainResult(deps, ctx, row, result);
  }

  logger.log({
    level: "info",
    event: "drain.done",
    message: "queue drain complete",
    fields: {
      scanned: summary.queueDrain.scanned,
      stillWaiting: summary.queueDrain.stillWaiting,
      submitted: summary.queueDrain.submitOutcomes.submitted,
      alreadyAttested: summary.queueDrain.submitOutcomes["already-attested"],
    },
  });
}

async function routeDrainResult(
  deps: RunOnceDeps,
  ctx: Ctx,
  row: PendingContributionRow,
  result: SubmitAttestationResult,
): Promise<void> {
  const { logger } = ctx;
  const base = { prHash: row.prHash, repo: row.repo, pr: row.prNumber };

  switch (result.kind) {
    case "submitted": {
      ctx.submittedTxHashes.push(result.txHash);
      logger.log({
        level: "info",
        event: "drain.submitted",
        message: `${row.repo}#${row.prNumber} submitted on-chain: ${result.txHash}`,
        fields: { ...base, txHash: result.txHash, ledger: result.ledger },
      });
      await markAttestedSafely(
        deps,
        logger,
        row.prHash,
        `submitted by pipeline (drain): tx ${result.txHash}`,
      );
      return;
    }
    case "already-attested": {
      logger.log({
        level: "info",
        event: "drain.already_attested",
        message: `${row.repo}#${row.prNumber} is already credited on-chain; clearing from queue`,
        fields: { ...base, linkedWallet: result.linkedWallet },
      });
      await markAttestedSafely(deps, logger, row.prHash, "already recorded on-chain");
      return;
    }
    case "dry-run-ok": {
      logger.log({
        level: "info",
        event: "drain.dry_run_ok",
        message: `${row.repo}#${row.prNumber} would submit cleanly (dry run); left queued`,
        fields: { ...base, minResourceFee: result.minResourceFee },
      });
      return;
    }
    case "not-submittable": {
      // Raced: linked a moment ago, unlinked now. Keep it queued.
      ctx.summary.queueDrain.stillWaiting += 1;
      logger.log({
        level: "warn",
        event: "drain.still_waiting",
        message: `${row.repo}#${row.prNumber} wallet link vanished between re-check and submit; left queued`,
        fields: base,
      });
      await recordCheckSafely(deps, logger, row.prHash, "wallet link vanished mid-pass");
      return;
    }
    case "not-attestable": {
      ctx.summary.queueDrain.dismissed += 1;
      logger.log({
        level: "warn",
        event: "drain.not_attestable_dismissed",
        message: `${row.repo}#${row.prNumber} no longer attestable (${result.failingCheckIds.join(", ")}); dismissed`,
        fields: { ...base, failingCheckIds: result.failingCheckIds },
      });
      await dismissSafely(
        deps,
        logger,
        row.prHash,
        `no longer attestable: ${result.failingCheckIds.join(", ")}`,
      );
      return;
    }
    case "contract-rejected": {
      logger.log({
        level: "error",
        event: "drain.contract_rejected",
        message: `${row.repo}#${row.prNumber} rejected at simulation: ${result.errorName}`,
        fields: {
          ...base,
          errorName: result.errorName,
          errorCode: result.errorCode,
          detail: result.detail,
        },
      });
      await recordCheckSafely(
        deps,
        logger,
        row.prHash,
        `contract rejected simulation: ${result.errorName}`,
      );
      return;
    }
    case "submission-failed": {
      logger.log({
        level: "error",
        event: "drain.submission_failed",
        message: `${row.repo}#${row.prNumber} submission failed (${result.stage}/${result.status}); no retry this pass`,
        fields: {
          ...base,
          stage: result.stage,
          status: result.status,
          txHash: result.txHash,
          detail: result.detail,
        },
      });
      await recordCheckSafely(
        deps,
        logger,
        row.prHash,
        `submission failed: ${result.stage}/${result.status}`,
      );
      return;
    }
    case "rpc-error": {
      logger.log({
        level: "warn",
        event: "drain.rpc_error",
        message: `${row.repo}#${row.prNumber} rpc error during ${result.during}; safe to retry, left queued`,
        fields: { ...base, during: result.during, detail: result.detail },
      });
      await recordCheckSafely(deps, logger, row.prHash, `rpc error during ${result.during}`);
      return;
    }
  }
}

async function discoverVerifySubmit(deps: RunOnceDeps, ctx: Ctx): Promise<void> {
  const { logger, submit, submitDeps, summary } = ctx;
  const verify = deps.verify ?? ctxVerify(deps);

  const discovered = await discoverCandidates({
    github: deps.github,
    seeds: deps.seeds,
    ...(deps.isWaveLabel ? { isWaveLabel: deps.isWaveLabel } : {}),
    ...(deps.labelPrefilter ? { labelPrefilter: deps.labelPrefilter } : {}),
    ...(deps.maxIssuesPerRepo !== undefined ? { maxIssuesPerRepo: deps.maxIssuesPerRepo } : {}),
    logger,
  });
  summary.discovery.candidates = discovered.candidates.length;

  for (const candidate of discovered.candidates) {
    const repo = `${candidate.owner}/${candidate.repo}`;

    let result: VerificationResult;
    try {
      result = await verify(candidate);
    } catch (err) {
      logger.log({
        level: "warn",
        event: "verify.error",
        message: `verification threw for ${repo}#${candidate.prNumber}: ${messageOf(err)}`,
        fields: {
          repo,
          issue: candidate.issueNumber,
          pr: candidate.prNumber,
          error: messageOf(err),
        },
      });
      continue;
    }

    if (!result.attestable) {
      if (result.indeterminate) {
        summary.discovery.indeterminate += 1;
        logger.log({
          level: "info",
          event: "verify.indeterminate",
          message: `${repo}#${candidate.prNumber} has indeterminate checks; skipped, not queued`,
          fields: {
            repo,
            pr: candidate.prNumber,
            checks: indeterminateIds(result),
          },
        });
      } else {
        summary.discovery.notAttestable += 1;
        logger.log({
          level: "info",
          event: "verify.not_attestable",
          message: `${repo}#${candidate.prNumber} failed gating checks; skipped, not queued`,
          fields: { repo, pr: candidate.prNumber, checks: failingIds(result) },
        });
      }
      continue;
    }

    summary.discovery.attestable += 1;

    const authorId = result.flags.selfMerge.prAuthorId;
    if (authorId === null || authorId === undefined) {
      summary.discovery.unresolvedAuthor += 1;
      logger.log({
        level: "warn",
        event: "verify.unresolved_author",
        message: `${repo}#${candidate.prNumber} is attestable but has no resolvable PR author id; skipped`,
        fields: { repo, pr: candidate.prNumber },
      });
      continue;
    }

    const githubIdHashHex = hashGitHubUserIdV1Hex(authorId);
    const input: SubmitAttestationInput = {
      verification: result,
      githubIdHash: githubIdHashHex,
      issueId: BigInt(candidate.issueNumber),
      complexity: 0,
      ...(deps.dryRun ? { dryRun: true } : {}),
    };

    const submitResult = await submit(input, submitDeps);
    summary.discovery.submitOutcomes[submitResult.kind] += 1;
    await routeDiscoveryResult(
      deps,
      ctx,
      candidate,
      String(authorId),
      githubIdHashHex,
      result,
      submitResult,
    );
  }
}

function ctxVerify(deps: RunOnceDeps): VerifyFn {
  return (candidate: VerificationCandidate) =>
    verifyContribution(candidate, {
      github: deps.github,
      approvedOrgs: deps.approvedOrgs,
      ...(deps.approvedOrgsAllowlist ? { approvedOrgsAllowlist: deps.approvedOrgsAllowlist } : {}),
      ...(deps.isWaveLabel ? { isWaveLabel: deps.isWaveLabel } : {}),
    });
}

async function routeDiscoveryResult(
  deps: RunOnceDeps,
  ctx: Ctx,
  candidate: VerificationCandidate,
  githubUserId: string,
  githubIdHashHex: string,
  verification: VerificationResult,
  result: SubmitAttestationResult,
): Promise<void> {
  const { logger } = ctx;
  const repo = `${candidate.owner}/${candidate.repo}`;
  const base = { repo, issue: candidate.issueNumber, pr: candidate.prNumber };

  switch (result.kind) {
    case "submitted": {
      ctx.submittedTxHashes.push(result.txHash);
      logger.log({
        level: "info",
        event: "submit.submitted",
        message: `${repo}#${candidate.prNumber} submitted on-chain: ${result.txHash}`,
        fields: {
          ...base,
          txHash: result.txHash,
          ledger: result.ledger,
          complexity: result.complexity,
        },
      });
      await reconcileQueueRow(
        deps,
        logger,
        result.prHashHex,
        `submitted by pipeline: tx ${result.txHash}`,
      );
      return;
    }
    case "already-attested": {
      logger.log({
        level: "info",
        event: "submit.already_attested",
        message: `${repo}#${candidate.prNumber} already credited on-chain; no-op`,
        fields: { ...base, linkedWallet: result.linkedWallet },
      });
      await reconcileQueueRow(deps, logger, result.prHashHex, "already recorded on-chain");
      return;
    }
    case "dry-run-ok": {
      logger.log({
        level: "info",
        event: "submit.dry_run_ok",
        message: `${repo}#${candidate.prNumber} would submit cleanly (dry run)`,
        fields: { ...base, minResourceFee: result.minResourceFee },
      });
      return;
    }
    case "not-submittable": {
      await enqueueUnlinked(
        deps,
        ctx,
        candidate,
        githubUserId,
        githubIdHashHex,
        verification,
        result.prHashHex,
      );
      return;
    }
    case "not-attestable": {
      // Defensive: we checked `attestable` above, so this is a race.
      logger.log({
        level: "warn",
        event: "submit.not_attestable",
        message: `${repo}#${candidate.prNumber} rejected as not-attestable at submit time; skipped, not queued`,
        fields: { ...base, failingCheckIds: result.failingCheckIds },
      });
      return;
    }
    case "contract-rejected": {
      logger.log({
        level: "error",
        event: "submit.contract_rejected",
        message: `${repo}#${candidate.prNumber} rejected at simulation: ${result.errorName}`,
        fields: {
          ...base,
          errorName: result.errorName,
          errorCode: result.errorCode,
          detail: result.detail,
        },
      });
      return;
    }
    case "submission-failed": {
      logger.log({
        level: "error",
        event: "submit.submission_failed",
        message: `${repo}#${candidate.prNumber} submission failed (${result.stage}/${result.status}); no retry this pass`,
        fields: {
          ...base,
          stage: result.stage,
          status: result.status,
          txHash: result.txHash,
          detail: result.detail,
        },
      });
      return;
    }
    case "rpc-error": {
      logger.log({
        level: "warn",
        event: "submit.rpc_error",
        message: `${repo}#${candidate.prNumber} rpc error during ${result.during}; no retry this pass`,
        fields: { ...base, during: result.during, detail: result.detail },
      });
      return;
    }
  }
}

async function enqueueUnlinked(
  deps: RunOnceDeps,
  ctx: Ctx,
  candidate: VerificationCandidate,
  githubUserId: string,
  githubIdHashHex: string,
  verification: VerificationResult,
  prHashHex: string,
): Promise<void> {
  const { logger, summary } = ctx;
  const repo = `${candidate.owner}/${candidate.repo}`;
  const base = { repo, issue: candidate.issueNumber, pr: candidate.prNumber, prHash: prHashHex };

  let existing: PendingContributionRow | null;
  try {
    existing = await deps.queue.getByPrHash(prHashHex);
  } catch (err) {
    logger.log({
      level: "error",
      event: "submit.enqueue_lookup_error",
      message: `could not check the queue for ${repo}#${candidate.prNumber}: ${messageOf(err)}`,
      fields: { ...base, error: messageOf(err) },
    });
    return;
  }

  if (existing && existing.status === PENDING_STATUS.DISMISSED) {
    summary.discovery.enqueueSkippedDismissed += 1;
    logger.log({
      level: "info",
      event: "submit.enqueue_skipped_dismissed",
      message: `${repo}#${candidate.prNumber} rediscovered but an operator dismissed it; left dismissed`,
      fields: base,
    });
    return;
  }

  if (existing) {
    summary.discovery.alreadyQueued += 1;
    logger.log({
      level: "info",
      event: "submit.already_queued",
      message: `${repo}#${candidate.prNumber} is already queued (status ${existing.status}); refreshed re-check`,
      fields: { ...base, status: existing.status, attempts: existing.attemptCount },
    });
    await recordCheckSafely(deps, logger, prHashHex, "still wallet-not-linked at rediscovery");
    return;
  }

  try {
    await deps.queue.enqueue({
      prHash: prHashHex,
      githubIdHash: githubIdHashHex,
      githubUserId,
      repo,
      prNumber: candidate.prNumber,
      issueId: BigInt(candidate.issueNumber),
      complexity: 0,
      verification,
      selfMergeFlagged: verification.flags.selfMerge.flagged,
    });
    summary.discovery.enqueued += 1;
    logger.log({
      level: "info",
      event: "submit.enqueued",
      message: `${repo}#${candidate.prNumber} verified but wallet not linked; enqueued`,
      fields: base,
    });
  } catch (err) {
    logger.log({
      level: "error",
      event: "submit.enqueue_error",
      message: `could not enqueue ${repo}#${candidate.prNumber}: ${messageOf(err)}`,
      fields: { ...base, error: messageOf(err) },
    });
  }
}

/** Clear a stale WAITING/READY queue row for a pr_hash that just went on-chain. */
async function reconcileQueueRow(
  deps: RunOnceDeps,
  logger: PipelineLogger,
  prHashHex: string,
  note: string,
): Promise<void> {
  let row: PendingContributionRow | null;
  try {
    row = await deps.queue.getByPrHash(prHashHex);
  } catch {
    return; // best-effort reconciliation only
  }
  if (
    !row ||
    row.status === PENDING_STATUS.ALREADY_ATTESTED ||
    row.status === PENDING_STATUS.DISMISSED
  ) {
    return;
  }
  await markAttestedSafely(deps, logger, prHashHex, note);
}

async function markAttestedSafely(
  deps: RunOnceDeps,
  logger: PipelineLogger,
  prHash: string,
  note: string,
): Promise<void> {
  try {
    await deps.queue.markAlreadyAttested(prHash, note);
  } catch (err) {
    logger.log({
      level: "error",
      event: "queue.mark_error",
      message: `could not mark ${prHash} attested: ${messageOf(err)}`,
      fields: { prHash, error: messageOf(err) },
    });
  }
}

async function recordCheckSafely(
  deps: RunOnceDeps,
  logger: PipelineLogger,
  prHash: string,
  note: string,
): Promise<void> {
  try {
    await deps.queue.recordCheckAttempt(prHash, note);
  } catch (err) {
    logger.log({
      level: "error",
      event: "queue.recheck_error",
      message: `could not record a re-check on ${prHash}: ${messageOf(err)}`,
      fields: { prHash, error: messageOf(err) },
    });
  }
}

async function dismissSafely(
  deps: RunOnceDeps,
  logger: PipelineLogger,
  prHash: string,
  note: string,
): Promise<void> {
  try {
    await deps.queue.dismiss(prHash, note);
  } catch (err) {
    logger.log({
      level: "error",
      event: "queue.dismiss_error",
      message: `could not dismiss ${prHash}: ${messageOf(err)}`,
      fields: { prHash, error: messageOf(err) },
    });
  }
}

function failingIds(result: VerificationResult): string[] {
  return result.checks.filter((c) => c.status === "fail").map((c) => c.id);
}

function indeterminateIds(result: VerificationResult): string[] {
  return result.checks.filter((c) => c.status === "indeterminate").map((c) => c.id);
}
