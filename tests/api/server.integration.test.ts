/**
 * ONE opt-in test that boots the REAL server and hits the REST API over
 * HTTP against the LIVE v0.3 testnet contract
 * (CAIDTSVPQICTA2VLE6BSQYHEELHGPZWQDYWKSDBRW4LYPZH6Q44UTAOA), asserting
 * the API returns exactly the data earlier tasks already put on-chain.
 *
 * READ ONLY. Every `/api` call is an RPC simulation — zero transactions,
 * zero cost. Skipped unless `PROOFOWL_INTEGRATION=1` (not in default
 * CI). `ATTESTOR_SECRET_KEY` is NOT read, NOT referenced — this exercise
 * signs nothing.
 *
 * The `queue` dep is a stub that throws: this test never touches
 * `/api/queue/status`, so no Prisma / DB connection is opened.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { buildApp } from "../../src/app.js";
import { createChainReadClient } from "../../src/chain/readClient.js";
import type { ApiDeps } from "../../src/api/index.js";
import { startServer, getJson, type RunningServer } from "./support.js";

const ENABLED = process.env.PROOFOWL_INTEGRATION === "1";
const SKIP = ENABLED ? false : "set PROOFOWL_INTEGRATION=1 to hit the live v0.3 contract";

const V03_CONTRACT_ID = "CAIDTSVPQICTA2VLE6BSQYHEELHGPZWQDYWKSDBRW4LYPZH6Q44UTAOA";
const config = {
  contractId: process.env.PROOFOWL_CONTRACT_ID ?? V03_CONTRACT_ID,
  rpcUrl: process.env.PROOFOWL_RPC_URL ?? "https://soroban-testnet.stellar.org",
  networkPassphrase: process.env.PROOFOWL_NETWORK_PASSPHRASE ?? "Test SDF Network ; September 2015",
  allowHttp: false,
};
const PINNED =
  !process.env.PROOFOWL_CONTRACT_ID || process.env.PROOFOWL_CONTRACT_ID === V03_CONTRACT_ID;

// A wallet with real, already-proven on-chain data (one attestation,
// complexity 100 -> score 100), left by an earlier integration run.
const WALLET = "GCCOXCBAYG2S4U5ESPQKV5SW7RGC7KLFUPTDRVZVPAJBMP37LK5OX3FV";
const GITHUB_ID_HASH = "968385dbb90453272b1438af3c69c3ba34f6e3e121a181d7ce41b17abc3b7969";
const PR_HASH = "6a8c62492660a4ab4205e322657f476c073d49603fa0cd5374bde57ff464319b";

function realApp() {
  const deps: ApiDeps = {
    chain: createChainReadClient(config),
    queue: {
      countByStatus() {
        throw new Error("queue is not exercised by the live read-only server test");
      },
    },
  };
  return buildApp({ apiDeps: deps, apiOptions: { disableRateLimit: true, disableCache: true } });
}

test(
  "GET /api/reputation/:wallet returns the wallet's real on-chain reputation",
  { skip: SKIP },
  async () => {
    let srv: RunningServer | undefined;
    try {
      srv = await startServer(realApp());
      const r = await getJson(`${srv.url}/api/reputation/${WALLET}`);
      assert.equal(r.status, 200);
      const b = r.body as { wallet: string; reputationScore: number; attestationCount: number };
      assert.equal(b.wallet, WALLET);
      if (PINNED) {
        assert.equal(b.attestationCount, 1, "one attestation on-chain for this wallet");
        assert.equal(b.reputationScore, 100, "score == the single complexity-100 attestation");
      } else {
        assert.ok(b.attestationCount >= 0 && b.reputationScore >= 0);
      }
    } finally {
      await srv?.close();
    }
  },
);

test(
  "GET /api/attestations/:wallet returns the real attestation, bigint-safe",
  { skip: SKIP },
  async () => {
    let srv: RunningServer | undefined;
    try {
      srv = await startServer(realApp());
      const r = await getJson(`${srv.url}/api/attestations/${WALLET}`);
      assert.equal(r.status, 200);
      const b = r.body as {
        wallet: string;
        pagination: {
          count: number;
          nextCursor: number | null;
          limit: number;
          maxPageSize: number;
        };
        attestations: Array<Record<string, unknown>>;
      };
      assert.equal(b.wallet, WALLET);
      assert.equal(b.pagination.maxPageSize, 50);

      if (PINNED) {
        assert.equal(b.pagination.count, 1);
        assert.equal(b.pagination.nextCursor, null, "short page -> end");
        assert.deepEqual(b.attestations[0], {
          sequence: 0,
          repo: "proofowl/backend-integration-test",
          prNumber: 6695072,
          prHashHex: PR_HASH,
          githubIdHashHex: GITHUB_ID_HASH,
          issueId: "1", // string, never a bigint on the wire
          complexity: 100,
          timestamp: 1788866707, // number
        });
        assert.equal(typeof b.attestations[0]?.issueId, "string");
        assert.equal(typeof b.attestations[0]?.timestamp, "number");
      }
      assert.doesNotThrow(() => JSON.stringify(b));
    } finally {
      await srv?.close();
    }
  },
);

test(
  "GET /api/wallet-for-github/:githubIdHash resolves to the linked wallet",
  { skip: SKIP },
  async () => {
    let srv: RunningServer | undefined;
    try {
      srv = await startServer(realApp());
      const r = await getJson(`${srv.url}/api/wallet-for-github/${GITHUB_ID_HASH}`);
      assert.equal(r.status, 200);
      if (PINNED) {
        assert.deepEqual(r.body, { githubIdHash: GITHUB_ID_HASH, wallet: WALLET });
      }
      // an unlinked-but-valid hash is null, not an error
      const none = await getJson(`${srv.url}/api/wallet-for-github/${"0".repeat(64)}`);
      assert.equal(none.status, 200);
      assert.equal((none.body as { wallet: string | null }).wallet, null);
    } finally {
      await srv?.close();
    }
  },
);

test("malformed input still 400s against the real server", { skip: SKIP }, async () => {
  let srv: RunningServer | undefined;
  try {
    srv = await startServer(realApp());
    assert.equal((await getJson(`${srv.url}/api/reputation/not-a-wallet`)).status, 400);
    assert.equal((await getJson(`${srv.url}/api/wallet-for-github/xyz`)).status, 400);
    assert.equal((await getJson(`${srv.url}/api/attestations/${WALLET}?limit=999`)).status, 400);
  } finally {
    await srv?.close();
  }
});
