/**
 * Express application factory.
 *
 * SCOPE: this scaffold intentionally exposes only liveness/readiness
 * endpoints. There is NO REST API for the frontend yet, no polling
 * loop, and no attestation-submission endpoint — see the README's
 * "What this repo does NOT do yet". The verification, hashing, on-chain
 * read, and queue modules are wired as libraries (src/hashing,
 * src/github, src/chain, src/queue) and exercised by the test suite,
 * not by HTTP routes.
 */

import express, { type Express, type Request, type Response } from "express";

export interface BuildAppOptions {
  /** Included verbatim in GET /health. Handy for smoke-checking a deploy. */
  version?: string;
}

export function buildApp(options: BuildAppOptions = {}): Express {
  const app = express();

  app.disable("x-powered-by");
  app.use(express.json());

  // Liveness: the process is up. No dependency checks.
  app.get("/health", (_req: Request, res: Response) => {
    res.json({
      status: "ok",
      service: "proofowl-backend",
      version: options.version ?? "0.0.1",
      // Loudly restate the scope so nobody mistakes this for a running
      // verification service.
      capabilities: {
        livePolling: false,
        attestationSubmission: false,
        frontendRestApi: false,
        onChainReads: true,
        githubVerification: true,
      },
    });
  });

  // Readiness placeholder. A later pass adds real dependency probes
  // (Soroban RPC reachable, DB migrated, GitHub reachable).
  app.get("/ready", (_req: Request, res: Response) => {
    res.json({ status: "ok" });
  });

  app.use((_req: Request, res: Response) => {
    res.status(404).json({ error: "not found", hint: "this service exposes no REST API yet" });
  });

  return app;
}
