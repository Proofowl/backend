/**
 * READ-ONLY integration checks against a LIVE ProofOwl contract
 * instance. Never signs or submits anything.
 *
 * Skipped unless `PROOFOWL_INTEGRATION=1`. Defaults target the v0.3
 * (crate 0.3.0) testnet alpha from proofowl-contracts' README
 * "Deployed contracts" table; override with:
 *
 *   PROOFOWL_INTEGRATION=1 \
 *   [PROOFOWL_CONTRACT_ID=C...] [PROOFOWL_RPC_URL=...] \
 *   [PROOFOWL_NETWORK_PASSPHRASE=...] \
 *   [PROOFOWL_TESTNET_WALLET=G...]        # a wallet with known history \
 *   [PROOFOWL_TESTNET_GITHUB_ID_HASH=hex] # linked to that wallet \
 *   npm run test:integration
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { createChainReadClient } from "../../src/chain/readClient.js";

const ENABLED = process.env.PROOFOWL_INTEGRATION === "1";
const SKIP = ENABLED ? false : "set PROOFOWL_INTEGRATION=1 to run live testnet reads";

const config = {
  contractId:
    process.env.PROOFOWL_CONTRACT_ID ?? "CAIDTSVPQICTA2VLE6BSQYHEELHGPZWQDYWKSDBRW4LYPZH6Q44UTAOA",
  rpcUrl: process.env.PROOFOWL_RPC_URL ?? "https://soroban-testnet.stellar.org",
  networkPassphrase: process.env.PROOFOWL_NETWORK_PASSPHRASE ?? "Test SDF Network ; September 2015",
  allowHttp: false,
};

// The wallet the v0.3 phase-2 alpha smoke test left two attestations on
// (docs/testnet/phase2-v0.3-alpha.md). Overridable.
const KNOWN_WALLET =
  process.env.PROOFOWL_TESTNET_WALLET ?? "GCNHX5ORRQLJOFQELVAXZ3PQMIAQ3B3QLKZQRV6FXGICZEMQRWY3TRKG";
const KNOWN_GITHUB_ID_HASH =
  process.env.PROOFOWL_TESTNET_GITHUB_ID_HASH ??
  "a69a5d6eaad01f548a793f28ee34f154d56e4a21eb6de3f23a5543ebd8ea9ca4";
const USING_DEFAULT_CONTRACT =
  !process.env.PROOFOWL_CONTRACT_ID || process.env.PROOFOWL_CONTRACT_ID === config.contractId;
const FIXTURE_SKIP =
  SKIP || (USING_DEFAULT_CONTRACT ? false : "custom contract id set — skipping fixture assertions");

test("get_admin / get_attestor resolve to G-addresses", { skip: SKIP }, async () => {
  const c = createChainReadClient(config);
  const [admin, attestor] = await Promise.all([c.getAdmin(), c.getAttestor()]);
  assert.match(String(admin), /^G[A-Z2-7]{55}$/, "instance must be initialised");
  assert.match(String(attestor), /^G[A-Z2-7]{55}$/, "instance must be initialised");
});

test("a fresh, never-used address has zero history and zero score", { skip: SKIP }, async () => {
  const c = createChainReadClient(config);
  const nobody = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF";
  const rep = await c.getWalletReputation(nobody);
  assert.equal(rep.attestationCount, 0);
  assert.equal(rep.reputationScore, 0);
  assert.deepEqual(await c.listAttestations(nobody), []);
  assert.equal(await c.getGithubIdHashForWallet(nobody), null);
});

test(
  "known fixture wallet: reputation, history, and the attestation-struct decode",
  { skip: FIXTURE_SKIP },
  async () => {
    const c = createChainReadClient(config);

    const linkedWallet = await c.getWalletForGithubIdHash(KNOWN_GITHUB_ID_HASH);
    assert.equal(linkedWallet, KNOWN_WALLET, "github_id_hash resolves to the known wallet");

    assert.equal(await c.getGithubIdHashForWallet(KNOWN_WALLET), KNOWN_GITHUB_ID_HASH);

    const rep = await c.getWalletReputation(KNOWN_WALLET);
    assert.ok(rep.attestationCount >= 2);
    assert.ok(rep.reputationScore >= 250);

    const history = await c.listAttestations(KNOWN_WALLET);
    assert.equal(history.length, rep.attestationCount, "paged history length == count");
    for (const a of history) {
      assert.match(a.githubIdHashHex, /^[0-9a-f]{64}$/);
      assert.match(a.prHashHex, /^[0-9a-f]{64}$/);
      assert.equal(typeof a.repo, "string");
      assert.ok([0, 100, 150, 200].includes(a.complexity));
      assert.equal(typeof a.timestamp, "bigint");
    }
    // score is the sum of (complexity>0 ? complexity : 50), saturating
    const recomputed = history.reduce((s, a) => s + (a.complexity > 0 ? a.complexity : 50), 0);
    assert.equal(
      recomputed,
      rep.reputationScore,
      "recomputed score matches the on-chain aggregate",
    );

    // Use an attestation earned under the *currently linked* identity so
    // the per-wallet history scan can see it (an entry tagged with a
    // since-unlinked identity resolves to no wallet — confidence
    // "unlinked-identity", by design; see AlreadyAttestedCheck).
    const linked = history.find((a) => a.githubIdHashHex === KNOWN_GITHUB_ID_HASH);
    assert.ok(linked, "expected an attestation under the currently linked identity");
    const check = await c.isContributionAlreadyAttested(linked.githubIdHashHex, linked.prHashHex);
    assert.equal(check.attested, true);
    assert.equal(check.confidence, "checked-linked-wallet");
    assert.equal(check.match?.prHashHex, linked.prHashHex);
  },
);
