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

import {
  submitAttestation,
  TESTNET_NETWORK_PASSPHRASE,
  MAINNET_NETWORK_PASSPHRASE,
  type AttestationSubmitter,
  type SubmissionAttemptContext,
  type SubmitAttestationInput,
  type SubmitAttestationDeps,
} from "../../src/chain/submit.js";
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
