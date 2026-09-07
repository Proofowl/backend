/**
 * The `PendingContribution.status` value set. SQLite has no native enum,
 * so this is enforced in application code.
 */

export const PENDING_STATUS = {
  /** GitHub verification passed; the contributor's wallet is not linked on-chain. */
  WAITING_FOR_WALLET_LINK: "WAITING_FOR_WALLET_LINK",
  /** The wallet is now linked — a later pass performs the submission. */
  READY_TO_SUBMIT: "READY_TO_SUBMIT",
  /** The pr_hash is already recorded on-chain; nothing to submit. */
  ALREADY_ATTESTED: "ALREADY_ATTESTED",
  /** Removed from consideration (found invalid, or manual intervention). */
  DISMISSED: "DISMISSED",
} as const;

export type PendingStatus = (typeof PENDING_STATUS)[keyof typeof PENDING_STATUS];

export const ALL_PENDING_STATUSES = Object.values(PENDING_STATUS) as PendingStatus[];

export function isPendingStatus(v: string): v is PendingStatus {
  return (ALL_PENDING_STATUSES as string[]).includes(v);
}
