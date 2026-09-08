/**
 * `GET /api/reputation/:wallet`
 *   -> { wallet, reputationScore, attestationCount }
 *
 * A syntactically valid wallet that has never appeared on-chain is NOT
 * an error — the contract's O(1) counters return 0 for an unknown
 * address, so this returns `{ reputationScore: 0, attestationCount: 0 }`,
 * not a 404. Only a malformed `:wallet` is a 400 (thrown by the
 * validator before any RPC call).
 */

import type { Request, RequestHandler, Response } from "express";

import { assertStellarWalletAddress } from "../../hashing/identifiers.js";
import type { ApiDeps } from "../deps.js";
import { asyncHandler } from "../errors.js";

export function reputationRoute(deps: ApiDeps): RequestHandler {
  return asyncHandler(async (req: Request, res: Response) => {
    const wallet = assertStellarWalletAddress(req.params.wallet);
    const rep = await deps.chain.getWalletReputation(wallet);
    res.json({
      wallet,
      reputationScore: rep.reputationScore,
      attestationCount: rep.attestationCount,
    });
  });
}
