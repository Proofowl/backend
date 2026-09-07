# proofowl-backend

The verification service for **ProofOwl**. It checks GitHub's public API
for merged [Stellar Wave](https://drips.network/wave/stellar)
contributions and — in a later pass — submits them as on-chain
attestations to the already-deployed
[`proofowl-contracts`](https://github.com/Proofowl/proofowl-contracts)
registry.

## What this repo does NOT do yet

This is a **scaffold**, not a running service. In this pass it does not:

- **poll GitHub** on a loop or on a schedule — there is no ingestion
  worker;
- **submit any attestation** — no transaction is signed or sent to any
  contract, on any network; the on-chain integration here is **read-only
  simulation** only;
- **expose a REST API** for the frontend — the Express app serves only
  `/health` and `/ready`;
- **link wallets**, run the OAuth/challenge flow, or hold an attestor
  key — there is no attestor secret anywhere in this repo (see
  [`.env.example`](./.env.example)).

What it _does_ provide: the project structure, the canonical hashing
module, the GitHub verification logic, read-only on-chain integration via
the contracts SDK, a one-table local queue, tests, and CI.

## How it fits together

```
 GitHub public API ──► proofowl-backend ──► proofowl-contracts registry (Soroban)
 (PRs, issues,          - canonical hashing    - wallet ↔ github_id_hash links
  timeline, closing     - 5 verification checks - one attestation per merged PR
  issue links)          - self-merge flag       - reputation score
                        - on-chain READS        (this repo never writes to it yet)
                        - queue of verified-
                          but-unlinked contribs
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

| Path           | What it is                                                                                                                                                                                                |
| -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/hashing/` | `github_id_hash` / `pr_hash` per `identifier-spec-v1` — an independent implementation, cross-checked against the contracts SDK and the spec's published vectors.                                          |
| `src/github/`  | `verifyContribution(candidate)` → five independently-inspectable checks + a self-merge flag. `GitHubClient` / `ApprovedOrgsSource` / `ApprovedOrgsAllowlistSource` are interfaces (fixtures in tests).    |
| `src/chain/`   | `createChainReadClient(config)` — read-only simulations against the registry via `@proofowl/contract-sdk`. Identity↔wallet lookups, reputation, paged attestation history, an "already attested?" helper. |
| `src/queue/`   | `PendingContributionRepository` — the one persisted thing: contributions that passed verification but whose wallet is not linked on-chain yet.                                                            |
| `src/app.ts`   | Express app: `/health`, `/ready`. No domain routes.                                                                                                                                                       |

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
npm run dev                            # starts the /health server (no polling)
```

### Scripts

| script                     | does                                                                  |
| -------------------------- | --------------------------------------------------------------------- |
| `npm run check`            | the full local gate (format, lint, typecheck, unit tests)             |
| `npm test`                 | compile `tsconfig.test.json` → `node --test`                          |
| `npm run test:integration` | `PROOFOWL_INTEGRATION=1 npm test` — adds real read-only testnet reads |
| `npm run build`            | `tsc` → `dist/`                                                       |
| `npm run dev`              | `tsx watch src/server.ts`                                             |

The `*.integration.test.ts` files are **skipped** unless
`PROOFOWL_INTEGRATION=1`.

## License

MIT — see [LICENSE](./LICENSE), matching `proofowl-contracts`.
