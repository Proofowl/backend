/**
 * `GET /api/queue/status`
 *   -> { counts: { WAITING_FOR_WALLET_LINK, READY_TO_SUBMIT,
 *                  ALREADY_ATTESTED, DISMISSED }, total }
 *
 * Aggregate counts only — reuses `PendingContributionRepository.countByStatus()`
 * (which runs four cheap `COUNT` queries), never a raw Prisma call.
 *
 * NO individual-item listing here, on purpose. The rows themselves are
 * not sensitive — they are derived from public GitHub PR activity and
 * public identifier hashes — but a listing endpoint has real design
 * choices to make first: its own pagination, which filters (status?
 * repo? identity?), what per-row projection to expose (certainly not the
 * stored `verificationJson` blob verbatim), and ordering. That deserves
 * a deliberate pass, not a tack-on here. `listWaiting` /
 * `listByGithubIdHash` on the repository stay unexposed for now.
 */

import type { Request, RequestHandler, Response } from "express";

import { ALL_PENDING_STATUSES } from "../../queue/status.js";
import type { ApiDeps } from "../deps.js";
import { asyncHandler } from "../errors.js";

export function queueStatusRoute(deps: ApiDeps): RequestHandler {
  return asyncHandler(async (_req: Request, res: Response) => {
    const counts = await deps.queue.countByStatus();
    const total = ALL_PENDING_STATUSES.reduce((sum, key) => sum + (counts[key] ?? 0), 0);
    res.json({ counts, total });
  });
}
