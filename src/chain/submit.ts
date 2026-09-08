/**
 * submit_attestation — turn a verified, attestable contribution into a
 * real on-chain attestation on the deployed ProofOwl registry.
 *
 * This is the FIRST state-changing, unattended write path in this repo.
 * Everything else in `src/chain` is read-only simulation. Design rules,
 * enforced here and not merely documented:
 *
 *  - TESTNET ONLY. {@link submitAttestation} refuses to run unless the
 *    submitter reports the Stellar **testnet** passphrase. There is no
 *    override.
 *  - DRY-RUN FIRST, ALWAYS. The submitter simulates every call before it
 *    can be sent; {@link submitAttestation} inspects that simulation and
 *    classifies a contract rejection BEFORE any signature or fee. With
 *    `dryRun: true` it stops there and never sends.
 *  - HARD PRE-CONDITIONS. The contributor's wallet link is re-read fresh
 *    (`get_wallet_for_github`), and `isContributionAlreadyAttested` is
 *    consulted, on every call. An unlinked identity or an
 *    already-credited PR short-circuits to a distinct result — it is
 *    never "submitted anyway to be sure".
 *  - NO LOOP. This module is the submission function and its safeguards.
 *    The scheduler that calls it automatically is a separate task.
 *  - THE ATTESTOR SECRET IS NEVER LOGGED. It is read once, by the SDK
 *    submitter adapter, and never appears in a result, an error, or a
 *    log line here.
 *
 * The two I/O boundaries are injected ({@link SubmitAttestationDeps}):
 * chain reads via {@link ChainReadClient}, and the write via
 * {@link AttestationSubmitter} (the real one is
 * `createSdkAttestationSubmitter` in ./attestationSubmitter.ts). Unit
 * tests drive the orchestrator against fakes for both; the one real
 * network exercise is the opt-in integration test.
 */

import {
  PROOFOWL_ERROR_NAME,
  parseProofOwlError,
  type ComplexityTier,
} from "@proofowl/contract-sdk";

import { ValidationError } from "../lib/errors.js";
import { hashGitHubPullRequestV1, hashGitHubPullRequestV1Hex } from "../hashing/identifiers.js";
import type { VerificationResult } from "../github/types.js";
import type { AttestationRecord } from "./attestationDecode.js";
import type { ChainReadClient } from "./readClient.js";

export type { ComplexityTier };

/** The Stellar **testnet** passphrase — the only network this module runs against. */
export const TESTNET_NETWORK_PASSPHRASE = "Test SDF Network ; September 2015";
/** The Stellar mainnet passphrase — named only so a submitter can refuse it. */
export const MAINNET_NETWORK_PASSPHRASE = "Public Global Stellar Network ; September 2015";

const HEX32_RE = /^[0-9a-fA-F]{64}$/;

// --- the write boundary ------------------------------------------------

/**
 * A `submit_attestation` call that has been assembled and SIMULATED
 * against the network but not yet sent. {@link simulationError} is the
 * dry-run result the caller must inspect before {@link send}.
 */
export interface PreparedAttestationTx {
  /**
   * `null` when the simulation succeeded. Otherwise the raw simulation
   * error string (e.g. `"HostError: Error(Contract, #7)"` or a bare
   * `"WalletNotLinked"`), for {@link submitAttestation} to classify.
   */
  simulationError: string | null;
  /**
   * The wallet the contract resolved for the identity during
   * simulation (`submit_attestation`'s return value), when the
   * simulation succeeded and it could be decoded. Informational.
   */
  simulatedCreditWallet: string | null;
  /** `minResourceFee` the simulation reported, when available. Informational. */
  minResourceFee: string | null;
  /**
   * Sign with the attestor key and submit to the network. Only call
   * after confirming {@link simulationError} is `null`. Throws on a
   * transport failure; resolves with a classified {@link SentAttestationOutcome}
   * for everything the network actually reported.
   */
  send(): Promise<SentAttestationOutcome>;
}

/** The network's verdict on a submitted `submit_attestation` transaction. */
export interface SentAttestationOutcome {
  /**
   * `"SUCCESS"` — included and applied. `"FAILED"` — included but the
   * transaction failed. `"ERROR"` — rejected at submission (bad
   * sequence number, insufficient fee, …). `"NOT_FOUND"` / `"PENDING"`
   * — not confirmed within the client's wait window.
   */
  status: "SUCCESS" | "FAILED" | "ERROR" | "NOT_FOUND" | "PENDING";
  /** Transaction hash, once the network assigned one. */
  txHash: string | null;
  /** Ledger the transaction landed in, on `SUCCESS` / `FAILED`. */
  ledger: number | null;
  /** Wallet credited (the call's return value), on `SUCCESS`. */
  creditedWallet: string | null;
  /** Human-readable detail for a non-success outcome. */
  detail: string | null;
}

/**
 * Assembles + simulates a `submit_attestation` call. The real
 * implementation (`createSdkAttestationSubmitter`) wraps the contract
 * SDK's `prepareSubmitAttestation` and signs with the attestor key;
 * tests pass a fake.
 */
export interface AttestationSubmitter {
  /**
   * The network passphrase this submitter is bound to. Authoritative
   * network identifier — {@link submitAttestation} refuses anything but
   * {@link TESTNET_NETWORK_PASSPHRASE}.
   */
  readonly network: string;
  prepare(input: PrepareAttestationInput): Promise<PreparedAttestationTx>;
}

export interface PrepareAttestationInput {
  /** 32-byte canonical GitHub identity hash. */
  githubIdHash: Uint8Array;
  /** `"<owner>/<repo>"`, lowercase. */
  repo: string;
  prNumber: number;
  issueId: bigint;
  complexity: ComplexityTier;
  /** 32-byte canonical PR hash — the global de-dup key. */
  prHash: Uint8Array;
}

// --- the orchestrator's inputs --------------------------------------

export interface SubmitAttestationInput {
  /**
   * The verification output for this contribution. Must be
   * `attestable === true`; a non-attestable result short-circuits to
   * {@link NotAttestableResult} rather than being submitted.
   */
  verification: VerificationResult;
  /** The contributor's canonical `github_id_hash`, lowercase 64-char hex. */
  githubIdHash: string;
  /** Stellar Wave issue id this contribution resolved (`0` if not applicable). */
  issueId: bigint | number;
  /** Wave complexity tier: one of `0`, `100`, `150`, `200`. */
  complexity: ComplexityTier;
  /**
   * Simulate and classify only — never sign or send. The result is
   * {@link DryRunOkResult} on a clean simulation, or the same
   * short-circuit / {@link ContractRejectedResult} it would have
   * returned for a real run.
   */
  dryRun?: boolean;
}

export interface SubmitAttestationDeps {
  /** Read-only chain client — fresh linkage + already-attested checks. */
  reads: ChainReadClient;
  /** The write boundary. */
  submitter: AttestationSubmitter;
  /**
   * Invoked exactly once, immediately before every REAL (non-dry-run)
   * network submission — successful or not. This is where a caller
   * counts submissions against a budget. Never called for a dry run or
   * for any short-circuit that returns before signing.
   */
  onSubmissionAttempt?: (ctx: SubmissionAttemptContext) => void;
}

export interface SubmissionAttemptContext {
  prHashHex: string;
  githubIdHashHex: string;
  repo: string;
  prNumber: number;
}

// --- the orchestrator's results -----------------------------------

/**
 * Every distinguishable outcome of {@link submitAttestation}. The caller
 * is expected to `switch` on `kind` and act differently on each — they
 * are deliberately not collapsed into a boolean or a thrown error.
 */
export type SubmitAttestationResult =
  | SubmittedResult
  | DryRunOkResult
  | AlreadyAttestedResult
  | NotSubmittableResult
  | NotAttestableResult
  | ContractRejectedResult
  | SubmissionFailedResult
  | RpcErrorResult;

/** Happy path: the attestation is recorded on-chain. */
export interface SubmittedResult {
  kind: "submitted";
  txHash: string;
  ledger: number | null;
  /** Wallet the contract credited (the call's return value). */
  creditedWallet: string | null;
  prHashHex: string;
  githubIdHashHex: string;
  repo: string;
  prNumber: number;
  complexity: ComplexityTier;
}

/** `dryRun: true` and the simulation was clean — nothing was sent. */
export interface DryRunOkResult {
  kind: "dry-run-ok";
  prHashHex: string;
  githubIdHashHex: string;
  repo: string;
  prNumber: number;
  complexity: ComplexityTier;
  /** Wallet the simulation resolved for the identity. */
  simulatedCreditWallet: string | null;
  minResourceFee: string | null;
}

/**
 * The PR is already credited on-chain under this identity's linked
 * wallet. Hard pre-condition hit — nothing was assembled or sent.
 */
export interface AlreadyAttestedResult {
  kind: "already-attested";
  prHashHex: string;
  githubIdHashHex: string;
  linkedWallet: string;
  /** The matching on-chain record. */
  match: AttestationRecord;
}

/**
 * The identity is not linked to any wallet, so `submit_attestation`
 * cannot resolve a recipient. This is the queue's job, not a failure —
 * the caller should enqueue and retry once a link exists.
 */
export interface NotSubmittableResult {
  kind: "not-submittable";
  reason: "wallet-not-linked";
  prHashHex: string;
  githubIdHashHex: string;
}

/** The verification result handed in was not `attestable`. Defensive guard. */
export interface NotAttestableResult {
  kind: "not-attestable";
  /** Ids of the checks that were not `pass`. */
  failingCheckIds: string[];
  indeterminate: boolean;
}

/**
 * The contract rejected the call during SIMULATION — before any
 * signature or fee. {@link errorName} distinguishes the cases the caller
 * acts on differently (`WalletNotLinked`, `DuplicateAttestation`,
 * `InvalidComplexity`, …).
 */
export interface ContractRejectedResult {
  kind: "contract-rejected";
  phase: "simulation";
  /** The parsed contract error code, or `null` if it could not be parsed. */
  errorCode: number | null;
  /** The contract error variant name, or `"unknown"`. */
  errorName: string;
  detail: string;
}

/**
 * The transaction was signed and sent, and then failed — rejected at
 * submission (bad sequence number, insufficient fee) or failed after
 * inclusion, or never confirmed. Distinct from {@link ContractRejectedResult}:
 * a submission attempt was spent.
 */
export interface SubmissionFailedResult {
  kind: "submission-failed";
  /** `"send"` — rejected at submission. `"confirm"` — failed / unconfirmed after submission. */
  stage: "send" | "confirm";
  txHash: string | null;
  status: SentAttestationOutcome["status"] | "threw";
  detail: string;
}

/** A network / RPC transport failure — no verdict from the contract at all. Safe to retry. */
export interface RpcErrorResult {
  kind: "rpc-error";
  /** Where the failure happened. */
  during: "wallet-link-read" | "already-attested-read" | "prepare" | "send";
  detail: string;
}

// --- helpers --------------------------------------------------------

/** Throw unless `passphrase` is exactly the Stellar testnet passphrase. */
export function assertTestnet(passphrase: string): void {
  if (passphrase === MAINNET_NETWORK_PASSPHRASE) {
    throw new ValidationError(
      "refusing to submit: submitter is bound to Stellar MAINNET — this task never submits to mainnet",
    );
  }
  if (passphrase !== TESTNET_NETWORK_PASSPHRASE) {
    throw new ValidationError(
      `refusing to submit: submitter network ${JSON.stringify(passphrase)} is not the confirmed ` +
        `Stellar testnet passphrase — stopping rather than submitting to an unconfirmed network`,
    );
  }
}

const NETWORK_ERROR_MARKERS = [
  "fetch failed",
  "econnrefused",
  "econnreset",
  "etimedout",
  "enotfound",
  "eai_again",
  "getaddrinfo",
  "socket hang up",
  "network error",
  "networkerror",
  "request failed",
  "timeout",
  "timed out",
  "und_err",
  "502",
  "503",
  "504",
  "bad gateway",
  "service unavailable",
  "gateway timeout",
];

/** Best-effort: does this look like a transport failure rather than a contract verdict? */
export function isLikelyNetworkError(err: unknown): boolean {
  const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();
  return NETWORK_ERROR_MARKERS.some((m) => msg.includes(m));
}

export { HEX32_RE as GITHUB_ID_HASH_HEX_RE };

function messageOf(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

function hexToBytes32(hex: string): Uint8Array {
  // `hex` is HEX32_RE-validated by the caller, so this is exactly 32 bytes.
  return new Uint8Array(Buffer.from(hex, "hex"));
}

function nameForCode(code: number): string {
  return (
    PROOFOWL_ERROR_NAME[code as keyof typeof PROOFOWL_ERROR_NAME] ??
    /* istanbul ignore next */ "unknown"
  );
}

/** Turn a raw simulation error string into a {@link ContractRejectedResult}. */
function classifySimulationError(raw: string): ContractRejectedResult {
  const code = parseProofOwlError(raw);
  return {
    kind: "contract-rejected",
    phase: "simulation",
    errorCode: code ?? null,
    errorName: code != null ? nameForCode(code) : "unknown",
    detail: raw,
  };
}

/** A thrown value that carries a recognisable contract error code, or `null`. */
function classifyThrownContractError(err: unknown): ContractRejectedResult | null {
  const code = parseProofOwlError(err);
  if (code == null) return null;
  return {
    kind: "contract-rejected",
    phase: "simulation",
    errorCode: code,
    errorName: nameForCode(code),
    detail: messageOf(err),
  };
}

/**
 * Submit one verified, attestable contribution as an on-chain
 * attestation — or return, without submitting, the distinct reason it
 * could not be. See {@link SubmitAttestationResult} for every outcome.
 *
 * Order of operations (each is a genuine gate, not a formality):
 *  1. refuse anything but Stellar testnet;
 *  2. reject a non-attestable verification result;
 *  3. re-read the identity→wallet link fresh — unlinked ⇒ "needs queueing";
 *  4. consult `isContributionAlreadyAttested` — attested ⇒ refuse;
 *  5. assemble + simulate; a contract rejection here costs no signature;
 *  6. `dryRun` ⇒ stop and report the clean simulation;
 *  7. otherwise sign with the attestor key and send, then classify the
 *     network's verdict (success / rejected-at-submission / failed /
 *     unconfirmed).
 *
 * Throws only for a programming error (a malformed `githubIdHash`, a
 * candidate the SDK rejects as structurally invalid). Every real-world
 * failure — RPC down, contract rejection, transaction failure — comes
 * back as a typed result the caller can branch on.
 */
export async function submitAttestation(
  input: SubmitAttestationInput,
  deps: SubmitAttestationDeps,
): Promise<SubmitAttestationResult> {
  // 1. Network guard — a hard stop, before any I/O.
  assertTestnet(deps.submitter.network);

  // 2. Shape validation.
  const githubIdHashHex = input.githubIdHash.toLowerCase();
  if (!HEX32_RE.test(githubIdHashHex)) {
    throw new ValidationError("githubIdHash must be a 64-char hex string (32 bytes)");
  }
  const { complexity } = input;

  // 3. Only attestable candidates are ever submitted.
  if (input.verification.attestable !== true) {
    return {
      kind: "not-attestable",
      failingCheckIds: input.verification.checks
        .filter((c) => c.status !== "pass")
        .map((c) => c.id),
      indeterminate: input.verification.indeterminate,
    };
  }

  // 4. Canonical identifiers, derived from the candidate itself.
  const { owner, repo: repoName, prNumber } = input.verification.candidate;
  const repo = `${owner}/${repoName}`.toLowerCase();
  const prHash = hashGitHubPullRequestV1(owner, repoName, prNumber);
  const prHashHex = hashGitHubPullRequestV1Hex(owner, repoName, prNumber);

  // 5. HARD PRE-CONDITION: the identity must resolve to a wallet.
  let linkedWallet: string | null;
  try {
    linkedWallet = await deps.reads.getWalletForGithubIdHash(githubIdHashHex);
  } catch (err) {
    return { kind: "rpc-error", during: "wallet-link-read", detail: messageOf(err) };
  }
  if (linkedWallet === null) {
    return { kind: "not-submittable", reason: "wallet-not-linked", prHashHex, githubIdHashHex };
  }

  // 6. HARD PRE-CONDITION: never submit a PR that is already credited.
  let already;
  try {
    already = await deps.reads.isContributionAlreadyAttested(githubIdHashHex, prHashHex);
  } catch (err) {
    return { kind: "rpc-error", during: "already-attested-read", detail: messageOf(err) };
  }
  if (already.attested && already.match) {
    return {
      kind: "already-attested",
      prHashHex,
      githubIdHashHex,
      linkedWallet: already.linkedWallet ?? linkedWallet,
      match: already.match,
    };
  }

  // 7. Assemble + SIMULATE. No signature, no fee yet.
  let prepared: PreparedAttestationTx;
  try {
    prepared = await deps.submitter.prepare({
      githubIdHash: hexToBytes32(githubIdHashHex),
      repo,
      prNumber,
      issueId: BigInt(input.issueId),
      complexity,
      prHash,
    });
  } catch (err) {
    if (err instanceof ValidationError || err instanceof TypeError || err instanceof RangeError) {
      throw err; // malformed input the SDK refused to assemble — a caller bug
    }
    return (
      classifyThrownContractError(err) ?? {
        kind: "rpc-error",
        during: "prepare",
        detail: messageOf(err),
      }
    );
  }

  // 8. Inspect the dry run.
  if (prepared.simulationError !== null) {
    return classifySimulationError(prepared.simulationError);
  }

  // 9. A dry run stops here — nothing is signed or sent.
  if (input.dryRun === true) {
    return {
      kind: "dry-run-ok",
      prHashHex,
      githubIdHashHex,
      repo,
      prNumber,
      complexity,
      simulatedCreditWallet: prepared.simulatedCreditWallet,
      minResourceFee: prepared.minResourceFee,
    };
  }

  // 10. REAL SUBMISSION. Count it now — before the send can throw.
  deps.onSubmissionAttempt?.({ prHashHex, githubIdHashHex, repo, prNumber });

  let outcome: SentAttestationOutcome;
  try {
    outcome = await prepared.send();
  } catch (err) {
    if (isLikelyNetworkError(err)) {
      return { kind: "rpc-error", during: "send", detail: messageOf(err) };
    }
    return {
      kind: "submission-failed",
      stage: "send",
      txHash: null,
      status: "threw",
      detail: messageOf(err),
    };
  }

  if (outcome.status === "SUCCESS") {
    return {
      kind: "submitted",
      txHash: outcome.txHash ?? "",
      ledger: outcome.ledger,
      creditedWallet: outcome.creditedWallet,
      prHashHex,
      githubIdHashHex,
      repo,
      prNumber,
      complexity,
    };
  }

  return {
    kind: "submission-failed",
    stage: outcome.status === "ERROR" ? "send" : "confirm",
    txHash: outcome.txHash,
    status: outcome.status,
    detail: outcome.detail ?? `submission ended in status ${outcome.status}`,
  };
}
