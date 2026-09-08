import { test } from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_MAX_ISSUES_PER_REPO,
  DEFAULT_POLL_INTERVAL_MS,
  MIN_POLL_INTERVAL_MS,
  loadPipelineConfig,
} from "../../src/pipeline/config.js";

test("defaults when nothing is set", () => {
  const cfg = loadPipelineConfig({});
  assert.equal(cfg.pollIntervalMs, DEFAULT_POLL_INTERVAL_MS);
  assert.equal(cfg.maxIssuesPerRepo, DEFAULT_MAX_ISSUES_PER_REPO);
  assert.equal(cfg.waveLabelNames, undefined);
});

test("reads and parses each env var", () => {
  const cfg = loadPipelineConfig({
    PIPELINE_POLL_INTERVAL_MS: "300000",
    PIPELINE_MAX_ISSUES_PER_REPO: "25",
    WAVE_LABEL_NAMES: "Wave, Stellar Wave ,",
  });
  assert.equal(cfg.pollIntervalMs, 300_000);
  assert.equal(cfg.maxIssuesPerRepo, 25);
  assert.deepEqual(cfg.waveLabelNames, ["Wave", "Stellar Wave"]);
});

test("a poll interval below the floor is rejected loudly", () => {
  assert.throws(
    () => loadPipelineConfig({ PIPELINE_POLL_INTERVAL_MS: "5" }),
    new RegExp(`PIPELINE_POLL_INTERVAL_MS must be an integer >= ${MIN_POLL_INTERVAL_MS}`),
  );
});

test("a non-integer / non-positive issue cap is rejected", () => {
  assert.throws(() => loadPipelineConfig({ PIPELINE_MAX_ISSUES_PER_REPO: "0" }), /integer >= 1/);
  assert.throws(() => loadPipelineConfig({ PIPELINE_MAX_ISSUES_PER_REPO: "ten" }), /integer >= 1/);
});

test("empty string env vars fall back to defaults", () => {
  const cfg = loadPipelineConfig({
    PIPELINE_POLL_INTERVAL_MS: "",
    PIPELINE_MAX_ISSUES_PER_REPO: "",
    WAVE_LABEL_NAMES: "",
  });
  assert.equal(cfg.pollIntervalMs, DEFAULT_POLL_INTERVAL_MS);
  assert.equal(cfg.maxIssuesPerRepo, DEFAULT_MAX_ISSUES_PER_REPO);
  assert.equal(cfg.waveLabelNames, undefined);
});
