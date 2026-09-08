# End-to-end demo — real GitHub → live pipeline → testnet attestation → REST API

**What this proves:** the full `proofowl-backend` chain works together,
with real evidence. A real GitHub issue + PR were created and merged on
`Proofowl/backend`, discovered **live via the GitHub API** (not mocked,
not injected), verified against real GitHub data, routed through the
real automation pipeline, submitted **for real** to the deployed v0.3
testnet registry, and read back through the real read-only REST API.

**This is testnet only.** Not an audit, not a mainnet deployment, not a
mainnet-readiness claim. Two real testnet transactions were made
(`link_github`, `submit_attestation`); every value below is public
on-chain / public GitHub data. No secret key appears here.

| Field                                   | Value                                                                                                                                                                                                                         |
| --------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Date (UTC)                              | 2026-09-08                                                                                                                                                                                                                    |
| Registry contract (v0.3, crate `0.3.0`) | `CAIDTSVPQICTA2VLE6BSQYHEELHGPZWQDYWKSDBRW4LYPZH6Q44UTAOA`                                                                                                                                                                    |
| Network                                 | Stellar **testnet** (`Test SDF Network ; September 2015`)                                                                                                                                                                     |
| Soroban RPC                             | `https://soroban-testnet.stellar.org`                                                                                                                                                                                         |
| Attestor (on-chain `get_attestor()`)    | `GAVHDK6V2LBGBCBWIZXEHDJAW6ZZKPCKLDANURKJZU4NFDCAV2BYFXEF` (the rotated backend-service identity — see [`attestor-rotation`](https://github.com/Proofowl/proofowl-contracts/blob/main/docs/testnet/attestor-rotation-log.md)) |
| Real testnet transactions this exercise | **2** — 1 `link_github`, 1 `submit_attestation`                                                                                                                                                                               |

---

## Phase A — the real fixture (one merged PR)

A single, clearly-marked demo Pull Request, so discovery has something
real to find.

| Artifact                       | Value                                                                                                                                      |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `wave` label                   | created on `Proofowl/backend` (matches the pipeline's default Wave-label pattern — `"wave"`)                                               |
| **Fixture issue**              | [`Proofowl/backend#4`](https://github.com/Proofowl/backend/issues/4) — _"[demo] end-to-end pipeline fixture — not a real feature request"_ |
| Issue created (UTC)            | `2026-09-08T23:13:31Z`                                                                                                                     |
| **`wave` label applied to #4** | `2026-09-08T23:13:33Z` (timeline `labeled` event, actor `maztah1`)                                                                         |
| **Fixture PR**                 | [`Proofowl/backend#5`](https://github.com/Proofowl/backend/pull/5) — _"[demo] e2e pipeline fixture PR — not a real feature"_               |
| PR change                      | one new file, `docs/testnet/e2e-demo-fixture.md` — a marker doc; no functional code touched                                                |
| PR body                        | contains `Closes #4` (GitHub records `closingIssuesReferences: [4]`)                                                                       |
| PR opened (UTC)                | `2026-09-08T23:15:28Z`                                                                                                                     |
| **PR merged (UTC)**            | `2026-09-08T23:16:24Z`, by `maztah1`                                                                                                       |
| Merge commit SHA               | `10341d54b6b0c27a8fde649bed4f5daaa46194ca`                                                                                                 |
| Issue #4 auto-closed           | `2026-09-08T23:16:28Z` (by the merge)                                                                                                      |

### Chronological order (matters for `wave_label_predates_pr_merge`)

```
23:13:31Z  issue #4 created
23:13:33Z  'wave' label applied to issue #4        ◄── label first
23:15:28Z  PR #5 opened            (label + 115 s)
23:16:24Z  PR #5 merged            (label + 171 s) ◄── merge after
23:16:28Z  issue #4 auto-closed
```

The Wave label was applied **before** the PR was opened and **before**
it was merged.

---

## Phase B — identity

The account that opened **and** merged the fixture PR:

| Field                                                    | Value                                                              |
| -------------------------------------------------------- | ------------------------------------------------------------------ |
| GitHub login                                             | `maztah1`                                                          |
| GitHub numeric user id (`gh api users/maztah1 --jq .id`) | `267481210`                                                        |
| Canonical string (identifier-spec-v1 §1.2)               | `proofowl:github-user:v1:267481210`                                |
| **`github_id_hash`** (SHA-256, lowercase hex)            | `6054b7be2332bad64108b27f181cfc8dfcb15cc0106de5671bd9519c2e071a51` |

The id is not secret; anyone can recompute the hash. It was produced by
this repo's own `hashGitHubUserIdV1Hex` and independently cross-checked
against a raw `sha256`.

---

## Phase C — the live pipeline run

### C1. Synthetic wallet

| Field                         | Value                                                            |
| ----------------------------- | ---------------------------------------------------------------- |
| Synthetic demo wallet (`G…`)  | `GAXZZJW7Y4GYRG32MKSAU3YMHQ4PZRHDVDE53DNLNBMK4O4NXLHTPWER`       |
| Funding                       | friendbot (SDF faucet — not a contract transaction, not counted) |
| Horizon balance after funding | `10000.0000000` native XLM                                       |

### C2. Discovery + verification — BEFORE linking (0 transactions)

`discoverCandidates` over the allowlist seed repos
(`proofowl/proofowl-contracts`, `proofowl/backend`), live against the
GitHub API:

```
discovery.candidate — proofowl/backend#4 <- merged PR #5

candidate = { "owner": "proofowl", "repo": "backend",
              "issueNumber": 4, "prNumber": 5 }

stats = { seedRepos: 2, issuesScanned: 1, waveIssues: 1,
          waveIssuesWithoutMergedPr: 0, reposErrored: 0 }
```

`verifyContribution(candidate)` — the real result, all reads live from
GitHub:

| #   | check                          | status              | detail                                                                                                                                                                                                                 |
| --- | ------------------------------ | ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| a   | `repo_in_approved_orgs`        | **pass**            | `confidence: "manually-asserted-allowlist"` — `proofowl/backend` is on the operator allowlist (asserted by the maintainer); the live Drips source was `indeterminate` (client-rendered HTML, no public JSON endpoint). |
| b   | `issue_has_wave_label`         | **pass**            | issue #4 carries Wave label(s): `wave`                                                                                                                                                                                 |
| c   | `wave_label_predates_pr_merge` | **pass**            | label applied `2026-09-08T23:13:33Z` — before PR merge `2026-09-08T23:16:24Z` (`deltaSeconds: 171`)                                                                                                                    |
| d   | `pr_closes_issue`              | **pass**            | PR #5 closes issue #4 (GitHub closing-issue link; `closingIssueNumbers: [4]`)                                                                                                                                          |
| e   | `pr_is_merged`                 | **pass**            | PR #5 is merged (`merged_at 2026-09-08T23:16:24Z`)                                                                                                                                                                     |
| f   | `flags.selfMerge`              | **flagged: `true`** | `"self-merge: maztah1 (id 267481210) authored and merged PR #5"` — `prAuthorId: 267481210` **equals** `mergedById: 267481210`                                                                                          |

`attestable: true`, `indeterminate: false`.

**Self-merge — first live observation of this flag.** It fired **`true`**
because the same GitHub account (`maztah1`, id `267481210`) both
_authored_ and _merged_ the fixture PR, so `buildSelfMergeFlag`'s
`flagged = (mergedById === prAuthorId)` is true. It is a **flag, not a
gating check**: `attestable` is `checks.every(c => c.status === "pass")`
and does not include the flag. The contribution therefore stays
attestable and is submitted — the pipeline just records
`selfMergeFlagged: true` on the queue row (`runOnce.ts`), leaving the
"reject vs. attest-and-mark" policy to a downstream consumer. In this
demo it was attested with the flag set.

### C3. Pipeline pass #1 — enqueue (0 transactions)

`npm run pipeline:once`. Queue empty → discovery finds the candidate →
verify attestable → `submitAttestation` → wallet not linked →
`not-submittable` → **enqueued**.

```
discovery: { candidates: 1, attestable: 1,
             submitOutcomes: { not-submittable: 1 }, enqueued: 1 }
realSubmissionAttempts: 0
submittedTxHashes: []
```

`pr_hash = SHA-256("github.com/proofowl/backend/pull/5")`
` = d07879a0ea96f8f8995a531d4d8792c54b93151b020da468f41bdccf0ff15112`

Queue row written:

```
prHash           d07879a0ea96f8f8995a531d4d8792c54b93151b020da468f41bdccf0ff15112
githubIdHash     6054b7be2332bad64108b27f181cfc8dfcb15cc0106de5671bd9519c2e071a51
githubUserId     267481210
repo             proofowl/backend
prNumber         5
issueId          4
complexity       0
status           WAITING_FOR_WALLET_LINK
selfMergeFlagged true
```

### C4. TRANSACTION #1 — `link_github` (two-party)

Signed by the synthetic wallet (invoker) **and** the attestor. Network
re-confirmed live via `getNetwork` before sending; on-chain
`get_attestor()` re-confirmed to equal the key-derived attestor public
key.

| Field                                         | Value                                                                         |
| --------------------------------------------- | ----------------------------------------------------------------------------- |
| **Transaction hash**                          | `fea4a80426fa9b568d7d1f198eb0f10ee1847d1cb647ac1c1e7da84151103e30`            |
| Horizon `successful`                          | `true`                                                                        |
| Ledger                                        | `4577301`                                                                     |
| Horizon `created_at`                          | `2026-09-08T23:28:12Z`                                                        |
| `source_account`                              | `GAXZZJW7Y4GYRG32MKSAU3YMHQ4PZRHDVDE53DNLNBMK4O4NXLHTPWER` (synthetic wallet) |
| `operation_count`                             | `1`                                                                           |
| `get_wallet_for_github(6054b7be…)` **before** | `null`                                                                        |
| `get_wallet_for_github(6054b7be…)` **after**  | `GAXZZJW7Y4GYRG32MKSAU3YMHQ4PZRHDVDE53DNLNBMK4O4NXLHTPWER`                    |

Confirmed via Horizon `GET /transactions/{hash}`, not just the SDK's
own report.

### C5. Pipeline pass #2 — drain → submit (1 transaction)

`npm run pipeline:once` again. The drain's wallet-link re-check hit a
transient `fetch failed` and left the row queued with no retry (exactly
as designed). Discovery then rediscovered the same candidate; the
wallet was now linked and the PR not yet attested, so
`submitAttestation` sent it.

```
queueDrain: { scanned: 1, submitOutcomes: { rpc-error path: left queued } }
discovery:  { candidates: 1, attestable: 1, submitOutcomes: { submitted: 1 } }
realSubmissionAttempts: 1
submittedTxHashes: [ "0e2a7be567fd8b49567b60293b8b9e520cdf25e181d0bbe246ce604a8324fa65" ]
```

### C6. TRANSACTION #2 — `submit_attestation`

Signed by the attestor only.

| Field                | Value                                                                 |
| -------------------- | --------------------------------------------------------------------- |
| **Transaction hash** | `0e2a7be567fd8b49567b60293b8b9e520cdf25e181d0bbe246ce604a8324fa65`    |
| Horizon `successful` | `true`                                                                |
| Ledger               | `4577318`                                                             |
| Horizon `created_at` | `2026-09-08T23:29:37Z`                                                |
| `source_account`     | `GAVHDK6V2LBGBCBWIZXEHDJAW6ZZKPCKLDANURKJZU4NFDCAV2BYFXEF` (attestor) |
| `operation_count`    | `1`                                                                   |

Confirmed via Horizon `GET /transactions/{hash}`.

### C7. On-chain record (read back after TX #2)

```
get_wallet_for_github(6054b7be…1a51) = GAXZZJW7Y4GYRG32MKSAU3YMHQ4PZRHDVDE53DNLNBMK4O4NXLHTPWER
get_attestation_count(wallet)        = 1
get_reputation_score(wallet)         = 50        (complexity 0 → contract credits +50)

attestation[0] = {
  sequence:        0,
  repo:            "proofowl/backend",
  prNumber:        5,
  issueId:         4,
  complexity:      0,
  prHashHex:       "d07879a0ea96f8f8995a531d4d8792c54b93151b020da468f41bdccf0ff15112",
  githubIdHashHex: "6054b7be2332bad64108b27f181cfc8dfcb15cc0106de5671bd9519c2e071a51",
  timestamp:       1788910177
}
```

The pipeline's queue row was reconciled to `ALREADY_ATTESTED` with the
note `submitted by pipeline: tx 0e2a7be5…`.

### C8. Idempotency — pipeline pass #3 (0 transactions)

`npm run pipeline:once` a third time. The queue is empty; discovery
rediscovers the candidate; `submitAttestation` consults
`isContributionAlreadyAttested` and returns `already-attested` — a
no-op.

```
submit.already_attested — proofowl/backend#5 already credited on-chain; no-op
realSubmissionAttempts: 0
submittedTxHashes: []
```

Running the pipeline again broadcasts nothing.

### Transaction count

| #   | call                 | tx hash                                                            | status                            |
| --- | -------------------- | ------------------------------------------------------------------ | --------------------------------- |
| 1   | `link_github`        | `fea4a80426fa9b568d7d1f198eb0f10ee1847d1cb647ac1c1e7da84151103e30` | SUCCESS (Horizon, ledger 4577301) |
| 2   | `submit_attestation` | `0e2a7be567fd8b49567b60293b8b9e520cdf25e181d0bbe246ce604a8324fa65` | SUCCESS (Horizon, ledger 4577318) |

**Total real testnet transactions: 2** (budget: ≤ 2). Passes #1 and #3
of the pipeline made zero; friendbot funding is the SDF faucet, not a
contract transaction.

---

## Phase D — through the read-only REST API

`npm start` (the real dev server, `dist/server.js`, port 3000), then:

**`GET /health`** — capabilities now advertise the API:

```json
{
  "status": "ok",
  "service": "proofowl-backend",
  "version": "0.0.1",
  "capabilities": {
    "livePolling": false,
    "attestationSubmission": false,
    "frontendRestApi": true,
    "restApiReadOnly": true,
    "onChainReads": true,
    "githubVerification": true
  }
}
```

**`GET /api/reputation/GAXZZJW7Y4GYRG32MKSAU3YMHQ4PZRHDVDE53DNLNBMK4O4NXLHTPWER`**

```json
{
  "wallet": "GAXZZJW7Y4GYRG32MKSAU3YMHQ4PZRHDVDE53DNLNBMK4O4NXLHTPWER",
  "reputationScore": 50,
  "attestationCount": 1
}
```

**`GET /api/attestations/GAXZZJW7Y4GYRG32MKSAU3YMHQ4PZRHDVDE53DNLNBMK4O4NXLHTPWER`**

```json
{
  "wallet": "GAXZZJW7Y4GYRG32MKSAU3YMHQ4PZRHDVDE53DNLNBMK4O4NXLHTPWER",
  "pagination": { "cursor": 0, "limit": 50, "count": 1, "nextCursor": null, "maxPageSize": 50 },
  "attestations": [
    {
      "sequence": 0,
      "repo": "proofowl/backend",
      "prNumber": 5,
      "prHashHex": "d07879a0ea96f8f8995a531d4d8792c54b93151b020da468f41bdccf0ff15112",
      "githubIdHashHex": "6054b7be2332bad64108b27f181cfc8dfcb15cc0106de5671bd9519c2e071a51",
      "issueId": "4",
      "complexity": 0,
      "timestamp": 1788910177
    }
  ]
}
```

**`GET /api/wallet-for-github/6054b7be2332bad64108b27f181cfc8dfcb15cc0106de5671bd9519c2e071a51`**

```json
{
  "githubIdHash": "6054b7be2332bad64108b27f181cfc8dfcb15cc0106de5671bd9519c2e071a51",
  "wallet": "GAXZZJW7Y4GYRG32MKSAU3YMHQ4PZRHDVDE53DNLNBMK4O4NXLHTPWER"
}
```

The API's `attestations[0]` matches the on-chain record from Phase C7
exactly (`issueId` as a string, `timestamp` as a number — bigint-safe).
Server stopped after.

---

## What this establishes, and what it does not

**Establishes**, end to end, against real systems:

1. A real merged GitHub PR is **discovered live** by the pipeline
   (`discover.ts` → GitHub REST + GraphQL), not injected.
2. It is **verified** against real GitHub data — all five gating checks
   pass, and the **self-merge flag is observed `true` in the wild**
   (author == merger) without blocking attestation, exactly as designed.
3. Unlinked → it is **queued**, not submitted (0 transactions).
4. After a real two-party `link_github`, the pipeline **drains the
   queue / re-discovers and submits** one real `submit_attestation`.
5. The attestation is **visible on-chain** (`get_reputation_score` = 50,
   one `Attestation` tagged with the demo `github_id_hash`) and **through
   the read-only REST API** with the identical data.
6. Re-running the pipeline is **idempotent** — a second and third pass
   broadcast nothing.

**Does not establish:** anything about mainnet (never touched), any
security property beyond "the happy path works", or the
`repo_in_approved_orgs` check as _independently verifiable_ — it passed
here via the **operator-asserted allowlist** (`proofowl/backend`
asserted by the maintainer), because Drips publishes no reachable Wave
approved-orgs endpoint. See the README's "Known limitation:
Wave-approval verification".
