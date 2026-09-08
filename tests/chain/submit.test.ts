/**
 * Offline unit tests for the attestation submission orchestrator
 * (`submitAttestation`) and the SDK submitter's local guards.
 *
 * NO network, NO real key material. The chain-read boundary and the
 * write boundary (`AttestationSubmitter`) are both fakes; where a test
 * needs a secret key it uses a freshly generated throwaway
 * (`Keypair.random().secret()`), never the real `.env` value.
 *
 * The one real, on-chain exercise of this path is the opt-in
 * `submitAttestation.integration.test.ts`.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { Keypair } from "@stellar/stellar-sdk";

import {
  submitAttestation,
  TESTNET_NETWORK_PASSPHRASE,
  MAINNET_NETWORK_PASSPHRASE,
  type AttestationSubmitter,
  type PreparedAttestationTx,
  type SentAttestationOutcome,
  type SubmissionAttemptContext,
  type SubmitAttestationInput,
  type SubmitAttestationDeps,
} from "../../src/chain/submit.js";
import { createSdkAttestationSubmitter } from "../../src/chain/attestationSubmitter.js";
import type { AttestationRecord } from "../../src/chain/attestationDecode.js";
import type { ChainReadClient } from "../../src/chain/readClient.js";
import type {
  CheckOutcome,
  VerificationCandidate,
  VerificationResult,
} from "../../src/github/types.js";
import { hashGitHubPullRequestV1Hex } from "../../src/hashing/identifiers.js";

// --- fixtures ------------------------------------------------------------

/** Obviously-fake 64-hex identity hash. */
const GH_HASH = "ab".repeat(32);
/** A valid-shaped, throwaway `G...` wallet address. */
const LINKED_WALLET = "GCNHX5ORRQLJOFQELVAXZ3PQMIAQ3B3QLKZQRV6FXGICZEMQRWY3TRKG";
/** A deliberately fake, obviously-test repo/PR — never a real Wave identifier. */
const CANDIDATE: VerificationCandidate = {
  owner: "proofowl",
  repo: "backend-integration-test",
  issueNumber: 7,
  prNumber: 4242,
};
const PR_HASH_HEX = hashGitHubPullRequestV1Hex(CANDIDATE.owner, CANDIDATE.repo, CANDIDATE.prNumber);

const GATING_CHECK_IDS = [
  "repo_in_approved_orgs",
  "issue_has_wave_label",
  "wave_label_predates_pr_merge",
  "pr_closes_issue",
  "pr_is_merged",
] as const;

function makeVerification(
  over: { attestable?: boolean; indeterminate?: boolean; failing?: string[] } = {},
): VerificationResult {
  const failing = new Set(over.failing ?? (over.attestable === false ? ["pr_is_merged"] : []));
  const checks: CheckOutcome[] = GATING_CHECK_IDS.map((id) => ({
    id,
    status: failing.has(id) ? "fail" : "pass",
    detail: "",
    evidence: {},
  }));
  return {
    candidate: CANDIDATE,
    checks,
    flags: {
      selfMerge: {
        flagged: false,
        detail: "",
        prAuthorLogin: null,
        prAuthorId: null,
        mergedByLogin: null,
        mergedById: null,
      },
    },
    attestable: over.attestable ?? failing.size === 0,
    indeterminate: over.indeterminate ?? false,
  };
}

function attestationRecord(over: Partial<AttestationRecord> = {}): AttestationRecord {
  return {
    githubIdHashHex: GH_HASH,
    repo: `${CANDIDATE.owner}/${CANDIDATE.repo}`,
    prNumber: CANDIDATE.prNumber,
    issueId: 7n,
    complexity: 100,
    prHashHex: PR_HASH_HEX,
    timestamp: 1_788_000_000n,
    sequence: 0,
    ...over,
  };
}

type ReadOverrides = Partial<
  Pick<ChainReadClient, "getWalletForGithubIdHash" | "isContributionAlreadyAttested">
>;

function fakeReads(over: ReadOverrides = {}): ChainReadClient {
  const base = {
    getWalletForGithubIdHash: async (): Promise<string | null> => LINKED_WALLET,
    isContributionAlreadyAttested: async () => ({
      prHashHex: PR_HASH_HEX,
      githubIdHashHex: GH_HASH,
      attested: false,
      linkedWallet: LINKED_WALLET,
      match: null,
      confidence: "checked-linked-wallet" as const,
    }),
  };
  return { ...base, ...over } as unknown as ChainReadClient;
}

const READS_MUST_NOT_BE_TOUCHED: ChainReadClient = fakeReads({
  getWalletForGithubIdHash: async () => {
    throw new Error("chain reads must not be touched in this case");
  },
  isContributionAlreadyAttested: async () => {
    throw new Error("chain reads must not be touched in this case");
  },
});

const PREPARE_MUST_NOT_BE_CALLED: AttestationSubmitter["prepare"] = async () => {
  throw new Error("submitter.prepare must not be called in this case");
};

function submitter(
  prepare: AttestationSubmitter["prepare"],
  network: string = TESTNET_NETWORK_PASSPHRASE,
): AttestationSubmitter {
  return { network, prepare };
}

function baseInput(over: Partial<SubmitAttestationInput> = {}): SubmitAttestationInput {
  return {
    verification: makeVerification(),
    githubIdHash: GH_HASH,
    issueId: 7n,
    complexity: 100,
    ...over,
  };
}

interface Spy {
  deps: SubmitAttestationDeps;
  attempts: SubmissionAttemptContext[];
}
function withAttemptSpy(partial: Omit<SubmitAttestationDeps, "onSubmissionAttempt">): Spy {
  const attempts: SubmissionAttemptContext[] = [];
  return {
    attempts,
    deps: { ...partial, onSubmissionAttempt: (ctx) => attempts.push(ctx) },
  };
}

// --- 1. network guard + short-circuits ------------------------------

test("refuses a submitter bound to Stellar mainnet, before any I/O", async () => {
  await assert.rejects(
    submitAttestation(baseInput(), {
      reads: READS_MUST_NOT_BE_TOUCHED,
      submitter: submitter(PREPARE_MUST_NOT_BE_CALLED, MAINNET_NETWORK_PASSPHRASE),
    }),
    /mainnet/i,
  );
});

test("refuses a submitter on an unconfirmed (non-testnet) network", async () => {
  await assert.rejects(
    submitAttestation(baseInput(), {
      reads: READS_MUST_NOT_BE_TOUCHED,
      submitter: submitter(PREPARE_MUST_NOT_BE_CALLED, "Some Other Network ; 2020"),
    }),
    /not the confirmed\s+Stellar testnet passphrase|unconfirmed network/i,
  );
});

test("a non-attestable verification result short-circuits to not-attestable (no reads, no prepare)", async () => {
  const res = await submitAttestation(
    baseInput({ verification: makeVerification({ failing: ["pr_is_merged", "pr_closes_issue"] }) }),
    { reads: READS_MUST_NOT_BE_TOUCHED, submitter: submitter(PREPARE_MUST_NOT_BE_CALLED) },
  );
  assert.equal(res.kind, "not-attestable");
  assert.equal(res.kind === "not-attestable" && res.indeterminate, false);
  assert.deepEqual(res.kind === "not-attestable" ? [...res.failingCheckIds].sort() : null, [
    "pr_closes_issue",
    "pr_is_merged",
  ]);
});

test("an unlinked identity short-circuits to not-submittable (needs queueing), prepare never called", async () => {
  const { deps, attempts } = withAttemptSpy({
    reads: fakeReads({ getWalletForGithubIdHash: async () => null }),
    submitter: submitter(PREPARE_MUST_NOT_BE_CALLED),
  });
  const res = await submitAttestation(baseInput(), deps);
  assert.equal(res.kind, "not-submittable");
  assert.equal(res.kind === "not-submittable" && res.reason, "wallet-not-linked");
  assert.equal(res.kind === "not-submittable" && res.prHashHex, PR_HASH_HEX);
  assert.equal(attempts.length, 0);
});

test("an already-attested PR is refused WITHOUT assembling a transaction", async () => {
  const match = attestationRecord();
  const { deps, attempts } = withAttemptSpy({
    reads: fakeReads({
      isContributionAlreadyAttested: async () => ({
        prHashHex: PR_HASH_HEX,
        githubIdHashHex: GH_HASH,
        attested: true,
        linkedWallet: LINKED_WALLET,
        match,
        confidence: "checked-linked-wallet" as const,
      }),
    }),
    submitter: submitter(PREPARE_MUST_NOT_BE_CALLED),
  });
  const res = await submitAttestation(baseInput(), deps);
  assert.equal(res.kind, "already-attested");
  assert.equal(res.kind === "already-attested" && res.match.prHashHex, PR_HASH_HEX);
  assert.equal(res.kind === "already-attested" && res.linkedWallet, LINKED_WALLET);
  assert.equal(attempts.length, 0, "no submission attempt for an already-attested PR");
});

test("a malformed githubIdHash throws (a caller bug, not a runtime result)", async () => {
  await assert.rejects(
    submitAttestation(baseInput({ githubIdHash: "not-hex" }), {
      reads: READS_MUST_NOT_BE_TOUCHED,
      submitter: submitter(PREPARE_MUST_NOT_BE_CALLED),
    }),
    /64-char hex/,
  );
});

// --- 2. contract rejection at simulation --------------------------

/** A prepared tx whose dry run FAILED with `simulationError`. */
function preparedSimError(simulationError: string): AttestationSubmitter["prepare"] {
  return async () => ({
    simulationError,
    simulatedCreditWallet: null,
    minResourceFee: null,
    send: async () => {
      throw new Error("send() must not be called after a simulation error");
    },
  });
}

const CONTRACT_REJECTIONS: ReadonlyArray<{ raw: string; code: number; name: string }> = [
  { raw: "HostError: Error(Contract, #7)", code: 7, name: "WalletNotLinked" },
  { raw: "HostError: Error(Contract, #6)", code: 6, name: "DuplicateAttestation" },
  { raw: "HostError: Error(Contract, #8)", code: 8, name: "InvalidComplexity" },
];

for (const { raw, code, name } of CONTRACT_REJECTIONS) {
  test(`simulation error ${JSON.stringify(raw)} -> contract-rejected ${name}`, async () => {
    const { deps, attempts } = withAttemptSpy({
      reads: fakeReads(),
      submitter: submitter(preparedSimError(raw)),
    });
    const res = await submitAttestation(baseInput(), deps);
    assert.equal(res.kind, "contract-rejected");
    if (res.kind !== "contract-rejected") return;
    assert.equal(res.phase, "simulation");
    assert.equal(res.errorCode, code);
    assert.equal(res.errorName, name);
    assert.equal(res.detail, raw);
    assert.equal(attempts.length, 0, "a simulation rejection costs no submission attempt");
  });
}

test("a bare contract-error variant name is classified too", async () => {
  const res = await submitAttestation(baseInput(), {
    reads: fakeReads(),
    submitter: submitter(preparedSimError("DuplicateAttestation")),
  });
  assert.equal(res.kind, "contract-rejected");
  if (res.kind !== "contract-rejected") return;
  assert.equal(res.errorCode, 6);
  assert.equal(res.errorName, "DuplicateAttestation");
});

test("an unrecognised simulation error -> contract-rejected with errorCode null, detail preserved", async () => {
  const raw = "HostError: something entirely unexpected happened";
  const res = await submitAttestation(baseInput(), {
    reads: fakeReads(),
    submitter: submitter(preparedSimError(raw)),
  });
  assert.equal(res.kind, "contract-rejected");
  if (res.kind !== "contract-rejected") return;
  assert.equal(res.errorCode, null);
  assert.equal(res.errorName, "unknown");
  assert.equal(res.detail, raw);
});

test("prepare() THROWING a value that carries a contract code -> contract-rejected", async () => {
  const { deps, attempts } = withAttemptSpy({
    reads: fakeReads(),
    submitter: submitter(async () => {
      throw new Error("simulation failed: HostError: Error(Contract, #7)");
    }),
  });
  const res = await submitAttestation(baseInput(), deps);
  assert.equal(res.kind, "contract-rejected");
  if (res.kind !== "contract-rejected") return;
  assert.equal(res.errorCode, 7);
  assert.equal(res.errorName, "WalletNotLinked");
  assert.equal(attempts.length, 0);
});

// --- 3. rpc-error, submission-failed, dry-run, happy path -----------

function preparedOk(over: Partial<PreparedAttestationTx> = {}): PreparedAttestationTx {
  return {
    simulationError: null,
    simulatedCreditWallet: LINKED_WALLET,
    minResourceFee: "12345",
    send: async (): Promise<SentAttestationOutcome> => ({
      status: "SUCCESS",
      txHash: "abc123",
      ledger: 999,
      creditedWallet: LINKED_WALLET,
      detail: null,
    }),
    ...over,
  };
}

test("a network failure reading the wallet link -> rpc-error (during wallet-link-read)", async () => {
  const res = await submitAttestation(baseInput(), {
    reads: fakeReads({
      getWalletForGithubIdHash: async () => {
        throw new Error("fetch failed");
      },
    }),
    submitter: submitter(PREPARE_MUST_NOT_BE_CALLED),
  });
  assert.equal(res.kind, "rpc-error");
  assert.equal(res.kind === "rpc-error" && res.during, "wallet-link-read");
});

test("a network failure on the already-attested read -> rpc-error (during already-attested-read)", async () => {
  const res = await submitAttestation(baseInput(), {
    reads: fakeReads({
      isContributionAlreadyAttested: async () => {
        throw new Error("getaddrinfo ENOTFOUND soroban-testnet.stellar.org");
      },
    }),
    submitter: submitter(PREPARE_MUST_NOT_BE_CALLED),
  });
  assert.equal(res.kind, "rpc-error");
  assert.equal(res.kind === "rpc-error" && res.during, "already-attested-read");
});

test("prepare() rejecting with a transport error -> rpc-error (during prepare)", async () => {
  const res = await submitAttestation(baseInput(), {
    reads: fakeReads(),
    submitter: submitter(async () => {
      throw new Error("UND_ERR_CONNECT_TIMEOUT");
    }),
  });
  assert.equal(res.kind, "rpc-error");
  assert.equal(res.kind === "rpc-error" && res.during, "prepare");
});

test("dryRun: a clean simulation -> dry-run-ok, nothing sent, no attempt counted", async () => {
  const { deps, attempts } = withAttemptSpy({
    reads: fakeReads(),
    submitter: submitter(async () =>
      preparedOk({
        send: async () => {
          throw new Error("send() must not run for a dry run");
        },
      }),
    ),
  });
  const res = await submitAttestation(baseInput({ dryRun: true }), deps);
  assert.equal(res.kind, "dry-run-ok");
  if (res.kind !== "dry-run-ok") return;
  assert.equal(res.simulatedCreditWallet, LINKED_WALLET);
  assert.equal(res.minResourceFee, "12345");
  assert.equal(res.prHashHex, PR_HASH_HEX);
  assert.equal(res.repo, "proofowl/backend-integration-test");
  assert.equal(attempts.length, 0);
});

test("dryRun still surfaces a contract rejection instead of dry-run-ok", async () => {
  const res = await submitAttestation(baseInput({ dryRun: true }), {
    reads: fakeReads(),
    submitter: submitter(preparedSimError("HostError: Error(Contract, #6)")),
  });
  assert.equal(res.kind, "contract-rejected");
  assert.equal(res.kind === "contract-rejected" && res.errorName, "DuplicateAttestation");
});

test("happy path: submitted, onSubmissionAttempt fired exactly once with the derived pr_hash", async () => {
  const { deps, attempts } = withAttemptSpy({
    reads: fakeReads(),
    submitter: submitter(async () =>
      preparedOk({
        send: async () => ({
          status: "SUCCESS",
          txHash: "cafef00d",
          ledger: 4_600_000,
          creditedWallet: LINKED_WALLET,
          detail: null,
        }),
      }),
    ),
  });
  const res = await submitAttestation(baseInput(), deps);
  assert.equal(res.kind, "submitted");
  if (res.kind !== "submitted") return;
  assert.equal(res.txHash, "cafef00d");
  assert.equal(res.ledger, 4_600_000);
  assert.equal(res.creditedWallet, LINKED_WALLET);
  assert.equal(res.complexity, 100);
  assert.equal(res.repo, "proofowl/backend-integration-test");
  assert.equal(res.prNumber, 4242);
  assert.equal(res.prHashHex, PR_HASH_HEX);
  assert.equal(attempts.length, 1);
  assert.equal(attempts[0]?.prHashHex, PR_HASH_HEX);
  assert.equal(attempts[0]?.prNumber, 4242);
  assert.equal(attempts[0]?.repo, "proofowl/backend-integration-test");
});

test("send reports ERROR (rejected at submission) -> submission-failed, stage 'send', attempt still counted", async () => {
  const { deps, attempts } = withAttemptSpy({
    reads: fakeReads(),
    submitter: submitter(async () =>
      preparedOk({
        send: async () => ({
          status: "ERROR",
          txHash: "e11",
          ledger: null,
          creditedWallet: null,
          detail: "rejected at submission (errorResultXdr: AAAA)",
        }),
      }),
    ),
  });
  const res = await submitAttestation(baseInput(), deps);
  assert.equal(res.kind, "submission-failed");
  if (res.kind !== "submission-failed") return;
  assert.equal(res.stage, "send");
  assert.equal(res.status, "ERROR");
  assert.equal(res.txHash, "e11");
  assert.equal(attempts.length, 1, "a spent submission attempt is still counted");
});

test("send reports FAILED (failed after inclusion) -> submission-failed, stage 'confirm'", async () => {
  const res = await submitAttestation(baseInput(), {
    reads: fakeReads(),
    submitter: submitter(async () =>
      preparedOk({
        send: async () => ({
          status: "FAILED",
          txHash: "f22",
          ledger: 4_600_001,
          creditedWallet: null,
          detail: "transaction failed after inclusion",
        }),
      }),
    ),
  });
  assert.equal(res.kind, "submission-failed");
  assert.equal(res.kind === "submission-failed" && res.stage, "confirm");
  assert.equal(res.kind === "submission-failed" && res.txHash, "f22");
});

test("send reports NOT_FOUND (unconfirmed) -> submission-failed, stage 'confirm'", async () => {
  const res = await submitAttestation(baseInput(), {
    reads: fakeReads(),
    submitter: submitter(async () =>
      preparedOk({
        send: async () => ({
          status: "NOT_FOUND",
          txHash: "n33",
          ledger: null,
          creditedWallet: null,
          detail: "transaction not confirmed within the client wait window",
        }),
      }),
    ),
  });
  assert.equal(res.kind, "submission-failed");
  assert.equal(res.kind === "submission-failed" && res.stage, "confirm");
  assert.equal(res.kind === "submission-failed" && res.status, "NOT_FOUND");
});

test("send() THROWING a transport error -> rpc-error (during send), attempt still counted", async () => {
  const { deps, attempts } = withAttemptSpy({
    reads: fakeReads(),
    submitter: submitter(async () =>
      preparedOk({
        send: async () => {
          throw new Error("socket hang up");
        },
      }),
    ),
  });
  const res = await submitAttestation(baseInput(), deps);
  assert.equal(res.kind, "rpc-error");
  assert.equal(res.kind === "rpc-error" && res.during, "send");
  assert.equal(attempts.length, 1);
});

test("send() THROWING a non-transport error -> submission-failed, status 'threw'", async () => {
  const res = await submitAttestation(baseInput(), {
    reads: fakeReads(),
    submitter: submitter(async () =>
      preparedOk({
        send: async () => {
          throw new Error("unexpected internal boom");
        },
      }),
    ),
  });
  assert.equal(res.kind, "submission-failed");
  assert.equal(res.kind === "submission-failed" && res.status, "threw");
  assert.equal(res.kind === "submission-failed" && res.stage, "send");
});

// --- 4. SDK submitter local guards (no network) --------------------

const TESTNET_CONFIG = {
  contractId: "CAIDTSVPQICTA2VLE6BSQYHEELHGPZWQDYWKSDBRW4LYPZH6Q44UTAOA",
  rpcUrl: "https://soroban-testnet.stellar.org",
  networkPassphrase: TESTNET_NETWORK_PASSPHRASE,
  allowHttp: false,
};

test("createSdkAttestationSubmitter refuses a mainnet config", () => {
  assert.throws(
    () =>
      createSdkAttestationSubmitter(
        { ...TESTNET_CONFIG, networkPassphrase: MAINNET_NETWORK_PASSPHRASE },
        Keypair.random().secret(),
      ),
    /mainnet/i,
  );
});

test("createSdkAttestationSubmitter refuses an unconfirmed network config", () => {
  assert.throws(
    () =>
      createSdkAttestationSubmitter(
        { ...TESTNET_CONFIG, networkPassphrase: "Nope ; 2019" },
        Keypair.random().secret(),
      ),
    /not the confirmed|unconfirmed network/i,
  );
});

test("createSdkAttestationSubmitter rejects a malformed secret key without echoing it", () => {
  const bad = "S-definitely-not-a-real-key-000000000000000000";
  try {
    createSdkAttestationSubmitter(TESTNET_CONFIG, bad);
    assert.fail("expected a throw");
  } catch (err) {
    const msg = (err as Error).message;
    assert.equal(msg, "ATTESTOR_SECRET_KEY is not a valid Stellar secret key");
    assert.ok(!msg.includes(bad), "the invalid key value must not appear in the error");
  }
});

test("createSdkAttestationSubmitter with a testnet config + throwaway key reports the testnet network", () => {
  const s = createSdkAttestationSubmitter(TESTNET_CONFIG, Keypair.random().secret());
  assert.equal(s.network, TESTNET_NETWORK_PASSPHRASE);
  assert.equal(typeof s.prepare, "function");
});
