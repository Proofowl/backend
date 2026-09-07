/**
 * Environment-driven configuration for proofowl-backend.
 *
 * Everything here is read once at process start. There is no attestor
 * secret key in this scaffold: signing / submitting attestations is
 * explicitly out of scope for this pass (see README "What this repo
 * does NOT do yet"). `ATTESTOR_SECRET_KEY` is parsed only so the shape
 * is reserved and documented; nothing in the codebase uses it, and
 * `.env.example` ships a clearly-fake value.
 */

import { config as loadDotenv } from "dotenv";

loadDotenv();

function optional(name: string, fallback: string): string {
  const v = process.env[name];
  return v === undefined || v === "" ? fallback : v;
}

function optionalInt(name: string, fallback: number): number {
  const v = process.env[name];
  if (v === undefined || v === "") return fallback;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0) {
    throw new Error(`environment variable ${name} must be a non-negative integer, got ${v}`);
  }
  return n;
}

export interface ChainConfig {
  /** Deployed contract id (`C...`). Defaults to the v0.3 testnet alpha. */
  contractId: string;
  rpcUrl: string;
  networkPassphrase: string;
  allowHttp: boolean;
}

export interface GitHubConfig {
  /** REST API base. Overridable for GitHub Enterprise or a test double. */
  apiBaseUrl: string;
  /** Optional token — raises the unauthenticated rate limit. Reads only. */
  token: string | undefined;
  /**
   * Where the Stellar Wave approved-orgs list is fetched from. The
   * canonical page (drips.network/wave/stellar/orgs) is a client-rendered
   * app with no confirmed public JSON endpoint — see
   * src/github/approvedOrgs.ts and the README. Overridable so a real
   * endpoint (or a test fixture server) can be pointed at without a code
   * change.
   */
  approvedOrgsUrl: string;
}

export interface AppConfig {
  nodeEnv: string;
  port: number;
  chain: ChainConfig;
  github: GitHubConfig;
  /** Prisma / SQLite connection string. Only used by the queue layer. */
  databaseUrl: string;
  /**
   * Reserved. NOT used anywhere in this pass — attestation submission is
   * out of scope. Present so the env contract is stable for the follow-up.
   */
  attestorSecretKeyIsSet: boolean;
}

/** The v0.3 (crate 0.3.0) testnet alpha instance — proofowl-contracts README "Deployed contracts". */
export const DEFAULT_TESTNET_CONTRACT_ID =
  "CAIDTSVPQICTA2VLE6BSQYHEELHGPZWQDYWKSDBRW4LYPZH6Q44UTAOA";
export const DEFAULT_RPC_URL = "https://soroban-testnet.stellar.org";
export const TESTNET_PASSPHRASE = "Test SDF Network ; September 2015";
export const DEFAULT_APPROVED_ORGS_URL = "https://drips.network/wave/stellar/orgs";

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const prev = process.env;
  process.env = env;
  try {
    return {
      nodeEnv: optional("NODE_ENV", "development"),
      port: optionalInt("PORT", 3000),
      chain: {
        contractId: optional("PROOFOWL_CONTRACT_ID", DEFAULT_TESTNET_CONTRACT_ID),
        rpcUrl: optional("PROOFOWL_RPC_URL", DEFAULT_RPC_URL),
        networkPassphrase: optional("PROOFOWL_NETWORK_PASSPHRASE", TESTNET_PASSPHRASE),
        allowHttp: optional("PROOFOWL_ALLOW_HTTP", "false") === "true",
      },
      github: {
        apiBaseUrl: optional("GITHUB_API_BASE_URL", "https://api.github.com"),
        token: process.env.GITHUB_TOKEN || undefined,
        approvedOrgsUrl: optional("WAVE_APPROVED_ORGS_URL", DEFAULT_APPROVED_ORGS_URL),
      },
      databaseUrl: optional("DATABASE_URL", "file:./prisma/dev.db"),
      attestorSecretKeyIsSet: !!process.env.ATTESTOR_SECRET_KEY,
    };
  } finally {
    process.env = prev;
  }
}

export const config = loadConfig();
