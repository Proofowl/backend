import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  FileApprovedOrgsAllowlistSource,
  StaticApprovedOrgsAllowlistSource,
} from "../../src/github/approvedOrgsAllowlistSource.js";

const ENTRY = {
  repo: "proofowl/proofowl-backend",
  assertedBy: "maintainer",
  assertedAt: "2026-09-07",
  evidenceUrl: "https://github.com/Proofowl",
};

function reader(text: string): (p: string) => Promise<string> {
  return async () => text;
}
function throwingReader(err: NodeJS.ErrnoException): (p: string) => Promise<string> {
  return async () => {
    throw err;
  };
}

test("load() returns null when the file is absent (ENOENT) — 'not configured'", async () => {
  const enoent = Object.assign(new Error("no such file"), { code: "ENOENT" });
  const src = new FileApprovedOrgsAllowlistSource({
    path: "does-not-exist.json",
    readFileImpl: throwingReader(enoent),
  });
  assert.equal(await src.load(), null);
});

test("load() parses a valid file and exposes find()", async () => {
  const src = new FileApprovedOrgsAllowlistSource({
    path: "any.json",
    readFileImpl: reader(JSON.stringify({ entries: [ENTRY] })),
  });
  const list = await src.load();
  assert.ok(list);
  assert.equal(list.entries.length, 1);
  assert.ok(list.find("proofowl/proofowl-backend"));
});

test("load() throws on present-but-invalid JSON (loud, not a silent null)", async () => {
  const src = new FileApprovedOrgsAllowlistSource({
    path: "bad.json",
    readFileImpl: reader("{ not json"),
  });
  await assert.rejects(src.load(), /is not valid JSON/);
});

test("load() throws on a structurally-valid file with a bad entry", async () => {
  const src = new FileApprovedOrgsAllowlistSource({
    path: "bad-entry.json",
    readFileImpl: reader(JSON.stringify({ entries: [{ repo: "proofowl/x" }] })),
  });
  await assert.rejects(src.load(), /"assertedBy" must be a non-empty/);
});

test("load() surfaces a non-ENOENT read error as ValidationError, not null", async () => {
  const eacces = Object.assign(new Error("permission denied"), { code: "EACCES" });
  const src = new FileApprovedOrgsAllowlistSource({
    path: "locked.json",
    readFileImpl: throwingReader(eacces),
  });
  await assert.rejects(src.load(), /could not read approved-orgs allowlist/);
});

test("load() caches by default (reader hit once)", async () => {
  let hits = 0;
  const src = new FileApprovedOrgsAllowlistSource({
    path: "any.json",
    readFileImpl: async () => {
      hits++;
      return JSON.stringify([ENTRY]);
    },
  });
  await src.load();
  await src.load();
  assert.equal(hits, 1);
});

test("works against the real filesystem (temp file round-trip)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "proofowl-allowlist-"));
  try {
    const path = join(dir, "allowlist.json");
    writeFileSync(path, JSON.stringify({ entries: [ENTRY] }));
    const src = new FileApprovedOrgsAllowlistSource({ path });
    const list = await src.load();
    assert.ok(list?.find("proofowl/proofowl-backend"));
    assert.equal(list?.source, path);

    // and a genuinely missing path -> null
    const missing = new FileApprovedOrgsAllowlistSource({ path: join(dir, "nope.json") });
    assert.equal(await missing.load(), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("StaticApprovedOrgsAllowlistSource just returns its value", async () => {
  assert.equal(await new StaticApprovedOrgsAllowlistSource(null).load(), null);
  const list = { entries: [], source: "mem", find: () => undefined };
  assert.equal(await new StaticApprovedOrgsAllowlistSource(list).load(), list);
});
