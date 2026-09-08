/**
 * `GET /api/attestations/:wallet?cursor=&limit=`
 *   -> { wallet, pagination, attestations[] }
 *
 * `cursor` is the zero-based start index; `limit` defaults to and is
 * capped at the contract's `MAX_PAGE_SIZE` (see ../pagination.ts). One
 * page is one `get_attestations_page` RPC simulation. A short page
 * (`count < limit`) yields `nextCursor: null`.
 *
 * Malformed `:wallet` or `?cursor`/`?limit` -> 400 before any RPC. A
 * valid wallet with no history -> `{ attestations: [], ... }`, not 404.
 */

import type { Request, RequestHandler, Response } from "express";

import { assertStellarWalletAddress } from "../../hashing/identifiers.js";
import type { ApiDeps } from "../deps.js";
import { asyncHandler } from "../errors.js";
import { MAX_PAGE_SIZE, nextCursor, parsePageParams } from "../pagination.js";
import { serializeAttestation } from "../serialize.js";

export function attestationsRoute(deps: ApiDeps): RequestHandler {
  return asyncHandler(async (req: Request, res: Response) => {
    const wallet = assertStellarWalletAddress(req.params.wallet);
    const { start, limit } = parsePageParams(req.query as Record<string, unknown>);

    const page = await deps.chain.getAttestationsPage(wallet, start, limit);

    res.json({
      wallet,
      pagination: {
        cursor: start,
        limit,
        count: page.length,
        nextCursor: nextCursor(start, limit, page.length),
        maxPageSize: MAX_PAGE_SIZE,
      },
      attestations: page.map(serializeAttestation),
    });
  });
}
