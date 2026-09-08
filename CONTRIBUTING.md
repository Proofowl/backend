# Contributing to proofowl-backend

This is the verification service for ProofOwl. It reads GitHub and the
deployed `proofowl-contracts` registry; it does not yet write anything
on-chain (see the README's "What this repo does NOT do yet").

## Prerequisites

- **Node ≥ 22.6** with **npm**. CI uses Node 24 (last verified with Node
  24.20.0 / npm 11.19.0).
- A local checkout of
  [`proofowl-contracts`](https://github.com/Proofowl/proofowl-contracts)
  as a **sibling directory** (`../proofowl-contracts`). The contract SDK
  is a `file:` dependency; build it once with
  `( cd ../proofowl-contracts/sdk/typescript && npm ci && npm run build )`.

## Setup

```bash
npm install                 # runs `prisma generate` via postinstall
cp .env.example .env
npx prisma migrate deploy    # creates prisma/dev.db
npm run check                # baseline must pass before you start
```

## Workflow

1. Branch off `main`.
2. `npm run check` before you touch anything, so you know the baseline
   passes. It runs `prettier --check` → `eslint` → `tsc --noEmit` →
   `node --test` — the same steps CI runs.
3. Make your change. Every module here has a matching `tests/<module>/`
   directory; add a passing-path test and a failing-path test for new
   behaviour.
   - **Hashing** changes must keep matching `identifier-spec-v1` and the
     contracts SDK — `tests/hashing/` cross-checks both. Do not invent a
     new hashing scheme; a spec change is a new spec version in
     `proofowl-contracts`.
   - **Verification** changes: keep each check independently inspectable
     (`{ status, detail, evidence }`), and keep `indeterminate` distinct
     from `fail`. Drive new branches from fixtures in
     `tests/github/fixtures.ts`, not live PRs. For `repo_in_approved_orgs`:
     the live Wave source is always tried first and must not be weakened;
     the allowlist fallback (`config/approved-orgs-allowlist.json`) only
     ever produces `pass` (repo asserted) or `indeterminate` (repo not
     asserted yet) — never `fail`, since it is an incomplete positive
     list, not a denylist — and its outcome must carry a `confidence`
     marker and, for a `pass`, the entry's provenance in the returned
     `evidence`, never only in a log or comment. See README "Known
     limitation: Wave-approval verification".
   - **On-chain** changes: reads are plain simulations. The one
     state-changing path is `submitAttestation` (`src/chain/submit.ts`) —
     it is **testnet-only** (refused on any other network), simulates
     before it can send, and short-circuits on the not-linked /
     already-attested pre-conditions. Do not add a second signing path,
     a mainnet code path, or a scheduler that calls it. The live
     integration tests (`tests/chain/testnet.integration.test.ts`,
     `tests/chain/submitAttestation.integration.test.ts`) are opt-in via
     `PROOFOWL_INTEGRATION=1`; the submit one also needs
     `ATTESTOR_SECRET_KEY`.
   - **Schema** changes: edit `prisma/schema.prisma`, run
     `npx prisma migrate dev --name <change>`, and commit the generated
     migration under `prisma/migrations/`.
4. Keep commits to one logical unit each, with a Conventional-Commits
   subject (`feat:`, `fix:`, `test:`, `docs:`, `chore:`, `ci:`) —
   matching `proofowl-contracts`' convention.

## Style

ESLint + Prettier are configured to match `proofowl-contracts`'
`sdk/typescript` (Prettier `printWidth: 100`, `trailingComma: "all"`, no
single quotes; flat ESLint config). `npm run format` fixes formatting.

## What not to commit

- No real secrets. `ATTESTOR_SECRET_KEY` is now read by the testnet
  submitter (`src/chain/attestationSubmitter.ts`) and the submit
  integration test, but only from a local git-ignored `.env` — keep the
  placeholder in `.env.example` deliberately invalid, and never let the
  value reach a log or a committed file.
- No `.env`, no `*.db` files, no generated Prisma client (all
  `.gitignore`d).
- No AI/assistant attribution or co-author trailers in commit messages.

## Not in scope here

Live polling, attestation submission, the wallet-linking/OAuth flow, and
the frontend-facing REST API are all follow-up work. PRs adding them
belong on top of this scaffold, not folded into it.
