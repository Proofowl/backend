/**
 * The automation pipeline entrypoint — the ONLY thing that wires the
 * pieces in this directory to real I/O and a clock.
 *
 *   npm run pipeline:once   # one pass, print the summary, exit
 *   npm run pipeline:loop   # a pass now, then every PIPELINE_POLL_INTERVAL_MS
 *
 * `src/server.ts` never imports this file; `npm start` / `npm run dev`
 * do not run a pass. Automation happens only when an operator runs one
 * of the commands above.
 *
 * `ATTESTOR_SECRET_KEY` is read once here, handed straight to
 * `createSdkAttestationSubmitter`, and never logged or printed — not in
 * the summary, not on an error path. A missing or malformed key stops
 * the process before any network use, with a message that does not
 * echo the value.
 */

import { config } from "../config.js";
import {
  assertTestnet,
  chainConfigToSdkConfig,
  createChainReadClient,
  createSdkAttestationSubmitter,
} from "../chain/index.js";
import { createGitHubModule } from "../github/index.js";
import { createQueue, disconnectPrisma } from "../queue/index.js";
import { loadPipelineConfig } from "./config.js";
import { discoveryLabelConfig } from "./discover.js";
import { consolePipelineLogger } from "./log.js";
import { runOnce, type RunOnceDeps, type RunOnceSummary } from "./runOnce.js";
import { createScheduler } from "./schedule.js";
import { seedReposFromAllowlist } from "./seed.js";

type Mode = "once" | "loop";

function parseMode(argv: string[]): Mode {
  const raw = argv[2];
  if (raw === "once" || raw === "loop") return raw;
  process.stderr.write(
    `usage: pipeline (once|loop)\n` +
      `  once  — run a single pass, print the JSON summary, exit\n` +
      `  loop  — run continuously, one pass every PIPELINE_POLL_INTERVAL_MS\n`,
  );
  process.exit(2);
}

async function buildDeps(): Promise<RunOnceDeps> {
  // Hard network guard with an operator-friendly message; the submitter
  // and submitAttestation re-check this too.
  assertTestnet(config.chain.networkPassphrase);

  const secret = process.env.ATTESTOR_SECRET_KEY;
  if (!secret || secret.trim() === "") {
    process.stderr.write(
      "ATTESTOR_SECRET_KEY is not set — the pipeline signs submit_attestation with it. " +
        "Set it in .env (git-ignored) and retry.\n",
    );
    process.exit(1);
  }

  const sdkConfig = chainConfigToSdkConfig(config.chain);
  const pipelineConfig = loadPipelineConfig();
  const gh = createGitHubModule(config.github);
  const seeds = await seedReposFromAllowlist(gh.approvedOrgsAllowlist);
  const labels = discoveryLabelConfig(pipelineConfig.waveLabelNames);

  consolePipelineLogger.log({
    level: "info",
    event: "pipeline.config",
    message: `pipeline configured for ${seeds.length} seed repo(s)`,
    fields: {
      seedRepos: seeds.length,
      contract: config.chain.contractId,
      rpcUrl: config.chain.rpcUrl,
      pollIntervalMs: pipelineConfig.pollIntervalMs,
      maxIssuesPerRepo: pipelineConfig.maxIssuesPerRepo,
      maxQueueDrain: pipelineConfig.maxQueueDrain,
      dryRun: pipelineConfig.dryRun,
      labelPrefilter: labels.labelPrefilter ?? null,
    },
  });

  return {
    queue: createQueue(),
    reads: createChainReadClient(sdkConfig),
    // Throws (without echoing the key) on a malformed secret or a
    // non-testnet config.
    submitter: createSdkAttestationSubmitter(sdkConfig, secret),
    github: gh.client,
    approvedOrgs: gh.approvedOrgs,
    approvedOrgsAllowlist: gh.approvedOrgsAllowlist,
    seeds,
    isWaveLabel: labels.isWaveLabel,
    ...(labels.labelPrefilter ? { labelPrefilter: labels.labelPrefilter } : {}),
    maxIssuesPerRepo: pipelineConfig.maxIssuesPerRepo,
    maxQueueDrain: pipelineConfig.maxQueueDrain,
    dryRun: pipelineConfig.dryRun,
    logger: consolePipelineLogger,
  };
}

function printSummary(summary: RunOnceSummary): void {
  process.stdout.write(
    JSON.stringify(summary, (_k, v) => (typeof v === "bigint" ? v.toString() : v), 2) + "\n",
  );
}

async function main(): Promise<void> {
  const mode = parseMode(process.argv);
  const deps = await buildDeps();

  if (mode === "once") {
    try {
      printSummary(await runOnce(deps));
    } finally {
      await disconnectPrisma();
    }
    return;
  }

  // mode === "loop"
  const pipelineConfig = loadPipelineConfig();
  const scheduler = createScheduler<RunOnceSummary>({
    intervalMs: pipelineConfig.pollIntervalMs,
    run: () => runOnce(deps),
    logger: consolePipelineLogger,
  });

  let shuttingDown = false;
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => {
      if (shuttingDown) return;
      shuttingDown = true;
      consolePipelineLogger.log({
        level: "info",
        event: "pipeline.shutdown",
        message: `${signal} received — stopping the scheduler`,
      });
      scheduler.stop();
      void disconnectPrisma().finally(() => process.exit(0));
    });
  }

  scheduler.start();
}

main().catch((err) => {
  process.stderr.write(
    `pipeline failed to start: ${err instanceof Error ? err.message : String(err)}\n`,
  );
  process.exit(1);
});
