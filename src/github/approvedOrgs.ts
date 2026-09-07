/**
 * Stellar Wave approved-orgs list.
 *
 * The task points at `drips.network/wave/stellar/orgs` as "Wave's public
 * approved-orgs list". As checked during scaffolding, that URL serves a
 * client-rendered SvelteKit page, not machine-readable data, and its
 * data endpoint (`/wave/stellar/orgs/__data.json`) returns no org list
 * without a `waveAccessToken`. No public JSON endpoint for this list is
 * confirmed.
 *
 * So this module does NOT hardcode a snapshot. It fetches the configured
 * URL live and tries, in order:
 *   1. parse the body as JSON and pull org logins out of common shapes;
 *   2. if it is HTML, best-effort scrape `github.com/<org>` owner slugs
 *      from any embedded data;
 * and if neither yields anything it returns `status: "indeterminate"`
 * with a reason — the `repo_in_approved_orgs` check then surfaces as
 * `indeterminate`, never a silent pass or fail.
 *
 * Point `WAVE_APPROVED_ORGS_URL` at a real JSON endpoint (or a fixture
 * server) once one is known and shape (1) below likely already handles
 * it; otherwise extend `parseOrgsFromJson`.
 */

import { UpstreamError } from "../lib/errors.js";

export type ApprovedOrgsSnapshot =
  | { status: "ok"; orgs: string[]; source: string; fetchedAt: string }
  | { status: "indeterminate"; reason: string; source: string; fetchedAt: string };

export interface ApprovedOrgsSource {
  listApprovedOrgs(): Promise<ApprovedOrgsSnapshot>;
}

export interface HttpApprovedOrgsSourceOptions {
  url: string;
  fetchImpl?: typeof fetch;
  /** Optional cache TTL (ms). 0 disables caching. Default 5 min. */
  cacheTtlMs?: number;
}

export class HttpApprovedOrgsSource implements ApprovedOrgsSource {
  private readonly url: string;
  private readonly fetchImpl: typeof fetch;
  private readonly cacheTtlMs: number;
  private cache: { at: number; snapshot: ApprovedOrgsSnapshot } | null = null;

  constructor(opts: HttpApprovedOrgsSourceOptions) {
    this.url = opts.url;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.cacheTtlMs = opts.cacheTtlMs ?? 5 * 60_000;
  }

  async listApprovedOrgs(): Promise<ApprovedOrgsSnapshot> {
    if (this.cache && this.cacheTtlMs > 0 && Date.now() - this.cache.at < this.cacheTtlMs) {
      return this.cache.snapshot;
    }
    const snapshot = await this.fetchSnapshot();
    this.cache = { at: Date.now(), snapshot };
    return snapshot;
  }

  private async fetchSnapshot(): Promise<ApprovedOrgsSnapshot> {
    const fetchedAt = new Date().toISOString();
    let res: Response;
    try {
      res = await this.fetchImpl(this.url, {
        headers: { accept: "application/json, text/html", "user-agent": "proofowl-backend" },
      });
    } catch (err) {
      throw new UpstreamError(`approved-orgs fetch failed: ${this.url}`, err);
    }
    if (!res.ok) {
      return {
        status: "indeterminate",
        reason: `approved-orgs endpoint returned HTTP ${res.status}`,
        source: this.url,
        fetchedAt,
      };
    }
    const body = await res.text();

    const fromJson = tryParseJson(body);
    if (fromJson !== undefined) {
      const orgs = parseOrgsFromJson(fromJson);
      if (orgs.length > 0) {
        return { status: "ok", orgs: dedupeLower(orgs), source: this.url, fetchedAt };
      }
      return {
        status: "indeterminate",
        reason: "approved-orgs endpoint returned JSON with no recognisable org list",
        source: this.url,
        fetchedAt,
      };
    }

    const scraped = scrapeOrgsFromHtml(body);
    if (scraped.length > 0) {
      return { status: "ok", orgs: dedupeLower(scraped), source: this.url, fetchedAt };
    }
    return {
      status: "indeterminate",
      reason:
        "approved-orgs URL served HTML with no embedded org data (known limitation — " +
        "drips.network/wave/stellar/orgs is client-rendered; set WAVE_APPROVED_ORGS_URL " +
        "to a JSON endpoint)",
      source: this.url,
      fetchedAt,
    };
  }
}

/** A source that always answers with a fixed list — for tests and local dev only. */
export class StaticApprovedOrgsSource implements ApprovedOrgsSource {
  constructor(private readonly orgs: string[]) {}
  async listApprovedOrgs(): Promise<ApprovedOrgsSnapshot> {
    return {
      status: "ok",
      orgs: dedupeLower(this.orgs),
      source: "static",
      fetchedAt: new Date().toISOString(),
    };
  }
}

/** Case-insensitive membership test against a snapshot. */
export function orgIsApproved(snapshot: ApprovedOrgsSnapshot, owner: string): boolean {
  return snapshot.status === "ok" && snapshot.orgs.includes(owner.toLowerCase());
}

function tryParseJson(body: string): unknown | undefined {
  const trimmed = body.trimStart();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return undefined;
  try {
    return JSON.parse(body);
  } catch {
    return undefined;
  }
}

/** Recognise org logins in the common JSON shapes an endpoint might use. */
export function parseOrgsFromJson(value: unknown): string[] {
  const out: string[] = [];
  const visit = (v: unknown): void => {
    if (Array.isArray(v)) {
      for (const item of v) {
        if (typeof item === "string" && isOrgLogin(item)) out.push(item);
        else visit(item);
      }
      return;
    }
    if (v && typeof v === "object") {
      const obj = v as Record<string, unknown>;
      for (const key of ["login", "org", "orgName", "slug", "name", "handle", "githubLogin"]) {
        const cand = obj[key];
        if (typeof cand === "string" && isOrgLogin(cand)) out.push(cand);
      }
      for (const nested of Object.values(obj)) visit(nested);
    }
  };
  visit(value);
  return out;
}

function scrapeOrgsFromHtml(html: string): string[] {
  const out: string[] = [];
  const re = /github\.com\/([A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?)(?=["'/\s<\\])/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    const slug = m[1];
    if (slug && isOrgLogin(slug) && !HTML_NOISE.has(slug.toLowerCase())) out.push(slug);
  }
  return out;
}

const HTML_NOISE = new Set(["sponsors", "features", "about", "pricing", "login", "join", "topics"]);

function isOrgLogin(s: string): boolean {
  return /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/.test(s);
}

function dedupeLower(orgs: string[]): string[] {
  return [...new Set(orgs.map((o) => o.toLowerCase()))].sort();
}
