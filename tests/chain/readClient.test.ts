/**
 * Offline unit tests for the chain read client — argument validation
 * only, no network. The real decode path is exercised against the live
 * contract in testnet.integration.test.ts.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { createChainReadClient } from "../../src/chain/readClient.js";
import { chainConfigToSdkConfig } from "../../src/chain/index.js";

const config = {
  contractId: "CAIDTSVPQICTA2VLE6BSQYHEELHGPZWQDYWKSDBRW4LYPZH6Q44UTAOA",
  rpcUrl: "https://soroban-testnet.stellar.org",
  networkPassphrase: "Test SDF Network ; September 2015",
  allowHttp: false,
};

test("createChainReadClient exposes the read-only surface and the SDK escape hatch", () => {
  const c = createChainReadClient(chainConfigToSdkConfig(config));
  assert.equal(typeof c.getWalletForGithubIdHash, "function");
  assert.equal(typeof c.listAttestations, "function");
  assert.equal(typeof c.isContributionAlreadyAttested, "function");
  assert.ok(c.sdk, "SDK read client is reachable for scalar reads");
  // No mutating helpers leak through.
  assert.equal("submitAttestation" in c, false);
  assert.equal("prepareSubmitAttestation" in c, false);
});

test("wallet-shaped arguments are validated before any round-trip", async () => {
  const c = createChainReadClient(chainConfigToSdkConfig(config));
  await assert.rejects(c.getWalletReputation("not-a-wallet"), /G\.\.\./);
  await assert.rejects(c.getGithubIdHashForWallet("GABC"), /G\.\.\./);
  await assert.rejects(c.listAttestations("x"), /G\.\.\./);
});

test("hash-shaped arguments are validated before any round-trip", async () => {
  const c = createChainReadClient(chainConfigToSdkConfig(config));
  await assert.rejects(c.getWalletForGithubIdHash("abc"), /64-char hex|32 bytes/);
  await assert.rejects(c.isContributionAlreadyAttested("a".repeat(64), "nope"), /64 hex chars/);
  await assert.rejects(c.getWalletForGithubIdHash(new Uint8Array(31)), /32 bytes/);
});

test("getAttestationsPage rejects an out-of-range limit locally (contract MAX_PAGE_SIZE)", async () => {
  const c = createChainReadClient(chainConfigToSdkConfig(config));
  const wallet = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF";
  await assert.rejects(c.getAttestationsPage(wallet, 0, 0), /1\.\.=50/);
  await assert.rejects(c.getAttestationsPage(wallet, 0, 51), /1\.\.=50/);
  await assert.rejects(c.getAttestationsPage(wallet, -1, 10), /non-negative/);
});
