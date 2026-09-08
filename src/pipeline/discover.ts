/**
 * Discovery — the first stage of the pipeline.
 *
 * For each seed repo (see ./seed.ts), find closed issues that carry the
 * Wave label AND have at least one linked, MERGED pull request, and emit
 * one raw candidate per (issue, merged PR) pair in the exact shape
 * {@link verifyContribution} expects (`VerificationCandidate`).
 *
 * Discovery does NOT re-derive any of the six gating checks — it only
 * turns "a repo" into "here are pairs worth verifying". Everything it
 * reads goes through the injected {@link GitHubClient} (its pagination,
 * its rate-limit surfacing); this module makes no `fetch` calls of its
 * own. Per-repo issue volume is bounded by `maxIssuesPerRepo`.
 */

import type { GitHubClient } from "../github/client.js";
import type { VerificationCandidate } from "../github/types.js";
import {
  defaultWaveLabelMatcher,
  waveLabelMatcherFromNames,
  type WaveLabelMatcher,
} from "../github/verify.js";
import { silentPipelineLogger, type PipelineLogger } from "./log.js";
import type { SeedRepo } from "./seed.js";

export interface DiscoverDeps {
  github: GitHubClient;
  seeds: SeedRepo[];
  /** Authoritative Wave-label test. Default: {@link defaultWaveLabelMatcher}. */
  isWaveLabel?: WaveLabelMatcher;
  /**
   * Exact label names for the GitHub server-side `labels=` prefilter.
   * Omit for "no server filter" (every closed issue up to the cap is
   * fetched and matched client-side). Only set this when you know the
   * exact label text — a wrong name silently drops real issues.
   */
  labelPrefilter?: string[];
  /** Hard per-repo issue ceiling for this pass. Default 100. */
  maxIssuesPerRepo?: number;
  logger?: PipelineLogger;
}

export interface DiscoverResult {
  /** De-duplicated, ready to hand to `verifyContribution` one by one. */
  candidates: VerificationCandidate[];
  stats: {
    seedRepos: number;
    issuesScanned: number;
    waveIssues: number;
    /** Wave issues with no linked merged PR. */
    waveIssuesWithoutMergedPr: number;
    /** Seed repos whose issue list or a linked-PR lookup errored. */
    reposErrored: number;
  };
}

/**
 * Resolve the label matcher + prefilter from `WAVE_LABEL_NAMES`
 * (`PipelineConfig.waveLabelNames`): exact names when configured (used
 * for both the matcher and the server prefilter), otherwise the
 * permissive default matcher and no prefilter.
 */
export function discoveryLabelConfig(waveLabelNames: string[] | undefined): {
  isWaveLabel: WaveLabelMatcher;
  labelPrefilter: string[] | undefined;
} {
  if (waveLabelNames && waveLabelNames.length > 0) {
    return {
      isWaveLabel: waveLabelMatcherFromNames(waveLabelNames),
      labelPrefilter: waveLabelNames,
    };
  }
  return { isWaveLabel: defaultWaveLabelMatcher, labelPrefilter: undefined };
}

function candidateKey(c: VerificationCandidate): string {
  return `${c.owner}/${c.repo}#${c.issueNumber}#${c.prNumber}`;
}

export async function discoverCandidates(deps: DiscoverDeps): Promise<DiscoverResult> {
  const logger = deps.logger ?? silentPipelineLogger;
  const isWaveLabel = deps.isWaveLabel ?? defaultWaveLabelMatcher;
  const maxIssuesPerRepo = deps.maxIssuesPerRepo ?? 100;

  const byKey = new Map<string, VerificationCandidate>();
  const stats: DiscoverResult["stats"] = {
    seedRepos: deps.seeds.length,
    issuesScanned: 0,
    waveIssues: 0,
    waveIssuesWithoutMergedPr: 0,
    reposErrored: 0,
  };

  for (const seed of deps.seeds) {
    let issues;
    try {
      issues = await deps.github.listRepoIssues(seed.owner, seed.repo, {
        state: "closed",
        labels: deps.labelPrefilter,
        maxIssues: maxIssuesPerRepo,
      });
    } catch (err) {
      stats.reposErrored += 1;
      logger.log({
        level: "warn",
        event: "discovery.repo_error",
        message: `could not list issues for ${seed.ownerRepo}`,
        fields: { repo: seed.ownerRepo, error: messageOf(err) },
      });
      continue;
    }

    for (const issue of issues) {
      if (issue.pull_request !== undefined) continue; // defensive: client already filters
      stats.issuesScanned += 1;
      const labelNames = issue.labels.map((l) => l.name);
      if (!labelNames.some((n) => isWaveLabel(n))) continue;
      stats.waveIssues += 1;

      let linked;
      try {
        linked = await deps.github.getIssueLinkedPullRequests(seed.owner, seed.repo, issue.number);
      } catch (err) {
        stats.reposErrored += 1;
        logger.log({
          level: "warn",
          event: "discovery.linked_pr_error",
          message: `could not read linked PRs for ${seed.ownerRepo}#${issue.number}`,
          fields: { repo: seed.ownerRepo, issue: issue.number, error: messageOf(err) },
        });
        continue;
      }

      const merged = linked.filter((pr) => pr.merged);
      if (merged.length === 0) {
        stats.waveIssuesWithoutMergedPr += 1;
        logger.log({
          level: "info",
          event: "discovery.no_merged_pr",
          message: `${seed.ownerRepo}#${issue.number} is a Wave issue but has no merged linked PR`,
          fields: { repo: seed.ownerRepo, issue: issue.number, linkedPrs: linked.length },
        });
        continue;
      }

      for (const pr of merged) {
        const candidate: VerificationCandidate = {
          owner: seed.owner,
          repo: seed.repo,
          issueNumber: issue.number,
          prNumber: pr.number,
        };
        const key = candidateKey(candidate);
        if (byKey.has(key)) continue;
        byKey.set(key, candidate);
        logger.log({
          level: "info",
          event: "discovery.candidate",
          message: `${seed.ownerRepo}#${issue.number} <- merged PR #${pr.number}`,
          fields: { repo: seed.ownerRepo, issue: issue.number, pr: pr.number },
        });
      }
    }
  }

  return { candidates: [...byKey.values()], stats };
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
