/**
 * Configuration for the automation pipeline (discover -> verify ->
 * submit/queue -> retry). Read once, from the environment, by the
 * `pipeline:once` / `pipeline:loop` entrypoints. Nothing here is read at
 * server startup — the scheduler is never wired into `npm start`.
 *
 * Kept separate from `src/config.ts` because these knobs only matter to
 * the pipeline binary; the Express app and the library modules never
 * touch them.
 */

/** The smallest poll interval we accept — a guard against "every 5 seconds". */
export const MIN_POLL_INTERVAL_MS = 60_000;
/** Default poll interval for `pipeline:loop`: 10 minutes. */
export const DEFAULT_POLL_INTERVAL_MS = 600_000;
/** Default per-repo issue ceiling for one discovery pass. */
export const DEFAULT_MAX_ISSUES_PER_REPO = 100;
/** Default ceiling on queued items drained (re-checked) per pass. */
export const DEFAULT_MAX_QUEUE_DRAIN = 100;

export interface PipelineConfig {
  /**
   * How often `pipeline:loop` runs `runOnce`, in milliseconds. From
   * `PIPELINE_POLL_INTERVAL_MS`; defaults to {@link DEFAULT_POLL_INTERVAL_MS}.
   * Rejected below {@link MIN_POLL_INTERVAL_MS} so a stray "5" cannot turn
   * this into a tight loop against the GitHub API.
   */
  pollIntervalMs: number;
  /**
   * Hard cap on issues fetched per seed repo per discovery pass. From
   * `PIPELINE_MAX_ISSUES_PER_REPO`; defaults to
   * {@link DEFAULT_MAX_ISSUES_PER_REPO}. Bounds API cost and rate-limit
   * pressure — see `src/github/client.ts` `listRepoIssues`.
   */
  maxIssuesPerRepo: number;
  /**
   * Exact Wave label names, from `WAVE_LABEL_NAMES` (comma-separated).
   * When set, both the discovery server-side prefilter and the
   * label matcher use these names verbatim. When unset, discovery uses
   * the permissive `defaultWaveLabelMatcher` and a best-effort `["Wave"]`
   * prefilter.
   */
  waveLabelNames: string[] | undefined;
  /**
   * Hard cap on queued (`WAITING_FOR_WALLET_LINK`) rows re-checked in one
   * pass. From `PIPELINE_MAX_QUEUE_DRAIN`; defaults to
   * {@link DEFAULT_MAX_QUEUE_DRAIN}. Bounds the chain reads a single pass
   * makes while a backlog clears.
   */
  maxQueueDrain: number;
  /**
   * When true, the pass simulates every `submit_attestation` and never
   * signs or sends — discovery still runs and unlinked contributions are
   * still enqueued, but no transaction is broadcast. From
   * `PIPELINE_DRY_RUN` (`"true"`/`"1"`); defaults to `false`. A safe way
   * to soak the loop against production data before letting it write.
   */
  dryRun: boolean;
}

function intFromEnv(env: NodeJS.ProcessEnv, name: string, fallback: number, min: number): number {
  const raw = env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min) {
    throw new Error(
      `environment variable ${name} must be an integer >= ${min}, got ${JSON.stringify(raw)}`,
    );
  }
  return n;
}

function boolFromEnv(env: NodeJS.ProcessEnv, name: string): boolean {
  const raw = (env[name] ?? "").trim().toLowerCase();
  return raw === "true" || raw === "1" || raw === "yes";
}

export function loadPipelineConfig(env: NodeJS.ProcessEnv = process.env): PipelineConfig {
  const names = (env.WAVE_LABEL_NAMES ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return {
    pollIntervalMs: intFromEnv(
      env,
      "PIPELINE_POLL_INTERVAL_MS",
      DEFAULT_POLL_INTERVAL_MS,
      MIN_POLL_INTERVAL_MS,
    ),
    maxIssuesPerRepo: intFromEnv(
      env,
      "PIPELINE_MAX_ISSUES_PER_REPO",
      DEFAULT_MAX_ISSUES_PER_REPO,
      1,
    ),
    waveLabelNames: names.length > 0 ? names : undefined,
    maxQueueDrain: intFromEnv(env, "PIPELINE_MAX_QUEUE_DRAIN", DEFAULT_MAX_QUEUE_DRAIN, 1),
    dryRun: boolFromEnv(env, "PIPELINE_DRY_RUN"),
  };
}
