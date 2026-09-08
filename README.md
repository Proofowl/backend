# proofowl-backend

The verification service for **ProofOwl**. It checks GitHub's public API
for merged [Stellar Wave](https://drips.network/wave/stellar)
contributions and submits them as on-chain attestations to the
already-deployed
[`proofowl-contracts`](https://github.com/Proofowl/proofowl-contracts)
registry. The submission call and its safeguards exist now
([below](#submitting-attestations)), and the automation pipeline that
drives discovery → verification → submission/queue → retry exists now
too ([below](#the-automation-pipeline)) — but it runs **only** when an
operator invokes `npm run pipeline:once` / `pipeline:loop`. It is never
wired into the HTTP server.

## What this repo does NOT do yet

This is still closer to a **scaffold** than a hosted service. It does
not:

- **poll GitHub automatically** — the pipeline
  (`src/pipeline/`, [below](#the-automation-pipeline)) does discovery →
  verify → submit/queue → retry in one pass, and `pipeline:loop` will
  repeat it on an interval, but there is no always-on worker: a human
  starts it, and it is **not** started by `npm start` / `npm run dev`;
- **submit attestations from the HTTP server** — `submitAttestation`
  (`src/chain/submit.ts`) and the pipeline that calls it are
  **testnet-only** and refuse any other network. A submission happens
  only inside an explicit `pipeline:once` / `pipeline:loop` run (or the
  opt-in integration tests);
- **expose any _write_ HTTP API** — the Express app serves `/health`,
  `/ready`, and a **read-only** `/api` ([below](#read-only-rest-api))
  that only reads on-chain state and local queue counts. No route
  submits an attestation, signs anything, or writes to the queue;
- **run the wallet-linking OAuth/challenge flow** — the submit path
  assumes the contributor's wallet is already linked on-chain and
  short-circuits to "needs queueing" when it is not. The attestor secret
  is read from `ATTESTOR_SECRET_KEY` in the environment at submit time;
  it is never committed — [`.env.example`](./.env.example) ships a fake
  placeholder.

What it _does_ provide: the project structure, the canonical hashing
module, the GitHub verification logic, on-chain reads via the contracts
SDK, the testnet attestation-submission call with its safeguards, a
one-table local queue, the automation pipeline that ties them together
behind an explicit command, tests, and CI.

## How it fits together

```
 GitHub public API ──► proofowl-backend ──► proofowl-contracts registry (Soroban)
 (PRs, issues,          - canonical hashing    - wallet ↔ github_id_hash links
  timeline, closing     - 5 verification checks - one attestation per merged PR
  issue links)          - self-merge flag       - reputation score
                        - on-chain READS
                        - submit_attestation    (testnet only)
                        - queue of verified-
                          but-unlinked contribs
                        - automation pipeline   (explicit command only)
                                │
                        proofowl-frontend (not started) — will read the
                        registry for passports/leaderboards and drive the
                        wallet-linking flow.
```

The contract, its ABI, the canonical identifier spec, and the deployed
testnet instance all live in `proofowl-contracts`. This service treats
that repo's `sdk/typescript` package as a dependency and its
`docs/integration/*` as normative.

## Modules

| Path            | What it is                                                                                                                                                                                                                                                                                                                                                 |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/hashing/`  | `github_id_hash` / `pr_hash` per `identifier-spec-v1` — an independent implementation, cross-checked against the contracts SDK and the spec's published vectors.                                                                                                                                                                                           |
| `src/github/`   | `verifyContribution(candidate)` → five independently-inspectable checks + a self-merge flag. `GitHubClient` / `ApprovedOrgsSource` / `ApprovedOrgsAllowlistSource` are interfaces (fixtures in tests).                                                                                                                                                     |
| `src/chain/`    | `createChainReadClient(config)` — read-only simulations against the registry via `@proofowl/contract-sdk`. Identity↔wallet lookups, reputation, paged attestation history, an "already attested?" helper. Plus `submitAttestation(...)` ([below](#submitting-attestations)) — the one mutating call: testnet-only, dry-run-first, two hard pre-conditions. |
| `src/queue/`    | `PendingContributionRepository` — the one persisted thing: contributions that passed verification but whose wallet is not linked on-chain yet.                                                                                                                                                                                                             |
| `src/pipeline/` | `runOnce()` — one idempotent pass of discover → verify → submit/queue → retry; `createScheduler()` — runs it on an interval with overlap prevention; `main.ts` — the `pipeline:once` / `pipeline:loop` entrypoints. Never imported by `src/app.ts`. [Below](#the-automation-pipeline).                                                                     |
| `src/app.ts`    | Express app: `/health`, `/ready`, and (when wired with deps) the read-only `/api` router from `src/api/`.                                                                                                                                                                                                                                                  |
| `src/api/`      | The read-only REST API — `createApiRouter(deps)` mounts `GET /api/reputation`, `/api/attestations`, `/api/wallet-for-github`, `/api/queue/status` behind a response cache + per-IP rate limiter. Reads only; never imports a signer or the pipeline. [Below](#read-only-rest-api).                                                                         |

### The five verification checks

`verifyContribution` returns each of these as its own `{ status, detail,
evidence }` — never a single opaque boolean. `status` is `pass`, `fail`,
or `indeterminate` (upstream unavailable / ambiguous).

| id                             | checks                                                                                                     |
| ------------------------------ | ---------------------------------------------------------------------------------------------------------- |
| `repo_in_approved_orgs`        | live Wave list first, then an operator-asserted allowlist fallback — see "Known limitation" below          |
| `issue_has_wave_label`         | the resolved issue carries the Wave label                                                                  |
| `wave_label_predates_pr_merge` | the Wave label's applied-at timestamp is before the PR's merge timestamp                                   |
| `pr_closes_issue`              | the PR is linked to the issue via GitHub's own closing-issue mechanism (GraphQL `closingIssuesReferences`) |
| `pr_is_merged`                 | `pull_request.merged === true`, not merely `closed`                                                        |

Plus `flags.selfMerge` — whether the PR's author and the account that
merged it are the same. This is a **flag, not a check**: the caller
decides policy (reject vs. attest-and-mark). `attestable` is true iff
every gating check is `pass`; the flag does not affect it.

### Known limitation: Wave-approval verification

`repo_in_approved_orgs` is the one check that **cannot be fully
automated today**, and its "pass" is **not independently verifiable**
the way the rest of this project is designed to be. Read this before
relying on it.

**Why.** Drips' Wave approved-orgs list lives at
`drips.network/wave/stellar/orgs`, which is a client-rendered
application, not a public API. Its data endpoint
(`/wave/stellar/orgs/__data.json`) returns nothing without a
`waveAccessToken`. There is no reachable public data source for this
list. This is not something this repo can fix — it needs Drips to
publish an endpoint.

**Live source, tried first, unchanged.** `HttpApprovedOrgsSource` still
fetches `WAVE_APPROVED_ORGS_URL` on every check and parses whatever it
gets (JSON shapes or `github.com/<org>` slugs in HTML). If Drips ever
ships a JSON endpoint, point `WAVE_APPROVED_ORGS_URL` at it and this
check becomes genuinely automated with no further change. Until then the
live source can only return `indeterminate`.

**Fallback: an operator-asserted allowlist.** When the live source is
unavailable, the check consults a manual list an operator curates:
`config/approved-orgs-allowlist.json` (path overridable via
`APPROVED_ORGS_ALLOWLIST_PATH`). Each entry carries `repo`
(`owner/name`), `assertedBy`, `assertedAt` (ISO date), and `evidenceUrl`
— a link to whatever justified it (a Wave issue page, a maintainer
dashboard, …). A bare list of repo names with no provenance is
rejected.

**What a manual "pass" does and does not mean:**

- It **does** mean: a specific, named person (`assertedBy`) asserted on
  a specific date (`assertedAt`) that this repo is Wave-approved, and
  left a link (`evidenceUrl`) to their basis.
- It **does not** mean: a third party can re-derive that from public
  data. A live-sourced pass is checkable by anyone; a manual pass is
  only as good as the operator's word plus whatever their `evidenceUrl`
  shows. It is a weaker claim than the on-chain attestations this
  project exists to produce, which are designed to be independently
  verifiable.
- It is **marked as such in the returned data**, not just here: the
  check's `confidence` field is `"manually-asserted-allowlist"` and
  `evidence.assertion` carries the `assertedBy` / `assertedAt` /
  `evidenceUrl` inline. Any downstream code that treats a `pass` as
  third-party-verifiable must inspect `confidence`.

**The four outcomes:**

| live Wave source    | allowlist                | result                                                                                                                                    |
| ------------------- | ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------- |
| returns a real list | (ignored)                | `pass` / `fail` from the live list, no `confidence` marker — as today                                                                     |
| unavailable         | repo present             | `pass`, `confidence: "manually-asserted-allowlist"`, provenance inline                                                                    |
| unavailable         | repo absent              | `indeterminate`, `confidence: "operator-allowlist-absent"` — not yet reviewed, not rejected (an incomplete positive list, not a denylist) |
| unavailable         | not configured (no file) | `indeterminate`, no `confidence` marker — unchanged from before the fallback existed                                                      |

The last two rows are both `indeterminate`; the `confidence` marker is
what tells "on a curated list that hasn't reached this repo yet" apart
from "no curated list exists at all". Neither is a rejection — this
check never returns `fail` from the allowlist path.

**Default behaviour.** The committed seed file asserts exactly two
repos: `proofowl/proofowl-contracts` and `proofowl/proofowl-backend`
(asserted by this project's maintainer, `evidenceUrl` → the real
`github.com/Proofowl` org). So out of the box, while Drips is
unreachable, `repo_in_approved_orgs` is `pass` only for those two;
every other repo is `indeterminate` (marked `operator-allowlist-absent`)
— not yet reviewed, not rejected. An operator extends the file as they
verify more repos; deleting it (or pointing `APPROVED_ORGS_ALLOWLIST_PATH`
at a non-existent path) drops the marker but leaves the outcome
`indeterminate` on live failure either way.

### On-chain reads

Targets the **v0.3 (crate `0.3.0`)** testnet instance
`CAIDTSVPQICTA2VLE6BSQYHEELHGPZWQDYWKSDBRW4LYPZH6Q44UTAOA` by default
(from `proofowl-contracts`' README "Deployed contracts" table).

Scalar reads (`get_admin`, `get_attestor`, `get_attestation_count`,
`get_reputation_score`, `get_wallet_for_github`, `get_github_for_wallet`)
go straight through `@proofowl/contract-sdk`'s `createReadClient`. The
`Attestation`-struct reads go through `src/chain/attestationDecode.ts`, a
**documented shim**: the pinned `@stellar/stellar-sdk` (16.x) throws
`ScSpecType scSpecTypeU64 was not string or symbol` when decoding that
struct from the live v0.3 contract, so the SDK's generated client still
does the RPC round-trip and the shim only replaces the final
ScVal→JS step with the generic `scValToNative`. Remove it once the SDK
bumps `@stellar/stellar-sdk`.

### Read-only REST API

`src/api/` — a thin HTTP surface over what already exists on-chain and
in the local queue. **It has no write capability at all**: no route
submits an attestation, calls a signer, touches `ATTESTOR_SECRET_KEY`,
or writes to the queue (the `ApiDeps` type is `Pick<>`-narrowed so this
is enforced at compile time, not just by convention). It is mounted by
`buildApp({ apiDeps: createApiDeps(config) })`, which `npm start` /
`npm run dev` do — and `createApiDeps` only _constructs_ the read client
and queue handle, so the server still makes no RPC or DB call on boot.

Every uncached request runs one Soroban RPC _simulation_ (or, for
`/queue/status`, four local `COUNT`s). Order per request: **response
cache → per-IP rate limiter → route**. Base path `/api`.

#### Endpoints

| Method & path                                  | Success body                                                                                                                                                                                                                                                                                                      |
| ---------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /api/reputation/:wallet`                  | `{ "wallet": "G…", "reputationScore": 250, "attestationCount": 2 }`                                                                                                                                                                                                                                               |
| `GET /api/attestations/:wallet?cursor=&limit=` | `{ "wallet": "G…", "pagination": { "cursor": 0, "limit": 50, "count": 2, "nextCursor": null, "maxPageSize": 50 }, "attestations": [ { "sequence": 0, "repo": "owner/name", "prNumber": 7, "prHashHex": "…64hex…", "githubIdHashHex": "…64hex…", "issueId": "1", "complexity": 150, "timestamp": 1788784892 } ] }` |
| `GET /api/wallet-for-github/:githubIdHash`     | `{ "githubIdHash": "…64hex…", "wallet": "G…" \| null }`                                                                                                                                                                                                                                                           |
| `GET /api/queue/status`                        | `{ "counts": { "WAITING_FOR_WALLET_LINK": 4, "READY_TO_SUBMIT": 1, "ALREADY_ATTESTED": 3, "DISMISSED": 0 }, "total": 8 }`                                                                                                                                                                                         |

Notes:

- **`:wallet`** must be a Stellar public key (`G` + 55 base32 chars);
  **`:githubIdHash`** must be 64 hex chars (either case, echoed
  lowercased). A malformed one is a **400 before any RPC**.
- A syntactically valid wallet / hash that has **never appeared
  on-chain is not an error** — you get `reputationScore: 0`,
  `attestationCount: 0`, an empty `attestations` list, or
  `wallet: null`. Only malformed input is a 400; there is no 404 for
  "unseen".
- **`?limit`** defaults to and is capped at `MAX_PAGE_SIZE = 50` — the
  contract's own page size (`contract-api-v2.md`). **`?cursor`** is the
  zero-based start index. `nextCursor` is `cursor + count` on a full
  page, `null` on a short one (the end).
- `issueId` is a **decimal string** (a u64 can exceed
  `Number.MAX_SAFE_INTEGER`); `timestamp` is a **number** (Unix
  seconds).
- `/api/queue/status` returns **aggregate counts only** — no per-item
  listing. That endpoint is a deliberate follow-up (it needs its own
  pagination / filters / per-row projection).
- Repeated identical GETs within **3 s** are served from an in-process
  cache (`x-proofowl-cache: hit|miss`) and do not re-hit the RPC or
  spend rate-limit budget.

#### Error responses

| Status | Body                                                          | When                                                                                                                             |
| ------ | ------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `400`  | `{ "error": "<what's wrong with the input>" }`                | malformed `:wallet` / `:githubIdHash` / `?cursor` / `?limit`                                                                     |
| `404`  | `{ "error": "not found" }`                                    | unknown path under `/api`                                                                                                        |
| `429`  | `{ "error": "rate limit exceeded", "retryAfterSeconds": 60 }` | more than the limit below, per IP, per window                                                                                    |
| `500`  | `{ "error": "internal error" }`                               | any RPC / DB / unexpected failure — **the real error, its message and stack, is written to the server log only, never the body** |

#### Rate limiting

**60 requests per IP per 60 s** (≈ 1 req/s) on `/api/*`
(`express-rate-limit`, `RateLimit` draft-7 headers, legacy
`X-RateLimit-*` suppressed). Sized for a read-only **testnet demo**: a
human browsing a passport UI or a frontend polling one wallet stays far
under it, the 3 s cache absorbs bursts, and a scraper is capped near
what the public SDF testnet RPC tolerates from one client. It is **not**
production sizing — a real deployment would rate-limit at the edge and
issue per-key quotas. No reverse proxy is assumed; the key is the socket
IP. Defaults are overridable per router (`createApiRouter(deps, {
rateLimit, cache })`).

### Submitting attestations

`submitAttestation(input, deps)` (`src/chain/submit.ts`) turns one
verified, **attestable** contribution into a real `submit_attestation`
call on the v0.3 registry — the only state-changing path in this repo,
and it is **not reachable from the HTTP layer**.
It assembles no transaction by hand: it drives `@proofowl/contract-sdk`'s
`prepareSubmitAttestation` through an injected `AttestationSubmitter`
(`createSdkAttestationSubmitter`, which signs with `ATTESTOR_SECRET_KEY`).

**Safeguards — enforced, not just documented:**

- **Testnet only.** `createSdkAttestationSubmitter` refuses to construct
  unless the config's network passphrase is the Stellar testnet one —
  mainnet is refused by name, anything else as "unconfirmed".
  `submitAttestation` re-checks before any I/O.
- **Dry-run first, always.** Every call is simulated before it can be
  sent; a contract rejection is classified from that simulation, before
  any signature or fee. `dryRun: true` stops there.
- **Two hard pre-conditions, re-read live on every call:**
  - _not-linked_ — `get_wallet_for_github` returns `null` ⇒ the identity
    has no wallet to credit ⇒ result `not-submittable`
    (`reason: "wallet-not-linked"`). That is the queue's job, not an
    error.
  - _already-attested_ — `isContributionAlreadyAttested` reports the PR
    is already credited ⇒ result `already-attested` and **no transaction
    is assembled**. It is never "submitted anyway to be sure".
- **The attestor secret is never logged** — not in a result, an error,
  or a log line. A malformed key yields a fixed message that does not
  contain the value. It is also kept off the shared `AppConfig` object
  (only the boolean `attestorSecretKeyIsSet` is exposed).
- **No loop.** This is the submission function and its safeguards only.
  The scheduler that calls it is a separate, later task.

**Result — exactly one of (`SubmitAttestationResult.kind`):**

| kind                | meaning                                                                                                                                                                                               |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `submitted`         | recorded on-chain; carries `txHash`, `ledger`, `creditedWallet`                                                                                                                                       |
| `dry-run-ok`        | `dryRun: true` and the simulation was clean; nothing was sent                                                                                                                                         |
| `already-attested`  | pre-condition hit; the matching on-chain record is returned, no tx assembled                                                                                                                          |
| `not-submittable`   | identity not linked to a wallet — enqueue and retry once it is                                                                                                                                        |
| `not-attestable`    | the verification result handed in was not `attestable` (defensive guard)                                                                                                                              |
| `contract-rejected` | the contract rejected the **simulation**; `errorName` / `errorCode` distinguish `WalletNotLinked`, `DuplicateAttestation`, `InvalidComplexity`, … — no signature spent                                |
| `submission-failed` | signed and sent, then failed: `stage: "send"` (rejected at submission — bad sequence number, insufficient fee) or `stage: "confirm"` (failed, or unconfirmed within the wait window, after inclusion) |
| `rpc-error`         | transport failure — no verdict from the contract, safe to retry; `during` says where it happened                                                                                                      |

`deps.onSubmissionAttempt` fires exactly once immediately before every
real (non-dry-run) send, successful or not — the hook a caller uses to
count submissions against a budget.

The offline unit tests (`tests/chain/submit.test.ts`) cover every `kind`
against fakes for both boundaries. One opt-in integration test
(`tests/chain/submitAttestation.integration.test.ts`, gated on
`PROOFOWL_INTEGRATION=1` **and** `ATTESTOR_SECRET_KEY`) exercises the
whole path once against the live v0.3 testnet instance: link → dry-run →
submit → read-back → duplicate refusal.

### Transaction budget (historical note)

The task that built this module operated under a hard cap of **3 real
testnet transactions total**, across all development and the demo, and
used **2**: one `link_github` and one `submit_attestation` in the
integration test. The duplicate-refusal check consumed none — it is
rejected before a transaction is assembled. The later end-to-end demo
([below](#end-to-end-demo)) made **2 more** (again 1 `link_github` +
1 `submit_attestation`), for **4** real testnet transactions across the
project's whole history. These caps were a development-time discipline
(treating "how many times did this write" as worth counting even where
nothing is at stake). They are **not** a permanent runtime rule: the
scheduling loop ([below](#the-automation-pipeline)) submits as often as
there are verified, linked, un-attested contributions.

## The automation pipeline

`src/pipeline/` ties the modules above into an unattended loop:
**discover → verify → submit / queue → retry**. It is a library plus two
explicit entrypoints — it is **never** imported by `src/app.ts` and
never runs as a side effect of `npm start` / `npm run dev`. A pass
happens only when an operator runs one of:

```bash
npm run pipeline:once   # one pass, print the JSON summary, exit
npm run pipeline:loop   # a pass now, then one every PIPELINE_POLL_INTERVAL_MS
```

Both need `ATTESTOR_SECRET_KEY` set (the pipeline signs `submit_attestation`
with it); a missing or malformed key stops the process before any
network use, without echoing the value. Both refuse a non-testnet
`PROOFOWL_NETWORK_PASSPHRASE`.

### One pass — `runOnce()`

1. **Drain the queue first.** For every `WAITING_FOR_WALLET_LINK` row
   (up to `PIPELINE_MAX_QUEUE_DRAIN`), re-read `get_wallet_for_github`.
   Still unlinked → leave it queued, record the re-check. Now linked →
   hand it to `submitAttestation` for a real submission.
2. **Discover.** For each repo on the approved-orgs allowlist
   (`src/pipeline/seed.ts` — the same curated list
   `repo_in_approved_orgs` falls back to), find closed Wave issues with a
   linked, merged PR (`src/pipeline/discover.ts`), bounded by
   `PIPELINE_MAX_ISSUES_PER_REPO`. Discovery only produces candidates; it
   does not re-derive the gating checks.
3. **Verify + route.** Run `verifyContribution` on each candidate.
   - not attestable / indeterminate → log and skip, **never queue**;
   - attestable → `submitAttestation`, then route on the result `kind`:
     `submitted` → log success (+ clear any stale queue row);
     `already-attested` → no-op; `not-submittable` (wallet not linked) →
     enqueue, **after** checking for an existing row so nothing is
     duplicated and an operator-`DISMISSED` row is never revived;
     `not-attestable` → skip; `contract-rejected` / `submission-failed` /
     `rpc-error` → log distinctly, **no automatic retry within the pass**
     (the next pass picks it up).
4. **Return a summary** — counts keyed by every `submit_attestation`
   outcome kind, for both the drain and the discovery phase, plus
   `realSubmissionAttempts` and the `submittedTxHashes`.

The pass is **idempotent**: `enqueue` upserts on `pr_hash`,
`submitAttestation` short-circuits an already-credited PR before
assembling anything, and a row that was just submitted is no longer
`WAITING`. Running it twice back-to-back broadcasts nothing the first
run already did.

### The loop — `createScheduler()`

`pipeline:loop` runs a pass immediately, then every
`PIPELINE_POLL_INTERVAL_MS` (default **600000** = 10 min; floor 60000,
rejected loudly below it). **Overlap prevention:** a pass can outlast
the interval; a tick that fires while the previous pass is still running
is **skipped** — passes never stack or run concurrently. `SIGINT` /
`SIGTERM` stop the scheduler and disconnect Prisma; a pass already in
flight finishes.

### Config

| env var                        | default  | meaning                                                    |
| ------------------------------ | -------- | ---------------------------------------------------------- |
| `PIPELINE_POLL_INTERVAL_MS`    | `600000` | `pipeline:loop` interval; floor `60000`                    |
| `PIPELINE_MAX_ISSUES_PER_REPO` | `100`    | issues fetched per seed repo per discovery pass            |
| `PIPELINE_MAX_QUEUE_DRAIN`     | `100`    | queued rows re-checked per pass                            |
| `PIPELINE_DRY_RUN`             | `false`  | simulate every submission, never sign/send; still enqueues |
| `WAVE_LABEL_NAMES`             | _unset_  | exact Wave label names (matcher + discovery prefilter)     |

### Tests

Offline unit tests (`tests/pipeline/runOnce.test.ts`,
`tests/pipeline/schedule.test.ts`) cover the drain-first ordering, the
routing for every outcome kind, the duplicate-queue guard, idempotency,
dry-run, and scheduler overlap prevention — all against fakes, no
network or key. One opt-in integration test
(`tests/pipeline/runOnce.integration.test.ts`, gated on
`PROOFOWL_INTEGRATION=1` **and** `ATTESTOR_SECRET_KEY`) exercises the
whole thing once against the live v0.3 testnet: pass #1 enqueues an
unlinked synthetic contribution (0 tx), a real `link_github` follows
(1 tx), pass #2 drains the queue and submits it (1 tx), the record is
read back on-chain, and a pass #3 confirms everything is now
`already-attested` (0 tx) — **2 real transactions total.**

## End-to-end demo

[`docs/testnet/e2e-demo.md`](./docs/testnet/e2e-demo.md) is a stand-alone
record of the full chain run once against real systems: a real merged
GitHub PR ([`Proofowl/backend#5`](https://github.com/Proofowl/backend/pull/5),
closing [`#4`](https://github.com/Proofowl/backend/issues/4))
**discovered live** by the pipeline, verified against real GitHub data
(all five gating checks pass; the self-merge flag is observed `true` in
the wild without blocking), queued while unlinked (0 tx), then — after a
real two-party `link_github` (tx `fea4a804…`) — submitted by the
pipeline as one real `submit_attestation` (tx `0e2a7be5…`), visible
on-chain (`reputationScore` 50, one tagged `Attestation`) and through
the read-only `/api` with identical data. Re-running the pipeline is
idempotent. Both transactions are Horizon-confirmed in that document.

## Setup

Prerequisites: **Node ≥ 22.6** + npm (CI uses Node 24), and a local
checkout of `proofowl-contracts` as a **sibling directory**
(`../proofowl-contracts`) — the contract SDK is consumed as a
`file:` dependency.

```bash
# from a directory containing both repos
git clone <proofowl-contracts>        # if you don't have it
git clone <proofowl-backend> && cd proofowl-backend

# build the sibling SDK once
( cd ../proofowl-contracts/sdk/typescript && npm ci && npm run build )

npm install                            # runs `prisma generate`
cp .env.example .env
npx prisma migrate deploy              # creates prisma/dev.db

npm run check                          # format:check + lint + typecheck + test
npm run dev                            # /health + /ready + read-only /api (no polling, no scheduler)
```

### Scripts

| script                     | does                                                                                                                                                |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm run check`            | the full local gate (format, lint, typecheck, unit tests)                                                                                           |
| `npm test`                 | compile `tsconfig.test.json` → `node --test`                                                                                                        |
| `npm run test:integration` | `PROOFOWL_INTEGRATION=1 npm test` — adds the live testnet tests (`submitAttestation` + `runOnce` submit 2 real tx **each**; the rest are read-only) |
| `npm run build`            | `tsc` → `dist/`                                                                                                                                     |
| `npm run dev`              | `tsx watch src/server.ts` — /health + /ready + read-only /api; no pipeline / scheduler                                                              |
| `npm run pipeline:once`    | one pipeline pass, print the JSON summary, exit                                                                                                     |
| `npm run pipeline:loop`    | run a pass now, then one every `PIPELINE_POLL_INTERVAL_MS`                                                                                          |

The `*.integration.test.ts` files are **skipped** unless
`PROOFOWL_INTEGRATION=1` (and, for the two that submit, unless
`ATTESTOR_SECRET_KEY` is set).

## License

MIT — see [LICENSE](./LICENSE), matching `proofowl-contracts`.
