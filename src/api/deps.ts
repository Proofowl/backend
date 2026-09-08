/**
 * The exact, minimal surface the read-only REST API needs from the rest
 * of the codebase. Narrowed to `Pick<>`s on purpose: it makes the
 * "reads only" guarantee checkable at the type level — there is no way
 * for a route to reach `submitAttestation`, a signer, or a queue write
 * through this object. Tests pass tiny in-memory fakes shaped like this.
 */

import type { ChainReadClient } from "../chain/index.js";
import type { PendingContributionRepository } from "../queue/index.js";

export interface ApiDeps {
  /** Read-only on-chain lookups (RPC simulations). */
  chain: Pick<
    ChainReadClient,
    "getWalletReputation" | "getAttestationsPage" | "getWalletForGithubIdHash"
  >;
  /** Local queue — aggregate counts only. */
  queue: Pick<PendingContributionRepository, "countByStatus">;
}
