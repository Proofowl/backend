/**
 * GitHub verification module: fetch a candidate contribution's PR /
 * issue / timeline / closing-issue link and run the five gating checks
 * plus the self-merge flag. See ./verify.ts.
 */

import type { GitHubConfig } from "../config.js";
import { HttpApprovedOrgsSource, type ApprovedOrgsSource } from "./approvedOrgs.js";
import { HttpGitHubClient, type GitHubClient } from "./client.js";
import {
  defaultWaveLabelMatcher,
  waveLabelMatcherFromNames,
  type WaveLabelMatcher,
} from "./verify.js";

export * from "./types.js";
export * from "./client.js";
export * from "./approvedOrgs.js";
export * from "./verify.js";

export interface GitHubModule {
  client: GitHubClient;
  approvedOrgs: ApprovedOrgsSource;
  isWaveLabel: WaveLabelMatcher;
}

/** Build the production module from config + env (`WAVE_LABEL_NAMES`). */
export function createGitHubModule(cfg: GitHubConfig, env = process.env): GitHubModule {
  const names = (env.WAVE_LABEL_NAMES ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return {
    client: new HttpGitHubClient({ apiBaseUrl: cfg.apiBaseUrl, token: cfg.token }),
    approvedOrgs: new HttpApprovedOrgsSource({ url: cfg.approvedOrgsUrl }),
    isWaveLabel: names.length > 0 ? waveLabelMatcherFromNames(names) : defaultWaveLabelMatcher,
  };
}
