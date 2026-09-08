/**
 * Express application factory.
 *
 * Serves liveness/readiness (`/health`, `/ready`) and, when `apiDeps`
 * are supplied, the **read-only** REST API under `/api` (see
 * `src/api/`). There is still no write path anywhere in the HTTP layer:
 * `/api` only reads on-chain state and local queue counts. The pipeline
 * / scheduler is NOT imported here and is never started by the server.
 */

import express, { type Express, type NextFunction, type Request, type Response } from "express";

import { createApiRouter, type ApiDeps, type ApiRouterOptions } from "./api/index.js";

export interface BuildAppOptions {
  /** Included verbatim in GET /health. Handy for smoke-checking a deploy. */
  version?: string;
  /**
   * When provided, mounts the read-only REST API under `/api`. Omit it
   * (as most unit tests do) and the app is just `/health` + `/ready`.
   */
  apiDeps?: ApiDeps;
  /** Rate-limit / cache overrides for the `/api` router (tests). */
  apiOptions?: ApiRouterOptions;
}

export function buildApp(options: BuildAppOptions = {}): Express {
  const app = express();
  const apiMounted = options.apiDeps !== undefined;

  app.disable("x-powered-by");
  app.use(express.json());

  // Liveness: the process is up. No dependency checks.
  app.get("/health", (_req: Request, res: Response) => {
    res.json({
      status: "ok",
      service: "proofowl-backend",
      version: options.version ?? "0.0.1",
      // Loudly restate the scope so nobody mistakes this for more than
      // it is.
      capabilities: {
        livePolling: false,
        attestationSubmission: false,
        frontendRestApi: apiMounted,
        restApiReadOnly: true,
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

  if (options.apiDeps) {
    app.use("/api", createApiRouter(options.apiDeps, options.apiOptions));
  }

  app.use((_req: Request, res: Response) => {
    res.status(404).json({ error: "not found", hint: "unknown route — see GET /health" });
  });

  // Defensive outer error handler: even for the trivial /health, /ready
  // handlers, never let Express's default (which leaks a stack outside
  // production) format an error.
  app.use((err: unknown, req: Request, res: Response, _next: NextFunction) => {
    if (res.headersSent) return;
    console.error(`[app] ${req.method} ${req.originalUrl} -> unhandled error:`, err);
    res.status(500).json({ error: "internal error" });
  });

  return app;
}
