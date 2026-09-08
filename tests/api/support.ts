/**
 * Test support for the REST API suite. Filename has no `.test.` segment,
 * so the runner glob for compiled test files does not pick it up.
 *
 * `startServer(app)` boots an Express app on an ephemeral port; tests
 * hit it with the global `fetch`. This matches how the scaffold's app
 * smoke test worked — no `supertest` dependency, real Express routing
 * and error-forwarding exercised end to end.
 */

import type { AddressInfo } from "node:net";
import type { Express } from "express";

import type { AttestationRecord } from "../../src/chain/index.js";
import type { ApiDeps } from "../../src/api/deps.js";
import { ALL_PENDING_STATUSES, type PendingStatus } from "../../src/queue/status.js";

export interface RunningServer {
  url: string;
  close(): Promise<void>;
}

/** Boot `app` on port 0 and return its base URL + a `close()`. */
export function startServer(app: Express): Promise<RunningServer> {
  return new Promise((resolve) => {
    const server = app.listen(0, () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        url: `http://127.0.0.1:${port}`,
        close: () => new Promise<void>((r) => server.close(() => r())),
      });
    });
  });
}

export interface JsonResponse {
  status: number;
  body: unknown;
  text: string;
  headers: Headers;
}

/** GET `url` and parse the body as JSON when possible. */
export async function getJson(url: string, init?: RequestInit): Promise<JsonResponse> {
  const res = await fetch(url, init);
  const text = await res.text();
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    body = undefined;
  }
  return { status: res.status, body, text, headers: res.headers };
}

// --- in-memory ApiDeps for the route/router tests --------------------

export interface FakeApiState {
  /** wallet -> { attestationCount, reputationScore } */
  reputation: Map<string, { attestationCount: number; reputationScore: number }>;
  /** wallet -> full attestation history (paged in the fake) */
  attestations: Map<string, AttestationRecord[]>;
  /** github_id_hash hex -> linked wallet */
  linkedWallet: Map<string, string>;
  /** status -> count */
  queueCounts: Record<PendingStatus, number>;
  /** every dep method call, in order — lets a test assert "no RPC on a 400". */
  calls: string[];
}

export function emptyState(): FakeApiState {
  const queueCounts = Object.fromEntries(ALL_PENDING_STATUSES.map((s) => [s, 0])) as Record<
    PendingStatus,
    number
  >;
  return {
    reputation: new Map(),
    attestations: new Map(),
    linkedWallet: new Map(),
    queueCounts,
    calls: [],
  };
}

/** Build an `ApiDeps` backed by `state` (mutate `state` before/between calls). */
export function fakeDeps(state: FakeApiState): ApiDeps {
  return {
    chain: {
      async getWalletReputation(wallet: string) {
        state.calls.push(`getWalletReputation(${wallet})`);
        const r = state.reputation.get(wallet) ?? { attestationCount: 0, reputationScore: 0 };
        return { wallet, ...r };
      },
      async getAttestationsPage(wallet: string, start: number, limit: number) {
        state.calls.push(`getAttestationsPage(${wallet},${start},${limit})`);
        const all = state.attestations.get(wallet) ?? [];
        return all.slice(start, start + limit);
      },
      async getWalletForGithubIdHash(githubIdHash: string | Uint8Array) {
        const hex =
          typeof githubIdHash === "string"
            ? githubIdHash
            : Buffer.from(githubIdHash).toString("hex");
        state.calls.push(`getWalletForGithubIdHash(${hex})`);
        return state.linkedWallet.get(hex.toLowerCase()) ?? null;
      },
    },
    queue: {
      async countByStatus() {
        state.calls.push("countByStatus()");
        return { ...state.queueCounts };
      },
    },
  };
}
