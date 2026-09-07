/**
 * Operator-asserted approved-orgs allowlist — the documented FALLBACK
 * for the `repo_in_approved_orgs` check, used only when the live Wave
 * source (`HttpApprovedOrgsSource`) is unreachable.
 *
 * Why this exists: `drips.network/wave/stellar/orgs` is a client-rendered
 * page with no reachable public data endpoint, so the live source can
 * only ever return "indeterminate" today. This file lets an operator
 * curate a specific set of repos they have personally verified as
 * Wave-approved. A "pass" that comes from here is a MANUAL assertion —
 * it carries the asserter's identity, date, and an evidence URL through
 * to the check's returned `evidence`/`confidence` so downstream code can
 * never mistake it for an independently-verified pass.
 *
 * This module is the pure/parsing half (no filesystem). The loader lives
 * in ./approvedOrgsAllowlistSource.ts.
 */

import { ValidationError } from "../lib/errors.js";

/** One manually-asserted entry. All provenance fields are required. */
export interface AllowlistEntry {
  /** `"owner/name"`, normalized lowercase. */
  repo: string;
  /** Who asserts this repo is Wave-approved (a person / role, not a bot). */
  assertedBy: string;
  /** ISO date (YYYY-MM-DD or full ISO datetime) the assertion was made. */
  assertedAt: string;
  /** `http(s)://` link to whatever justified the entry (Wave issue, dashboard, …). */
  evidenceUrl: string;
  /** Optional free-text context. */
  note?: string;
}

export interface ApprovedOrgsAllowlist {
  /** Entries in file order, normalized and de-duplicated. */
  entries: AllowlistEntry[];
  /** Where these came from (a path), surfaced in check evidence. */
  source: string;
  /** Case-insensitive exact lookup by `"owner/name"`. */
  find(ownerRepo: string): AllowlistEntry | undefined;
}

const REPO_RE = /^[a-z0-9](?:[a-z0-9-]{0,37}[a-z0-9])?\/[a-z0-9._-]{1,100}$/;
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}([T ].*)?$/;

function nonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.trim().length > 0;
}

function validateEntry(raw: unknown, index: number): AllowlistEntry {
  const where = `allowlist entry [${index}]`;
  if (typeof raw === "string") {
    throw new ValidationError(
      `${where} is a bare string — provenance is required; use ` +
        `{ repo, assertedBy, assertedAt, evidenceUrl }`,
    );
  }
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new ValidationError(`${where} must be an object`);
  }
  const obj = raw as Record<string, unknown>;

  if (!nonEmptyString(obj.repo)) {
    throw new ValidationError(`${where}: "repo" must be a non-empty "owner/name" string`);
  }
  const repo = obj.repo.trim().toLowerCase();
  if (!REPO_RE.test(repo)) {
    throw new ValidationError(
      `${where}: "repo" ${JSON.stringify(obj.repo)} is not a valid "owner/name" identifier`,
    );
  }

  if (!nonEmptyString(obj.assertedBy)) {
    throw new ValidationError(`${where}: "assertedBy" must be a non-empty string`);
  }
  if (!nonEmptyString(obj.assertedAt) || !ISO_DATE_RE.test(obj.assertedAt.trim())) {
    throw new ValidationError(
      `${where}: "assertedAt" must be an ISO date (YYYY-MM-DD or datetime)`,
    );
  }
  if (Number.isNaN(Date.parse(obj.assertedAt.trim()))) {
    throw new ValidationError(
      `${where}: "assertedAt" ${JSON.stringify(obj.assertedAt)} is not a real date`,
    );
  }
  if (!nonEmptyString(obj.evidenceUrl)) {
    throw new ValidationError(`${where}: "evidenceUrl" must be a non-empty http(s) URL`);
  }
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(obj.evidenceUrl.trim());
  } catch {
    throw new ValidationError(
      `${where}: "evidenceUrl" ${JSON.stringify(obj.evidenceUrl)} is not a valid URL`,
    );
  }
  if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
    throw new ValidationError(`${where}: "evidenceUrl" must be http(s), got ${parsedUrl.protocol}`);
  }
  if (obj.note !== undefined && typeof obj.note !== "string") {
    throw new ValidationError(`${where}: "note" must be a string when present`);
  }

  return {
    repo,
    assertedBy: obj.assertedBy.trim(),
    assertedAt: obj.assertedAt.trim(),
    evidenceUrl: obj.evidenceUrl.trim(),
    ...(obj.note !== undefined ? { note: obj.note } : {}),
  };
}

/**
 * Parse and validate a raw allowlist value (already `JSON.parse`d).
 * Accepts either a bare array of entries or `{ entries: [...] }`.
 * Throws `ValidationError` on any malformed entry or a duplicate `repo`.
 */
export function parseApprovedOrgsAllowlist(raw: unknown, source: string): ApprovedOrgsAllowlist {
  let rawEntries: unknown[];
  if (Array.isArray(raw)) {
    rawEntries = raw;
  } else if (
    raw !== null &&
    typeof raw === "object" &&
    Array.isArray((raw as { entries?: unknown }).entries)
  ) {
    rawEntries = (raw as { entries: unknown[] }).entries;
  } else {
    throw new ValidationError(
      "approved-orgs allowlist must be a JSON array of entries or an object with an 'entries' array",
    );
  }

  const entries: AllowlistEntry[] = [];
  const seen = new Set<string>();
  rawEntries.forEach((rawEntry, i) => {
    const entry = validateEntry(rawEntry, i);
    if (seen.has(entry.repo)) {
      throw new ValidationError(
        `approved-orgs allowlist has a duplicate repo entry: ${entry.repo}`,
      );
    }
    seen.add(entry.repo);
    entries.push(entry);
  });

  const byRepo = new Map(entries.map((e) => [e.repo, e]));
  return {
    entries,
    source,
    find: (ownerRepo: string) => byRepo.get(ownerRepo.trim().toLowerCase()),
  };
}
