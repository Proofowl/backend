/**
 * The discovery seed list.
 *
 * Discovery scans a fixed set of repositories for closed Wave issues.
 * That set is exactly the repos on the operator-asserted approved-orgs
 * allowlist — the same source `repo_in_approved_orgs` consults as its
 * fallback (see src/github/approvedOrgsAllowlist.ts). Reusing it keeps
 * discovery and verification pointed at one curated list instead of two.
 *
 * No allowlist configured (file absent) -> an empty seed list, so a
 * discovery pass simply finds nothing. A malformed allowlist still
 * throws from `source.load()`, loudly, exactly as elsewhere.
 */

import type { ApprovedOrgsAllowlistSource } from "../github/approvedOrgsAllowlistSource.js";

/** One seed repo, split into the parts the GitHub client needs. */
export interface SeedRepo {
  owner: string;
  repo: string;
  /** `"owner/repo"`, lowercased — as it appears on the allowlist. */
  ownerRepo: string;
}

export async function seedReposFromAllowlist(
  source: ApprovedOrgsAllowlistSource,
): Promise<SeedRepo[]> {
  const allowlist = await source.load();
  if (!allowlist) return [];
  const seen = new Set<string>();
  const seeds: SeedRepo[] = [];
  for (const entry of allowlist.entries) {
    const ownerRepo = entry.repo.toLowerCase();
    if (seen.has(ownerRepo)) continue;
    const slash = ownerRepo.indexOf("/");
    // parseApprovedOrgsAllowlist already guarantees "owner/name" shape.
    if (slash <= 0 || slash !== ownerRepo.lastIndexOf("/")) continue;
    seen.add(ownerRepo);
    seeds.push({
      owner: ownerRepo.slice(0, slash),
      repo: ownerRepo.slice(slash + 1),
      ownerRepo,
    });
  }
  return seeds;
}
