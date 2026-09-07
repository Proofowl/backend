/**
 * Pins this service's canonical hashing to
 * identifier-spec-v1.md, three ways:
 *
 *   1. against the spec's own published vectors (§1.4, §2.4) — copied
 *      verbatim below, same set as the contracts repo's
 *      `sdk/typescript/src/identifiers.test.ts` and `tests/sdk_vectors.rs`;
 *   2. against the contracts SDK's exported functions at runtime, so a
 *      future drift between this module and the on-chain de-dup key
 *      fails here;
 *   3. round-tripping raw-bytes <-> hex and the rejection cases the spec
 *      lists as "must throw".
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  hashGitHubUserIdV1Hex as sdkHashUser,
  hashGitHubPullRequestV1Hex as sdkHashPr,
  normalizeGitHubPullRequest as sdkNormalizePr,
} from "@proofowl/contract-sdk";

import {
  GITHUB_USER_ID_PREFIX_V1,
  bytesToHex,
  canonicalGitHubUserIdStringV1,
  canonicalGitHubUserIdDecimal,
  hashGitHubPullRequestV1,
  hashGitHubPullRequestV1Hex,
  hashGitHubUserIdV1,
  hashGitHubUserIdV1Hex,
  normalizeGitHubPullRequest,
  verifyAttestationPrHash,
} from "../../src/hashing/index.js";

// --- vectors copied verbatim from identifier-spec-v1.md -----------------

const GH_USER_VECTORS: ReadonlyArray<readonly [string | number | bigint, string, string]> = [
  [
    1,
    "proofowl:github-user:v1:1",
    "ad6494a9db671dce66088a82f8446c464e7d425da57d4eca4081b19a74b1e584",
  ],
  [
    1024025,
    "proofowl:github-user:v1:1024025",
    "fd608646c4bd0a96553707213c1680c9dfcb0c9ba47f649ccb1c7924125176cb",
  ],
  [
    9007199254740991n,
    "proofowl:github-user:v1:9007199254740991",
    "1e7fa4a5295f32689530d00860728b707d60f73de136143ee122575b46604e9e",
  ],
];

const PR_VECTORS: ReadonlyArray<readonly [string, string, number | string, string, string]> = [
  [
    "stellar",
    "soroban-examples",
    42,
    "github.com/stellar/soroban-examples/pull/42",
    "1eed82536f9e3a9477916599ab2111d9af634b1270f5d4d1d61ee98bd50d6c0e",
  ],
  [
    "@ProofOwl",
    "Proofowl-Contracts.git",
    "#7",
    "github.com/proofowl/proofowl-contracts/pull/7",
    "be9b713cbcbacdc44d593cd3e37f8680f6e7e229af9c2182cde3ee05a2bf6cef",
  ],
  [
    "a",
    "b",
    1,
    "github.com/a/b/pull/1",
    "74b8b07fec5539a632c2df4ecd2aafaadfe0df40f9941fba6c11bfa7039c4c93",
  ],
];

// --- §1 github_id_hash ------------------------------------------------

test("github_id_hash matches the spec vectors", () => {
  for (const [input, canonical, hex] of GH_USER_VECTORS) {
    assert.equal(canonicalGitHubUserIdStringV1(input), canonical);
    assert.equal(hashGitHubUserIdV1Hex(input), hex);
    assert.equal(bytesToHex(hashGitHubUserIdV1(input)), hex);
    assert.equal(hashGitHubUserIdV1(input).length, 32);
  }
});

test("github_id_hash agrees with the contracts SDK", () => {
  for (const [input] of GH_USER_VECTORS) {
    assert.equal(hashGitHubUserIdV1Hex(input), sdkHashUser(input));
  }
  // a few non-vector ids too
  for (const id of [2n, 583231n, 9999999n, "40000000"]) {
    assert.equal(hashGitHubUserIdV1Hex(id), sdkHashUser(id));
  }
});

test("string and numeric id forms agree", () => {
  assert.equal(hashGitHubUserIdV1Hex("1024025"), hashGitHubUserIdV1Hex(1024025));
  assert.equal(hashGitHubUserIdV1Hex(1n), hashGitHubUserIdV1Hex(1));
  assert.equal(canonicalGitHubUserIdDecimal("1024025"), "1024025");
});

test("the github-user prefix is exactly as specified", () => {
  assert.equal(GITHUB_USER_ID_PREFIX_V1, "proofowl:github-user:v1:");
});

test("github_id_hash rejects malformed ids (spec §1.2 validation)", () => {
  for (const bad of [0, -1, 1.5, "0", "01", "+1", " 1", "1 ", "", "1e5", "0x1", "abc", null]) {
    assert.throws(
      () => canonicalGitHubUserIdStringV1(bad as never),
      `${JSON.stringify(bad)} should be rejected`,
    );
  }
  assert.throws(() => canonicalGitHubUserIdStringV1(9007199254740992n), /2\^53/);
});

// --- §2 pr_hash ------------------------------------------------------

test("pr_hash matches the spec vectors, with normalization", () => {
  for (const [owner, repo, num, canonical, hex] of PR_VECTORS) {
    assert.equal(normalizeGitHubPullRequest(owner, repo, num).canonical, canonical);
    assert.equal(hashGitHubPullRequestV1Hex(owner, repo, num), hex);
    assert.equal(bytesToHex(hashGitHubPullRequestV1(owner, repo, num)), hex);
    assert.equal(hashGitHubPullRequestV1(owner, repo, num).length, 32);
  }
});

test("pr_hash and normalization agree with the contracts SDK", () => {
  const cases: ReadonlyArray<readonly [string, string, number | string]> = [
    ...PR_VECTORS.map(([o, r, n]) => [o, r, n] as const),
    ["Stellar", "Soroban-Examples", "42"],
    ["@octocat", "Hello-World.GIT", "#2048"],
    ["a-b-c", "x.y_z-1", 4294967295],
  ];
  for (const [owner, repo, num] of cases) {
    assert.equal(hashGitHubPullRequestV1Hex(owner, repo, num), sdkHashPr(owner, repo, num));
    assert.equal(
      normalizeGitHubPullRequest(owner, repo, num).canonical,
      sdkNormalizePr(owner, repo, num).canonical,
    );
  }
});

test("normalization absorbs cosmetic variation only", () => {
  const base = normalizeGitHubPullRequest("Stellar", "Soroban-Examples", 42).canonical;
  assert.equal(normalizeGitHubPullRequest("stellar", "soroban-examples", "42").canonical, base);
  assert.equal(
    normalizeGitHubPullRequest("@stellar", "soroban-examples.git", "#42").canonical,
    base,
  );
  assert.equal(normalizeGitHubPullRequest("  stellar  ", " soroban-examples ", 42).canonical, base);
});

test("pr_hash rejects the spec's 'must throw' inputs", () => {
  const bad: ReadonlyArray<readonly [string, string, unknown]> = [
    ["", "r", 1],
    ["o", "", 1],
    ["o/x", "r", 1],
    ["o", "r/x", 1],
    ["o", ".", 1],
    ["o", "..", 1],
    ["-o", "r", 1],
    ["o-", "r", 1],
    ["thisownernameiswaytoolongtobeavalidgithubloginxx", "r", 1],
    ["oñ", "r", 1],
    ["o", "r", 0],
    ["o", "r", "01"],
    ["o", "r", -1],
    ["o", "r", "1.0"],
    ["o", "r", 5_000_000_000],
    ["o", "r", "99999999999"],
    ["https://github.com/o/r/pull/1", "r", 1],
    ["o r", "r", 1],
    ["o", "r r", 1],
  ];
  for (const [owner, repo, num] of bad) {
    assert.throws(
      () => normalizeGitHubPullRequest(owner, repo, num as never),
      `${JSON.stringify([owner, repo, num])} should be rejected`,
    );
  }
});

// --- §2.6 recompute-and-compare -----------------------------------------

test("verifyAttestationPrHash confirms a consistent record and flags a bad one", () => {
  const hex = hashGitHubPullRequestV1Hex("stellar", "soroban-examples", 42);
  assert.equal(verifyAttestationPrHash("stellar/soroban-examples", 42, hex), true);
  assert.equal(verifyAttestationPrHash("stellar/soroban-examples", 42, hex.toUpperCase()), true);
  assert.equal(verifyAttestationPrHash("stellar/soroban-examples", 43, hex), false);
  assert.equal(verifyAttestationPrHash("other/repo", 42, hex), false);
  assert.throws(() => verifyAttestationPrHash("no-slash", 1, hex), /<owner>\/<repo>/);
});
