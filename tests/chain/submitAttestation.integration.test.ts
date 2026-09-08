/**
 * ONE real, state-changing integration exercise of the attestation
 * submission path against a LIVE **testnet** ProofOwl v0.3 instance.
 *
 * Opt-in, exactly like `testnet.integration.test.ts`: skipped unless
 * `PROOFOWL_INTEGRATION=1`, and additionally skipped if
 * `ATTESTOR_SECRET_KEY` is not set. NOT run in default CI.
 *
 *   PROOFOWL_INTEGRATION=1 npm run test:integration
 *
 * TRANSACTION BUDGET — this test submits AT MOST 2 real transactions:
 *   1. link_github   (two-party: synthetic wallet + attestor)
 *   2. submit_attestation  (the path under test)
 * The duplicate-refusal assertion at the end MUST NOT cost a third: it
 * is rejected by `isContributionAlreadyAttested` before any transaction
 * is assembled. `realTxCount` is asserted `=== 2` (`<= 3`).
 *
 * Friendbot account creation for the synthetic wallet is the SDF faucet,
 * not a contract submission, and is not counted against that budget.
 *
 * Everything here targets testnet explicitly and re-confirms the network
 * live (`getNetwork`) before writing. `ATTESTOR_SECRET_KEY` is read from
 * the environment and never logged.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { config as loadDotenv } from "dotenv";
import { Keypair, rpc } from "@stellar/stellar-sdk";
import { basicNodeSigner } from "@stellar/stellar-sdk/contract";
import { prepareLinkGithub, hexToBytes32 } from "@proofowl/contract-sdk";

import { createChainReadClient } from "../../src/chain/readClient.js";
import { createSdkAttestationSubmitter } from "../../src/chain/attestationSubmitter.js";
import { submitAttestation, type SubmitAttestationDeps } from "../../src/chain/submit.js";
import {
  hashGitHubUserIdV1Hex,
  hashGitHubPullRequestV1Hex,
} from "../../src/hashing/identifiers.js";
import type {
  CheckOutcome,
  VerificationCandidate,
  VerificationResult,
} from "../../src/github/types.js";

loadDotenv();

const TESTNET_PASSPHRASE = "Test SDF Network ; September 2015";
const ROTATED_ATTESTOR = "GAVHDK6V2LBGBCBWIZXEHDJAW6ZZKPCKLDANURKJZU4NFDCAV2BYFXEF";
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
  ? "set PROOFOWL_INTEGRATION=1 to run the live testnet submit exercise"
  : SECRET === ""
    ? "ATTESTOR_SECRET_KEY is not set — cannot sign a real submit_attestation"
    : false;

/** A verification result with every gating check passing, for `candidate`. */
function attestableResult(candidate: VerificationCandidate): VerificationResult {
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
    detail: "synthetic — integration test",
    evidence: {},
  }));
  return {
    candidate,
    checks,
    flags: {
      selfMerge: {
        flagged: false,
        detail: "synthetic",
        prAuthorLogin: null,
        prAuthorId: null,
        mergedByLogin: null,
        mergedById: null,
      },
    },
    attestable: true,
    indeterminate: false,
  };
}

async function friendbotFund(address: string): Promise<void> {
  const res = await fetch(`https://friendbot.stellar.org/?addr=${encodeURIComponent(address)}`);
  if (!res.ok && res.status !== 400) {
    throw new Error(`friendbot funding failed (${res.status}): ${await res.text()}`);
  }
}

/** JSON.stringify that survives the `bigint` fields on an AttestationRecord. */
function j(value: unknown): string {
  return JSON.stringify(value, (_k, v) => (typeof v === "bigint" ? v.toString() : v));
}

test(
  "live testnet: link → dry-run → submit_attestation → read-back → duplicate refusal",
  { skip: SKIP, timeout: 300_000 },
  async () => {
    // --- confirm the network live, do not assume ---
    const server = new rpc.Server(config.rpcUrl, { allowHttp: config.allowHttp });
    const net = await server.getNetwork();
    assert.equal(net.passphrase, TESTNET_PASSPHRASE, "RPC must serve Stellar testnet");
    assert.equal(config.networkPassphrase, TESTNET_PASSPHRASE);
    assert.notEqual(
      config.networkPassphrase,
      "Public Global Stellar Network ; September 2015",
      "never mainnet",
    );

    const reads = createChainReadClient(config);

    // --- confirm the attestor identity, both directions ---
    const attestorKp = Keypair.fromSecret(SECRET);
    const attestorPub = attestorKp.publicKey();
    assert.equal(
      attestorPub,
      ROTATED_ATTESTOR,
      "ATTESTOR_SECRET_KEY derives to the rotated attestor",
    );
    assert.equal(
      await reads.getAttestor(),
      ROTATED_ATTESTOR,
      "on-chain get_attestor() is the rotated attestor",
    );

    // --- synthetic, obviously-test identity + repo/PR (unique per run) ---
    const now = Date.now();
    const githubUserId = 900_000_000 + (now % 90_000_000);
    const ghHashHex = hashGitHubUserIdV1Hex(githubUserId);
    const candidate: VerificationCandidate = {
      owner: "proofowl",
      repo: "backend-integration-test",
      issueNumber: 1,
      prNumber: Math.max(1, Number(String(now).slice(-7))),
    };
    const expectedPrHashHex = hashGitHubPullRequestV1Hex(
      candidate.owner,
      candidate.repo,
      candidate.prNumber,
    );
    const verification = attestableResult(candidate);

    // --- a throwaway wallet we control, friendbot-funded ---
    const walletKp = Keypair.random();
    const walletPub = walletKp.publicKey();
    await friendbotFund(walletPub);
    console.log(`[integration] synthetic wallet ${walletPub}`);
    console.log(`[integration] synthetic github_id_hash ${ghHashHex}`);
    console.log(
      `[integration] repo ${candidate.owner}/${candidate.repo} pr #${candidate.prNumber}`,
    );

    let realTxCount = 0;
    let submissionAttempts = 0;

    // ============ TRANSACTION #1: link_github (two-party) ============
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
    console.log(`[integration] TX#1 link_github ${linkHash} SUCCESS`);
    assert.equal(
      await reads.getWalletForGithubIdHash(ghHashHex),
      walletPub,
      "identity now resolves to the synthetic wallet",
    );

    // --- build the submission deps; count real submissions ---
    const deps: SubmitAttestationDeps = {
      reads,
      submitter: createSdkAttestationSubmitter(config, SECRET),
      onSubmissionAttempt: () => {
        realTxCount += 1;
        submissionAttempts += 1;
      },
    };
    const input = { verification, githubIdHash: ghHashHex, issueId: 1n, complexity: 100 as const };

    // ============ DRY RUN (no transaction) ============
    const dry = await submitAttestation({ ...input, dryRun: true }, deps);
    console.log(`[integration] dry-run result: ${j(dry)}`);
    assert.equal(dry.kind, "dry-run-ok");
    if (dry.kind === "dry-run-ok") {
      assert.equal(dry.simulatedCreditWallet, walletPub, "simulation resolves the credit wallet");
      assert.equal(dry.prHashHex, expectedPrHashHex);
      assert.ok(dry.minResourceFee && Number(dry.minResourceFee) > 0, "a real min resource fee");
    }
    assert.equal(submissionAttempts, 0, "a dry run costs no submission attempt");

    // ============ TRANSACTION #2: submit_attestation (real) ============
    const res = await submitAttestation(input, deps);
    console.log(`[integration] submit result: ${j(res)}`);
    assert.equal(res.kind, "submitted");
    if (res.kind !== "submitted") return;
    assert.ok(res.txHash, "a real transaction hash");
    assert.equal(res.creditedWallet, walletPub);
    assert.equal(res.prHashHex, expectedPrHashHex);
    console.log(`[integration] TX#2 submit_attestation ${res.txHash} ledger ${res.ledger}`);

    // --- Horizon confirmation ---
    const horizon = await fetch(`https://horizon-testnet.stellar.org/transactions/${res.txHash}`);
    const hjson = (await horizon.json()) as { successful?: boolean; ledger?: number };
    assert.equal(hjson.successful, true, "Horizon confirms the submit transaction succeeded");
    console.log(`[integration] Horizon: successful=${hjson.successful} ledger=${hjson.ledger}`);

    // --- read it back on-chain, assert it matches exactly ---
    const history = await reads.listAttestations(walletPub);
    const rec = history.find((a) => a.prHashHex === res.prHashHex);
    assert.ok(rec, "the attestation is in the wallet's on-chain history");
    assert.equal(rec.repo, `${candidate.owner}/${candidate.repo}`);
    assert.equal(rec.prNumber, candidate.prNumber);
    assert.equal(rec.complexity, 100);
    assert.equal(rec.githubIdHashHex, ghHashHex);
    assert.equal(rec.issueId, 1n);

    const repRead = await reads.getWalletReputation(walletPub);
    assert.equal(repRead.attestationCount, 1, "exactly one attestation for the synthetic wallet");
    assert.equal(repRead.reputationScore, 100, "reputation score == the submitted complexity");
    console.log(
      `[integration] read-back OK: count=${repRead.attestationCount} score=${repRead.reputationScore}`,
    );

    // ============ DUPLICATE REFUSAL — MUST NOT SPEND A THIRD TX ============
    const dup = await submitAttestation(input, deps);
    console.log(`[integration] duplicate attempt result: ${j(dup)}`);
    assert.equal(dup.kind, "already-attested", "the second attempt is refused by the pre-check");
    if (dup.kind === "already-attested") {
      assert.equal(dup.match.prHashHex, res.prHashHex);
      assert.equal(dup.linkedWallet, walletPub);
    }
    assert.equal(
      submissionAttempts,
      1,
      "the duplicate was refused BEFORE any transaction was assembled",
    );
    assert.equal(realTxCount, 2, "link + submit only — the duplicate consumed no transaction");
    assert.ok(realTxCount <= 3, "within the 3-transaction budget");
    console.log(
      `[integration] REAL TRANSACTIONS SUBMITTED: ${realTxCount} (budget 3) — ` +
        `TX#1 link ${linkHash}, TX#2 submit ${res.txHash}`,
    );
  },
);
