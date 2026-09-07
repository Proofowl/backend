/**
 * Filesystem loader for the operator-asserted approved-orgs allowlist.
 * See ./approvedOrgsAllowlist.ts for the model and the pure parser.
 *
 * `load()` semantics:
 *   - file absent (ENOENT)  -> `null`  ("no allowlist configured")
 *   - file present, valid   -> `ApprovedOrgsAllowlist`
 *   - file present, invalid -> throws `ValidationError` (operator
 *     misconfiguration — loud, not a silent degrade)
 */

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { ValidationError } from "../lib/errors.js";
import { parseApprovedOrgsAllowlist, type ApprovedOrgsAllowlist } from "./approvedOrgsAllowlist.js";

export interface ApprovedOrgsAllowlistSource {
  /**
   * `null` when no allowlist is configured (file absent). A present but
   * malformed file rejects with `ValidationError` rather than resolving
   * `null` — a bad file is an operator error, not "not configured".
   */
  load(): Promise<ApprovedOrgsAllowlist | null>;
}

export interface FileApprovedOrgsAllowlistSourceOptions {
  /** Path to the JSON file. Relative paths resolve against `process.cwd()`. */
  path: string;
  /** Injectable reader for tests. Default: `fs/promises.readFile(p, "utf8")`. */
  readFileImpl?: (path: string) => Promise<string>;
  /** Cache the parsed result (including `null`). Default `true`. */
  cache?: boolean;
}

interface NodeErr {
  code?: string;
}

export class FileApprovedOrgsAllowlistSource implements ApprovedOrgsAllowlistSource {
  private readonly path: string;
  private readonly readFileImpl: (path: string) => Promise<string>;
  private readonly useCache: boolean;
  private cached: { value: ApprovedOrgsAllowlist | null } | undefined;

  constructor(opts: FileApprovedOrgsAllowlistSourceOptions) {
    this.path = resolve(opts.path);
    this.readFileImpl = opts.readFileImpl ?? ((p) => readFile(p, "utf8"));
    this.useCache = opts.cache ?? true;
  }

  async load(): Promise<ApprovedOrgsAllowlist | null> {
    if (this.useCache && this.cached) return this.cached.value;
    const value = await this.loadUncached();
    if (this.useCache) this.cached = { value };
    return value;
  }

  private async loadUncached(): Promise<ApprovedOrgsAllowlist | null> {
    let text: string;
    try {
      text = await this.readFileImpl(this.path);
    } catch (err) {
      if ((err as NodeErr).code === "ENOENT") return null;
      throw new ValidationError(
        `could not read approved-orgs allowlist at ${this.path}: ${(err as Error).message}`,
      );
    }
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch (err) {
      throw new ValidationError(
        `approved-orgs allowlist at ${this.path} is not valid JSON: ${(err as Error).message}`,
      );
    }
    return parseApprovedOrgsAllowlist(raw, this.path);
  }
}

/** A source backed by a fixed in-memory value — for tests and embedding. */
export class StaticApprovedOrgsAllowlistSource implements ApprovedOrgsAllowlistSource {
  constructor(private readonly value: ApprovedOrgsAllowlist | null) {}
  async load(): Promise<ApprovedOrgsAllowlist | null> {
    return this.value;
  }
}
