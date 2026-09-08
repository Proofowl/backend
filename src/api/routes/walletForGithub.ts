/**
 * `GET /api/wallet-for-github/:githubIdHash`
 *   -> { githubIdHash, wallet: string | null }
 *
 * `githubIdHash` is the 64-char hex `github_id_hash` (identifier-spec-v1
 * §1). Accepted either case, echoed back lowercased. Read-only
 * `get_wallet_for_github`. A well-formed hash that is not linked to any
 * wallet -> `{ wallet: null }`, not a 404. Malformed hash -> 400 before
 * any RPC.
 */

import type { Request, RequestHandler, Response } from "express";

import { assertGithubIdHashHex } from "../../hashing/identifiers.js";
import type { ApiDeps } from "../deps.js";
import { asyncHandler } from "../errors.js";

export function walletForGithubRoute(deps: ApiDeps): RequestHandler {
  return asyncHandler(async (req: Request, res: Response) => {
    const githubIdHash = assertGithubIdHashHex(req.params.githubIdHash);
    const wallet = await deps.chain.getWalletForGithubIdHash(githubIdHash);
    res.json({ githubIdHash, wallet });
  });
}
