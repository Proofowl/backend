/**
 * On-chain reads against the deployed ProofOwl registry.
 *
 * READ-ONLY. Every call here is an RPC simulation — no signature, no
 * fee, no state change. This module never assembles, signs, or submits
 * a mutating transaction; attestation submission is out of scope for
 * this pass.
 *
 * Contract bindings and the RPC round-trip come from
 * `@proofowl/contract-sdk`'s `createReadClient` — scalar reads and the
 * `Attestation`-struct reads alike. As of SDK 0.3.0 `getAttestation` /
 * `getAttestationsPage` decode the struct with `scValToNative` (by
 * field name), so the local decode shim this module used to route the
 * struct reads through is gone.
 */

import {
  createReadClient,
  type AttestationView,
  type ProofOwlContractConfig,
  type ProofOwlReadClient,
} from "@proofowl/contract-sdk";

import { ValidationError } from "../lib/errors.js";

/** One attestation, decoded from the contract's `Attestation` struct. */
export interface AttestationRecord {
  /** `github_id_hash` linked to the wallet when this entry was recorded (ADR 0005), lowercase hex. */
  githubIdHashHex: string;
  /** `"<owner>/<repo>"` exactly as stored on-chain. */
  repo: string;
  prNumber: number;
  /** Stellar Wave issue id, or 0n. */
  issueId: bigint;
  /** One of 0, 100, 150, 200. */
  complexity: number;
  /** Canonical PR hash — the global de-dup key — lowercase hex. */
  prHashHex: string;
  /** Ledger close time (Unix seconds) the contract recorded. */
  timestamp: bigint;
  /** Zero-based index in the wallet's history (`start + offset`). */
  sequence: number;
}

/**
 * Narrow the SDK's `AttestationView` (which also carries the raw
 * `Uint8Array` hashes) down to this module's hex-only record. Field
 * types are otherwise identical.
 */
function toRecord(a: AttestationView): AttestationRecord {
  return {
    githubIdHashHex: a.githubIdHashHex,
    repo: a.repo,
    prNumber: a.prNumber,
    issueId: a.issueId,
    complexity: a.complexity,
    prHashHex: a.prHashHex,
    timestamp: a.timestamp,
    sequence: a.sequence,
  };
}

/**
 * Page through `wallet`'s entire attestation history (oldest first),
 * following contract-api-v2 §7: advance `start` by the page length,
 * stop on a short page. Page size is the contract max (50).
 */
async function listAllAttestations(
  sdk: ProofOwlReadClient,
  wallet: string,
): Promise<AttestationRecord[]> {
  const PAGE = 50;
  const all: AttestationRecord[] = [];
  let start = 0;
  // Hard ceiling so a misbehaving RPC can't spin forever.
  for (let guard = 0; guard < 10_000; guard++) {
    const page = await sdk.getAttestationsPage(wallet, start, PAGE);
    all.push(...page.map(toRecord));
    if (page.length < PAGE) break;
    start += page.length;
  }
  return all;
}

const HEX32_RE = /^[0-9a-fA-F]{64}$/;
const STRKEY_G_RE = /^G[A-Z2-7]{55}$/;

function hexToBytes32(hex: string): Uint8Array {
  if (!HEX32_RE.test(hex)) {
    throw new ValidationError("expected a 64-char hex string (32 bytes)");
  }
  return new Uint8Array(Buffer.from(hex, "hex"));
}

function assertWallet(wallet: string): void {
  if (!STRKEY_G_RE.test(wallet)) {
    throw new ValidationError(`expected a 'G...' account strkey, got ${JSON.stringify(wallet)}`);
  }
}

export interface WalletReputation {
  wallet: string;
  /** `get_attestation_count` — O(1). */
  attestationCount: number;
  /** `get_reputation_score` — O(1) running counter (v0.2+). */
  reputationScore: number;
}

export interface AlreadyAttestedCheck {
  prHashHex: string;
  githubIdHashHex: string;
  /** True iff a matching `pr_hash` was found on the resolved wallet's history. */
  attested: boolean;
  /** The wallet `github_id_hash` currently resolves to, or null if unlinked. */
  linkedWallet: string | null;
  /** The matching record, when `attested`. */
  match: AttestationRecord | null;
  /**
   * How confident this answer is. `pr_hash` is a GLOBAL, permanent
   * de-dup key on-chain (`identifier-spec-v1` §2.5) — a second
   * submit_attestation with the same hash fails `DuplicateAttestation`
   * regardless of wallet. But the only read to enumerate history is
   * per-wallet, so when the identity is not linked to any wallet this
   * check cannot see whether the PR was credited under some *other*
   * wallet/identity. In that case `confidence` is "unlinked-identity"
   * and the true guard remains the contract's own dedup at submit time.
   */
  confidence: "checked-linked-wallet" | "unlinked-identity";
}

export interface ChainReadClient {
  readonly config: ProofOwlContractConfig;
  /** Contract admin, or null if uninitialised/archived. */
  getAdmin(): Promise<string | null>;
  /** Contract attestor, or null. */
  getAttestor(): Promise<string | null>;
  /**
   * The wallet currently linked to a `github_id_hash` (hex or bytes),
   * or null if that identity is not linked. Read-only `get_wallet_for_github`.
   */
  getWalletForGithubIdHash(githubIdHash: string | Uint8Array): Promise<string | null>;
  /** The `github_id_hash` (lowercase hex) linked to a wallet, or null. */
  getGithubIdHashForWallet(wallet: string): Promise<string | null>;
  /** `get_attestation_count` + `get_reputation_score` for a wallet. */
  getWalletReputation(wallet: string): Promise<WalletReputation>;
  /** One bounded page of a wallet's attestation history (oldest first). */
  getAttestationsPage(wallet: string, start: number, limit: number): Promise<AttestationRecord[]>;
  /** A wallet's entire attestation history, paged to completion. */
  listAttestations(wallet: string): Promise<AttestationRecord[]>;
  /**
   * Has this contribution already been credited on-chain? Resolves the
   * identity to a wallet, then scans that wallet's history for `prHashHex`.
   * See {@link AlreadyAttestedCheck.confidence} for the unlinked case.
   */
  isContributionAlreadyAttested(
    githubIdHashHex: string,
    prHashHex: string,
  ): Promise<AlreadyAttestedCheck>;
  /** Escape hatch: the SDK read client (scalar reads). */
  readonly sdk: ProofOwlReadClient;
}

export function createChainReadClient(config: ProofOwlContractConfig): ChainReadClient {
  const sdk = createReadClient(config);

  const api: ChainReadClient = {
    config,
    sdk,

    getAdmin: () => sdk.getAdmin(),
    getAttestor: () => sdk.getAttestor(),

    async getWalletForGithubIdHash(githubIdHash) {
      const bytes = typeof githubIdHash === "string" ? hexToBytes32(githubIdHash) : githubIdHash;
      if (bytes.length !== 32) throw new ValidationError("github_id_hash must be 32 bytes");
      return sdk.getWalletForGithub(bytes);
    },

    async getGithubIdHashForWallet(wallet) {
      assertWallet(wallet);
      const bytes = await sdk.getGithubForWallet(wallet);
      return bytes ? Buffer.from(bytes).toString("hex") : null;
    },

    async getWalletReputation(wallet) {
      assertWallet(wallet);
      const [attestationCount, reputationScore] = await Promise.all([
        sdk.getAttestationCount(wallet),
        sdk.getReputationScore(wallet),
      ]);
      return { wallet, attestationCount, reputationScore };
    },

    async getAttestationsPage(wallet, start, limit) {
      assertWallet(wallet);
      if (!Number.isInteger(start) || start < 0) {
        throw new ValidationError("start must be a non-negative integer");
      }
      if (!Number.isInteger(limit) || limit < 1 || limit > 50) {
        throw new ValidationError("limit must be in 1..=50 (contract MAX_PAGE_SIZE)");
      }
      const page = await sdk.getAttestationsPage(wallet, start, limit);
      return page.map(toRecord);
    },

    async listAttestations(wallet) {
      assertWallet(wallet);
      return listAllAttestations(sdk, wallet);
    },

    async isContributionAlreadyAttested(githubIdHashHex, prHashHex) {
      if (!HEX32_RE.test(prHashHex)) throw new ValidationError("prHashHex must be 64 hex chars");
      const wantHex = prHashHex.toLowerCase();
      const linkedWallet = await api.getWalletForGithubIdHash(githubIdHashHex);
      if (!linkedWallet) {
        return {
          prHashHex: wantHex,
          githubIdHashHex: githubIdHashHex.toLowerCase(),
          attested: false,
          linkedWallet: null,
          match: null,
          confidence: "unlinked-identity",
        };
      }
      const history = await listAllAttestations(sdk, linkedWallet);
      const match = history.find((a) => a.prHashHex.toLowerCase() === wantHex) ?? null;
      return {
        prHashHex: wantHex,
        githubIdHashHex: githubIdHashHex.toLowerCase(),
        attested: match !== null,
        linkedWallet,
        match,
        confidence: "checked-linked-wallet",
      };
    },
  };

  return api;
}
