/**
 * The one persistence concern in this pass: a queue of contributions
 * that PASSED GitHub verification but cannot be submitted on-chain yet
 * because the contributor's wallet is not linked to their GitHub
 * identity (submit_attestation would fail `WalletNotLinked`, contract
 * error 7).
 *
 * Deliberately narrow — no leaderboard cache, no attestation mirror, no
 * REST surface. Keyed by `prHash` (the registry's global de-dup key),
 * so a given PR occupies at most one row.
 */

import type { PrismaClient } from "@prisma/client";

import { ValidationError } from "../lib/errors.js";
import {
  ALL_PENDING_STATUSES,
  PENDING_STATUS,
  isPendingStatus,
  type PendingStatus,
} from "./status.js";

const HEX64_RE = /^[0-9a-f]{64}$/;
const ALLOWED_COMPLEXITY = [0, 100, 150, 200];

/** What the caller must supply to enqueue a verified-but-unsubmittable contribution. */
export interface EnqueueInput {
  /** SHA-256 of the canonical PR identifier, lowercase hex (identifier-spec-v1 §2). */
  prHash: string;
  /** SHA-256 of the canonical GitHub identity string, lowercase hex (§1). */
  githubIdHash: string;
  /** The contributor's GitHub numeric user id (decimal string). */
  githubUserId: string;
  /** `"<owner>/<repo>"`, lowercased. */
  repo: string;
  prNumber: number;
  /** Stellar Wave issue id, or 0. */
  issueId?: bigint;
  /** Wave complexity tier: 0, 100, 150, or 200. */
  complexity?: number;
  /** The full VerificationResult that justified enqueuing (stored as JSON). */
  verification: unknown;
  /** Whether verification flagged the PR as author-merged. */
  selfMergeFlagged?: boolean;
}

export interface PendingContributionRow {
  id: string;
  prHash: string;
  githubIdHash: string;
  githubUserId: string;
  repo: string;
  prNumber: number;
  issueId: bigint;
  complexity: number;
  status: PendingStatus;
  statusNote: string | null;
  selfMergeFlagged: boolean;
  attemptCount: number;
  lastCheckedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  verification: unknown;
}

// Minimal shape of the Prisma model row we read back.
interface RawRow {
  id: string;
  prHash: string;
  githubIdHash: string;
  githubUserId: string;
  repo: string;
  prNumber: number;
  issueId: bigint;
  complexity: number;
  status: string;
  statusNote: string | null;
  selfMergeFlagged: boolean;
  attemptCount: number;
  lastCheckedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  verificationJson: string;
}

function toRow(r: RawRow): PendingContributionRow {
  return {
    id: r.id,
    prHash: r.prHash,
    githubIdHash: r.githubIdHash,
    githubUserId: r.githubUserId,
    repo: r.repo,
    prNumber: r.prNumber,
    issueId: r.issueId,
    complexity: r.complexity,
    status: isPendingStatus(r.status) ? r.status : PENDING_STATUS.WAITING_FOR_WALLET_LINK,
    statusNote: r.statusNote,
    selfMergeFlagged: r.selfMergeFlagged,
    attemptCount: r.attemptCount,
    lastCheckedAt: r.lastCheckedAt,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
    verification: safeParse(r.verificationJson),
  };
}

function safeParse(json: string): unknown {
  try {
    return JSON.parse(json);
  } catch {
    return null;
  }
}

function assertHex64(v: string, label: string): void {
  if (!HEX64_RE.test(v)) throw new ValidationError(`${label} must be 64 lowercase hex chars`);
}

export class PendingContributionRepository {
  constructor(private readonly prisma: PrismaClient) {}

  /**
   * Insert (or refresh, if the pr_hash is already queued) a
   * verified-but-unsubmittable contribution. Idempotent on `prHash`.
   * Enqueuing always (re)sets status to WAITING_FOR_WALLET_LINK — this
   * is the only state this pass produces.
   */
  async enqueue(input: EnqueueInput): Promise<PendingContributionRow> {
    assertHex64(input.prHash, "prHash");
    assertHex64(input.githubIdHash, "githubIdHash");
    if (!/^[1-9][0-9]*$/.test(input.githubUserId)) {
      throw new ValidationError("githubUserId must be a positive decimal string");
    }
    if (!/^[a-z0-9._-]+\/[a-z0-9._-]+$/.test(input.repo)) {
      throw new ValidationError('repo must be "<owner>/<repo>" lowercased');
    }
    if (!Number.isInteger(input.prNumber) || input.prNumber < 1 || input.prNumber > 0xffff_ffff) {
      throw new ValidationError("prNumber must be a u32 >= 1");
    }
    const complexity = input.complexity ?? 0;
    if (!ALLOWED_COMPLEXITY.includes(complexity)) {
      throw new ValidationError("complexity must be one of 0, 100, 150, 200");
    }

    const data = {
      githubIdHash: input.githubIdHash,
      githubUserId: input.githubUserId,
      repo: input.repo,
      prNumber: input.prNumber,
      issueId: input.issueId ?? 0n,
      complexity,
      verificationJson: JSON.stringify(input.verification ?? null),
      selfMergeFlagged: input.selfMergeFlagged ?? false,
      status: PENDING_STATUS.WAITING_FOR_WALLET_LINK,
      statusNote: "enqueued: GitHub verification passed, wallet not linked on-chain",
    };

    const row = (await this.prisma.pendingContribution.upsert({
      where: { prHash: input.prHash },
      create: { prHash: input.prHash, ...data },
      update: data,
    })) as RawRow;
    return toRow(row);
  }

  async getByPrHash(prHash: string): Promise<PendingContributionRow | null> {
    const row = (await this.prisma.pendingContribution.findUnique({
      where: { prHash },
    })) as RawRow | null;
    return row ? toRow(row) : null;
  }

  /** Contributions still waiting for a wallet link, oldest first. */
  async listWaiting(limit = 100): Promise<PendingContributionRow[]> {
    const rows = (await this.prisma.pendingContribution.findMany({
      where: { status: PENDING_STATUS.WAITING_FOR_WALLET_LINK },
      orderBy: { createdAt: "asc" },
      take: limit,
    })) as RawRow[];
    return rows.map(toRow);
  }

  async listByGithubIdHash(githubIdHash: string): Promise<PendingContributionRow[]> {
    const rows = (await this.prisma.pendingContribution.findMany({
      where: { githubIdHash },
      orderBy: { createdAt: "asc" },
    })) as RawRow[];
    return rows.map(toRow);
  }

  /** Record that a re-check ran (wallet still not linked). */
  async recordCheckAttempt(prHash: string, note?: string): Promise<PendingContributionRow> {
    const row = (await this.prisma.pendingContribution.update({
      where: { prHash },
      data: {
        attemptCount: { increment: 1 },
        lastCheckedAt: new Date(),
        ...(note ? { statusNote: note } : {}),
      },
    })) as RawRow;
    return toRow(row);
  }

  private async setStatus(
    prHash: string,
    status: PendingStatus,
    note: string,
  ): Promise<PendingContributionRow> {
    const row = (await this.prisma.pendingContribution.update({
      where: { prHash },
      data: { status, statusNote: note, lastCheckedAt: new Date() },
    })) as RawRow;
    return toRow(row);
  }

  /** The wallet linked — this contribution can now be submitted (later pass). */
  markReadyToSubmit(
    prHash: string,
    note = "wallet linked on-chain",
  ): Promise<PendingContributionRow> {
    return this.setStatus(prHash, PENDING_STATUS.READY_TO_SUBMIT, note);
  }

  /** The pr_hash is already recorded on-chain; drop it from the queue. */
  markAlreadyAttested(
    prHash: string,
    note = "pr_hash already recorded on-chain",
  ): Promise<PendingContributionRow> {
    return this.setStatus(prHash, PENDING_STATUS.ALREADY_ATTESTED, note);
  }

  /** Remove from consideration. */
  dismiss(prHash: string, note: string): Promise<PendingContributionRow> {
    return this.setStatus(prHash, PENDING_STATUS.DISMISSED, note);
  }

  async countByStatus(): Promise<Record<PendingStatus, number>> {
    const entries = await Promise.all(
      ALL_PENDING_STATUSES.map(
        async (status) =>
          [status, await this.prisma.pendingContribution.count({ where: { status } })] as const,
      ),
    );
    return Object.fromEntries(entries) as Record<PendingStatus, number>;
  }
}
