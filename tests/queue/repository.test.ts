import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";

import { PendingContributionRepository } from "../../src/queue/repository.js";
import { PENDING_STATUS } from "../../src/queue/status.js";
import { createTestDb, type TestDb } from "./testDb.js";

let db: TestDb;
let repo: PendingContributionRepository;

before(async () => {
  db = await createTestDb();
  repo = new PendingContributionRepository(db.prisma);
});

after(async () => {
  await db.destroy();
});

beforeEach(async () => {
  await db.prisma.pendingContribution.deleteMany();
});

const H = (c: string) => c.repeat(64);

function sampleInput(
  overrides: Partial<Parameters<PendingContributionRepository["enqueue"]>[0]> = {},
) {
  return {
    prHash: H("a"),
    githubIdHash: H("b"),
    githubUserId: "1024025",
    repo: "stellar/soroban-examples",
    prNumber: 42,
    issueId: 7n,
    complexity: 100,
    verification: { attestable: true, checks: [] },
    selfMergeFlagged: false,
    ...overrides,
  };
}

test("enqueue inserts a WAITING row and round-trips every field", async () => {
  const row = await repo.enqueue(sampleInput());
  assert.equal(row.status, PENDING_STATUS.WAITING_FOR_WALLET_LINK);
  assert.equal(row.prHash, H("a"));
  assert.equal(row.githubIdHash, H("b"));
  assert.equal(row.githubUserId, "1024025");
  assert.equal(row.repo, "stellar/soroban-examples");
  assert.equal(row.prNumber, 42);
  assert.equal(row.issueId, 7n);
  assert.equal(row.complexity, 100);
  assert.deepEqual(row.verification, { attestable: true, checks: [] });
  assert.equal(row.attemptCount, 0);

  const fetched = await repo.getByPrHash(H("a"));
  assert.deepEqual(fetched, row);
});

test("enqueue is idempotent on prHash — refreshes, never duplicates", async () => {
  await repo.enqueue(sampleInput({ complexity: 100 }));
  const again = await repo.enqueue(sampleInput({ complexity: 150, verification: { v: 2 } }));
  assert.equal(again.complexity, 150);
  assert.deepEqual(again.verification, { v: 2 });
  assert.equal((await repo.listWaiting()).length, 1);
});

test("listWaiting returns only WAITING rows, oldest first", async () => {
  await repo.enqueue(sampleInput({ prHash: H("1") }));
  await new Promise((r) => setTimeout(r, 5));
  await repo.enqueue(sampleInput({ prHash: H("2") }));
  await repo.enqueue(sampleInput({ prHash: H("3") }));
  await repo.markReadyToSubmit(H("2"));

  const waiting = await repo.listWaiting();
  assert.deepEqual(
    waiting.map((r) => r.prHash),
    [H("1"), H("3")],
  );
});

test("status transitions: ready, already-attested, dismiss", async () => {
  await repo.enqueue(sampleInput({ prHash: H("1") }));
  await repo.enqueue(sampleInput({ prHash: H("2") }));
  await repo.enqueue(sampleInput({ prHash: H("3") }));

  const ready = await repo.markReadyToSubmit(H("1"));
  assert.equal(ready.status, PENDING_STATUS.READY_TO_SUBMIT);
  assert.match(ready.statusNote ?? "", /wallet linked/);

  const attested = await repo.markAlreadyAttested(H("2"), "seen on-chain at seq 4");
  assert.equal(attested.status, PENDING_STATUS.ALREADY_ATTESTED);
  assert.equal(attested.statusNote, "seen on-chain at seq 4");

  const dismissed = await repo.dismiss(H("3"), "PR reverted");
  assert.equal(dismissed.status, PENDING_STATUS.DISMISSED);

  assert.deepEqual(await repo.countByStatus(), {
    WAITING_FOR_WALLET_LINK: 0,
    READY_TO_SUBMIT: 1,
    ALREADY_ATTESTED: 1,
    DISMISSED: 1,
  });
});

test("recordCheckAttempt increments the counter and stamps lastCheckedAt", async () => {
  await repo.enqueue(sampleInput());
  const a = await repo.recordCheckAttempt(H("a"), "still unlinked");
  assert.equal(a.attemptCount, 1);
  assert.ok(a.lastCheckedAt instanceof Date);
  const b = await repo.recordCheckAttempt(H("a"));
  assert.equal(b.attemptCount, 2);
  assert.equal(
    b.status,
    PENDING_STATUS.WAITING_FOR_WALLET_LINK,
    "a re-check does not change status",
  );
});

test("listByGithubIdHash groups a contributor's queued PRs", async () => {
  await repo.enqueue(sampleInput({ prHash: H("1"), githubIdHash: H("b") }));
  await repo.enqueue(sampleInput({ prHash: H("2"), githubIdHash: H("b") }));
  await repo.enqueue(sampleInput({ prHash: H("3"), githubIdHash: H("c") }));
  const forB = await repo.listByGithubIdHash(H("b"));
  assert.deepEqual(forB.map((r) => r.prHash).sort(), [H("1"), H("2")]);
});

test("enqueue rejects malformed input before touching the DB", async () => {
  await assert.rejects(repo.enqueue(sampleInput({ prHash: "short" })), /64 lowercase hex/);
  await assert.rejects(repo.enqueue(sampleInput({ githubIdHash: "ABC" })), /64 lowercase hex/);
  await assert.rejects(repo.enqueue(sampleInput({ githubUserId: "0" })), /positive decimal/);
  await assert.rejects(repo.enqueue(sampleInput({ repo: "NoSlash" })), /<owner>\/<repo>/);
  await assert.rejects(repo.enqueue(sampleInput({ prNumber: 0 })), /u32/);
  await assert.rejects(repo.enqueue(sampleInput({ complexity: 175 })), /0, 100, 150, 200/);
  assert.equal((await repo.listWaiting()).length, 0);
});
