/**
 * JSON-safe view of a decoded on-chain attestation.
 *
 * `AttestationRecord` (from `src/chain/`) carries two `bigint` fields —
 * `issueId` (u64) and `timestamp` (u64) — and `res.json()` throws on a
 * `bigint`. This maps to a wire shape:
 *  - `issueId`   -> decimal string (a u64 can exceed `Number.MAX_SAFE_INTEGER`);
 *  - `timestamp` -> number (a ledger close time in Unix seconds is well
 *    inside the safe-integer range for centuries).
 */

import type { AttestationRecord } from "../chain/index.js";

export interface SerializedAttestation {
  /** Zero-based index in the wallet's history. */
  sequence: number;
  /** `"<owner>/<repo>"` as stored on-chain. */
  repo: string;
  prNumber: number;
  /** Canonical PR hash (global de-dup key), lowercase hex. */
  prHashHex: string;
  /** `github_id_hash` linked to the wallet when this entry was recorded, lowercase hex. */
  githubIdHashHex: string;
  /** Stellar Wave issue id as a decimal string (`"0"` if not applicable). */
  issueId: string;
  /** One of 0, 100, 150, 200. */
  complexity: number;
  /** Ledger close time, Unix seconds. */
  timestamp: number;
}

/** Convert a decoded attestation to its JSON-safe wire shape. */
export function serializeAttestation(a: AttestationRecord): SerializedAttestation {
  return {
    sequence: a.sequence,
    repo: a.repo,
    prNumber: a.prNumber,
    prHashHex: a.prHashHex,
    githubIdHashHex: a.githubIdHashHex,
    issueId: a.issueId.toString(),
    complexity: a.complexity,
    timestamp: Number(a.timestamp),
  };
}
