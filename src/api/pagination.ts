/**
 * Query-param parsing for `GET /api/attestations/:wallet`.
 *
 * Reuses the contract's own pagination convention
 * (`contract-api-v2.md` — `get_attestations_page(wallet, start, limit)`,
 * `MAX_PAGE_SIZE = 50`): `?cursor=` is the zero-based `start` index,
 * `?limit=` is the page size and both its **default and its ceiling**
 * are `MAX_PAGE_SIZE`. Nothing here invents a different page size.
 *
 * Anything malformed or out of range throws `ValidationError`, which the
 * route turns into a 400 before a chain read happens.
 */

import { MAX_PAGE_SIZE } from "@proofowl/contract-sdk";

import { ValidationError } from "../lib/errors.js";

export { MAX_PAGE_SIZE };

export interface PageParams {
  /** Zero-based start index into the wallet's attestation history. */
  start: number;
  /** Page size, `1..MAX_PAGE_SIZE`. */
  limit: number;
}

function parseIntParam(raw: unknown, name: string, fallback: number): number {
  if (raw === undefined || raw === "") return fallback;
  if (Array.isArray(raw)) throw new ValidationError(`${name} must be given at most once`);
  if (typeof raw !== "string" || !/^-?\d+$/.test(raw)) {
    throw new ValidationError(`${name} must be an integer`);
  }
  const n = Number(raw);
  if (!Number.isSafeInteger(n)) throw new ValidationError(`${name} is out of range`);
  return n;
}

/** Parse `?cursor=&limit=` into `{ start, limit }`. */
export function parsePageParams(query: Record<string, unknown>): PageParams {
  const start = parseIntParam(query.cursor, "cursor", 0);
  const limit = parseIntParam(query.limit, "limit", MAX_PAGE_SIZE);
  if (start < 0) {
    throw new ValidationError("cursor must be a non-negative integer");
  }
  if (limit < 1 || limit > MAX_PAGE_SIZE) {
    throw new ValidationError(`limit must be an integer in 1..${MAX_PAGE_SIZE}`);
  }
  return { start, limit };
}

/**
 * The `nextCursor` to return with a page: `start + count` when the page
 * came back full (more rows may exist), else `null` (end reached). Same
 * "a short page means the end" rule the SDK's `listAttestations` loop
 * uses.
 */
export function nextCursor(start: number, limit: number, count: number): number | null {
  return count >= limit ? start + count : null;
}
