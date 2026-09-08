import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { buildApp } from "../../src/app.js";
import { emptyState, fakeDeps, startServer, getJson, type RunningServer } from "./support.js";

const VALID_WALLET = "GCNHX5ORRQLJOFQELVAXZ3PQMIAQ3B3QLKZQRV6FXGICZEMQRWY3TRKG";

function repoRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 12; i++) {
    if (existsSync(join(dir, "package.json")) && existsSync(join(dir, "src", "server.ts")))
      return dir;
    dir = dirname(dir);
  }
  throw new Error("could not locate repo root");
}

test("buildApp() with NO apiDeps: /api not mounted, capabilities reflect it", async () => {
  let srv: RunningServer | undefined;
  try {
    srv = await startServer(buildApp());
    const health = (await getJson(`${srv.url}/health`)).body as {
      capabilities: Record<string, unknown>;
    };
    assert.equal(health.capabilities.frontendRestApi, false);
    assert.equal(health.capabilities.restApiReadOnly, true);
    assert.equal(health.capabilities.attestationSubmission, false);

    const api = await getJson(`${srv.url}/api/reputation/${VALID_WALLET}`);
    assert.equal(api.status, 404, "no /api when apiDeps omitted");
  } finally {
    await srv?.close();
  }
});

test("buildApp({ apiDeps }): /api mounted, /health advertises it, routes work, 404s are clean", async () => {
  const state = emptyState();
  state.reputation.set(VALID_WALLET, { attestationCount: 1, reputationScore: 100 });
  const app = buildApp({
    apiDeps: fakeDeps(state),
    apiOptions: { disableRateLimit: true, disableCache: true },
  });
  let srv: RunningServer | undefined;
  try {
    srv = await startServer(app);
    const health = (await getJson(`${srv.url}/health`)).body as {
      capabilities: Record<string, unknown>;
    };
    assert.equal(health.capabilities.frontendRestApi, true);
    assert.equal(health.capabilities.restApiReadOnly, true);

    const rep = await getJson(`${srv.url}/api/reputation/${VALID_WALLET}`);
    assert.deepEqual(rep.body, { wallet: VALID_WALLET, reputationScore: 100, attestationCount: 1 });

    const qs = await getJson(`${srv.url}/api/queue/status`);
    assert.equal(qs.status, 200);

    const apiMiss = await getJson(`${srv.url}/api/does-not-exist`);
    assert.equal(apiMiss.status, 404);
    assert.deepEqual(apiMiss.body, { error: "not found" });

    const outerMiss = await getJson(`${srv.url}/totally-unknown`);
    assert.equal(outerMiss.status, 404);
    assert.match(String((outerMiss.body as { hint?: string }).hint), /GET \/health/);
  } finally {
    await srv?.close();
  }
});

test("server / app startup imports NOTHING from the pipeline or scheduler", () => {
  const root = repoRoot();
  for (const rel of ["src/server.ts", "src/app.ts"]) {
    const src = readFileSync(join(root, rel), "utf8");
    assert.doesNotMatch(
      src,
      /from\s+["'][^"']*pipeline[^"']*["']/,
      `${rel} imports a pipeline module`,
    );
    assert.doesNotMatch(
      src,
      /\b(createScheduler|runOnce|pipelineMain|startScheduler)\b/,
      `${rel} references the scheduler`,
    );
  }
  // and the barrel re-export in src/index.ts is a re-export, never an invocation
  const index = readFileSync(join(root, "src/index.ts"), "utf8");
  assert.match(index, /export \* as pipeline from/);
  assert.doesNotMatch(index, /createScheduler\(|runOnce\(/);
});
