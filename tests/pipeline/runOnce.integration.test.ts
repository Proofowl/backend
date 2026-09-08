/**
 * ONE opt-in, state-changing exercise of the whole pipeline against the
 * LIVE testnet v0.3 ProofOwl instance:
 *
 *   run #1  discovery → verify → submit  ⇒  wallet not linked ⇒ ENQUEUE   (0 tx)
 *   TX #1   link_github  (synthetic wallet ↔ synthetic github_id_hash)
 *   run #2  queue drain  ⇒  wallet now linked ⇒  submit_attestation       (1 tx)
 *   read-back on-chain: the recorded attestation matches what we sent
 *   run #3  everything already on-chain ⇒ already-attested                (0 tx)
 *
 * TRANSACTION BUDGET — this test submits EXACTLY 2 real transactions
 * (TX #1 link, TX #2 submit). `realTxCount` is asserted `=== 2`. The
 * rediscovery in run #2 and the whole of run #3 are refused by
 * `isContributionAlreadyAttested` before any transaction is assembled,
 * so they cost nothing.
 *
 * Opt-in exactly like the other `*.integration.test.ts`: skipped unless
 * `PROOFOWL_INTEGRATION=1` AND `ATTESTOR_SECRET_KEY` is set. Not in the
 * default `npm test` / CI path. `ATTESTOR_SECRET_KEY` is read from the
 * environment and never logged.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { config as loadDotenv } from "dotenv";
import { Keypair, rpc } from "@stellar/stellar-sdk";
import { basicNodeSigner } from "@stellar/stellar-sdk/contract";
import { prepareLinkGithub, hexToBytes32 } from "@proofowl/contract-sdk";

import { createChainReadClient } from "../../src/chain/readClient.js";
import { createSdkAttestationSubmitter } from "../../src/chain/attestationSubmitter.js";
import { StaticApprovedOrgsSource } from "../../src/github/approvedOrgs.js";
import type { GitHubClient, LinkedPullRequest } from "../../src/github/client.js";
import type {
  CheckOutcome,
  GitHubIssue,
  VerificationCandidate,
  VerificationResult,
} from "../../src/github/types.js";
import {
  hashGitHubPullRequestV1Hex,
  hashGitHubUserIdV1Hex,
} from "../../src/hashing/identifiers.js";
import { PendingContributionRepository } from "../../src/queue/repository.js";
import { PENDING_STATUS } from "../../src/queue/status.js";
import { createCollectingLogger } from "../../src/pipeline/log.js";
import { runOnce, type RunOnceDeps } from "../../src/pipeline/runOnce.js";
import { createTestDb, type TestDb } from "../queue/testDb.js";

loadDotenv();

const TESTNET_PASSPHRASE = "Test SDF Network ; September 2015";
const MAINNET_PASSPHRASE = "Public Global Stellar Network ; September 2015";
const V03_CONTRACT_ID = "CAIDTSVPQICTA2VLE6BSQYHEELHGPZWQDYWKSDBRW4LYPZH6Q44UTAOA";

const config = {
  contractId: process.env.PROOFOWL_CONTRACT_ID ?? V03_CONTRACT_ID,
  rpcUrl: process.env.PROOFOWL_RPC_URL ?? "https://soroban-testnet.stellar.org",
  networkPassphrase: process.env.PROOFOWL_NETWORK_PASSPHRASE ?? TESTNET_PASSPHRASE,
  allowHttp: false,
};

const ENABLED = process.env.PROOFOWL_INTEGRATION === "1";
const SECRET = process.env.ATTESTOR_SECRET_KEY ?? "";
const SKIP = !ENABLED
  ? "set PROOFOWL_INTEGRATION=1 to run the live pipeline exercise"
  : SECRET === ""
    ? "ATTESTOR_SECRET_KEY is not set — cannot sign a real submit_attestation"
    : false;

/** A verification result with every gating check passing, for `candidate`. */
function attestableResult(
  candidate: VerificationCandidate,
  prAuthorId: number,
): VerificationResult {
  const ids = [
    "repo_in_approved_orgs",
    "issue_has_wave_label",
    "wave_label_predates_pr_merge",
    "pr_closes_issue",
    "pr_is_merged",
  ] as const;
  const checks: CheckOutcome[] = ids.map((id) => ({
    id,
    status: "pass",
    detail: "synthetic — pipeline integration test",
    evidence: {},
  }));
  return {
    candidate,
    checks,
    flags: {
      selfMerge: {
        flagged: false,
        detail: "synthetic",
        prAuthorLogin: "synthetic-contributor",
        prAuthorId,
        mergedByLogin: "synthetic-maintainer",
        mergedById: prAuthorId + 1,
      },
    },
    attestable: true,
    indeterminate: false,
  };
}

/** A GitHub client that yields exactly one closed Wave issue + one merged linked PR. */
function oneCandidateClient(c: VerificationCandidate): GitHubClient {
  const unused = (): never => {
    throw new Error("not used by discovery");
  };
  return {
    getPullRequest: unused,
    getIssue: unused,
    getIssueLabeledEvents: unused,
    getClosingIssueNumbers: unused,
    async listRepoIssues(owner, repo) {
      if (owner !== c.owner || repo !== c.repo) return [];
      const issue: GitHubIssue = {
        number: c.issueNumber,
        state: "closed",
        labels: [{ name: "Wave" }],
        html_url: `https://github.com/${owner}/${repo}/issues/${c.issueNumber}`,
      };
      return [issue];
    },
    async getIssueLinkedPullRequests(owner, repo, issueNumber): Promise<LinkedPullRequest[]> {
      if (owner !== c.owner || repo !== c.repo || issueNumber !== c.issueNumber) return [];
      return [{ number: c.prNumber, merged: true }];
    },
  };
}

async function friendbotFund(address: string): Promise<void> {
  const res = await fetch(`https://friendbot.stellar.org/?addr=${encodeURIComponent(address)}`);
  if (!res.ok && res.status !== 400) {
    throw new Error(`friendbot funding failed (${res.status}): ${await res.text()}`);
  }
}

function j(value: unknown): string {
  return JSON.stringify(value, (_k, v) => (typeof v === "bigint" ? v.toString() : v));
}

test(
  "live testnet: pipeline enqueues an unlinked contribution, then drains + submits it after link",
  { skip: SKIP, timeout: 300_000 },
  async () => {
    // --- confirm the network live, do not assume ---
    const server = new rpc.Server(config.rpcUrl, { allowHttp: config.allowHttp });
    const net = await server.getNetwork();
    assert.equal(net.passphrase, TESTNET_PASSPHRASE, "RPC must serve Stellar testnet");
    assert.equal(config.networkPassphrase, TESTNET_PASSPHRASE);
    assert.notEqual(config.networkPassphrase, MAINNET_PASSPHRASE, "never mainnet");

    const reads = createChainReadClient(config);

    // --- confirm the attestor identity, both directions ---
    const attestorKp = Keypair.fromSecret(SECRET);
    const attestorPub = attestorKp.publicKey();
    const onChainAttestor = await reads.getAttestor();
    assert.equal(
      onChainAttestor,
      attestorPub,
      "ATTESTOR_SECRET_KEY must derive to the contract's current on-chain attestor",
    );

    // --- synthetic, obviously-test identity + repo/PR (unique per run) ---
    const now = Date.now();
    const githubUserId = 910_000_000 + (now % 80_000_000);
    const ghHashHex = hashGitHubUserIdV1Hex(githubUserId);
    const candidate: VerificationCandidate = {
      owner: "proofowl",
      repo: "backend-pipeline-integration-test",
      issueNumber: 1,
      prNumber: Math.max(1, Number(String(now).slice(-7))),
    };
    const expectedPrHashHex = hashGitHubPullRequestV1Hex(
      candidate.owner,
      candidate.repo,
      candidate.prNumber,
    );

    // --- a throwaway wallet we control, friendbot-funded ---
    const walletKp = Keypair.random();
    const walletPub = walletKp.publicKey();
    await friendbotFund(walletPub);
    console.log(`[pipeline-it] synthetic wallet ${walletPub}`);
    console.log(`[pipeline-it] synthetic github_id_hash ${ghHashHex} (user id ${githubUserId})`);
    console.log(
      `[pipeline-it] synthetic ${candidate.owner}/${candidate.repo} issue #${candidate.issueNumber} pr #${candidate.prNumber}`,
    );

    // --- throwaway DB for the queue ---
    let db: TestDb | undefined;
    let realTxCount = 0;
    let submissionAttempts = 0;

    try {
      db = await createTestDb();
      const queue = new PendingContributionRepository(db.prisma);
      const logger = createCollectingLogger();

      const deps: RunOnceDeps = {
        queue,
        reads,
        submitter: createSdkAttestationSubmitter(config, SECRET),
        github: oneCandidateClient(candidate),
        approvedOrgs: new StaticApprovedOrgsSource(["proofowl"]),
        seeds: [
          {
            owner: candidate.owner,
            repo: candidate.repo,
            ownerRepo: `${candidate.owner}/${candidate.repo}`,
          },
        ],
        // Stub verification — the six gating checks are exercised by
        // tests/github/verify.test.ts; here we only care about the
        // discover → submit/queue → drain wiring.
        verify: async () => attestableResult(candidate, githubUserId),
        onSubmissionAttempt: () => {
          realTxCount += 1;
          submissionAttempts += 1;
        },
        logger,
      };

      // ============ RUN #1 — wallet not linked ⇒ ENQUEUE (0 tx) ============
      const summary1 = await runOnce(deps);
      console.log(`[pipeline-it] run #1 summary: ${j(summary1)}`);
      assert.equal(summary1.discovery.candidates, 1);
      assert.equal(summary1.discovery.attestable, 1);
      assert.equal(summary1.discovery.submitOutcomes["not-submittable"], 1);
      assert.equal(summary1.discovery.enqueued, 1);
      assert.equal(
        summary1.realSubmissionAttempts,
        0,
        "no submission attempt for an unlinked identity",
      );
      assert.equal(realTxCount, 0, "run #1 broadcasts nothing");

      const queued = await queue.getByPrHash(expectedPrHashHex);
      assert.ok(queued, "the contribution is now in the queue");
      assert.equal(queued.status, PENDING_STATUS.WAITING_FOR_WALLET_LINK);
      assert.equal(queued.githubIdHash, ghHashHex);
      assert.equal(queued.repo, `${candidate.owner}/${candidate.repo}`);

      // ============ TX #1 — link_github (two-party) ============
      const { transaction: linkTx } = await prepareLinkGithub(config, {
        wallet: walletPub,
        attestor: attestorPub,
        githubIdHash: hexToBytes32(ghHashHex),
      });
      await linkTx.signAuthEntries({
        address: attestorPub,
        signAuthEntry: basicNodeSigner(attestorKp, TESTNET_PASSPHRASE).signAuthEntry,
      });
      realTxCount += 1;
      const linkSent = await linkTx.signAndSend({
        signTransaction: basicNodeSigner(walletKp, TESTNET_PASSPHRASE).signTransaction,
      });
      const linkHash = linkSent.sendTransactionResponse?.hash ?? null;
      assert.equal(
        linkSent.getTransactionResponse?.status,
        "SUCCESS",
        `link_github must succeed (tx ${linkHash})`,
      );
      console.log(`[pipeline-it] TX#1 link_github ${linkHash} SUCCESS`);
      assert.equal(
        await reads.getWalletForGithubIdHash(ghHashHex),
        walletPub,
        "identity now resolves to the synthetic wallet",
      );

      // ============ RUN #2 — queue drain submits for real (1 tx) ============
      const summary2 = await runOnce(deps);
      console.log(`[pipeline-it] run #2 summary: ${j(summary2)}`);
      assert.equal(summary2.queueDrain.scanned, 1, "the queued row was re-checked");
      assert.equal(summary2.queueDrain.submitOutcomes.submitted, 1, "and submitted on-chain");
      assert.equal(summary2.realSubmissionAttempts, 1);
      assert.equal(submissionAttempts, 1, "exactly one real submission attempt");
      assert.equal(summary2.submittedTxHashes.length, 1);
      // Rediscovery in the same pass is refused by the dedup pre-check — costs no tx.
      assert.equal(summary2.discovery.submitOutcomes["already-attested"], 1);
      assert.equal(realTxCount, 2, "link + submit only");

      const submitHash = summary2.submittedTxHashes[0]!;
      console.log(`[pipeline-it] TX#2 submit_attestation ${submitHash}`);

      const drained = await queue.getByPrHash(expectedPrHashHex);
      assert.equal(
        drained?.status,
        PENDING_STATUS.ALREADY_ATTESTED,
        "queue row cleared after submit",
      );

      // --- Horizon confirmation of TX #2 ---
      const horizon = await fetch(`https://horizon-testnet.stellar.org/transactions/${submitHash}`);
      const hjson = (await horizon.json()) as { successful?: boolean; ledger?: number };
      assert.equal(hjson.successful, true, "Horizon confirms the submit transaction succeeded");
      console.log(`[pipeline-it] Horizon: successful=${hjson.successful} ledger=${hjson.ledger}`);

      // --- read the attestation back on-chain, assert it matches ---
      const history = await reads.listAttestations(walletPub);
      const rec = history.find((a) => a.prHashHex === expectedPrHashHex);
      assert.ok(rec, "the attestation is in the wallet's on-chain history");
      assert.equal(rec.repo, `${candidate.owner}/${candidate.repo}`);
      assert.equal(rec.prNumber, candidate.prNumber);
      assert.equal(rec.complexity, 0, "pipeline records complexity 0 (tier unknown at discovery)");
      assert.equal(rec.githubIdHashHex, ghHashHex);
      assert.equal(rec.issueId, BigInt(candidate.issueNumber));

      const rep = await reads.getWalletReputation(walletPub);
      assert.equal(rep.attestationCount, 1, "exactly one attestation for the synthetic wallet");
      console.log(
        `[pipeline-it] read-back OK: count=${rep.attestationCount} score=${rep.reputationScore}`,
      );

      // ============ RUN #3 — all on-chain already ⇒ 0 tx ============
      const summary3 = await runOnce(deps);
      console.log(`[pipeline-it] run #3 summary: ${j(summary3)}`);
      assert.equal(summary3.queueDrain.scanned, 0, "the row is no longer WAITING");
      assert.equal(summary3.discovery.submitOutcomes["already-attested"], 1);
      assert.equal(summary3.realSubmissionAttempts, 0);
      assert.equal(realTxCount, 2, "run #3 broadcasts nothing — still 2 total");

      assert.equal(realTxCount, 2, "TOTAL real testnet transactions this test === 2");
      assert.ok(realTxCount <= 2, "within the 2-transaction budget");
      console.log(
        `[pipeline-it] REAL TRANSACTIONS SUBMITTED: ${realTxCount} (budget 2) — ` +
          `TX#1 link ${linkHash}, TX#2 submit ${submitHash}`,
      );
    } finally {
      await db?.destroy();
    }
  },
);
