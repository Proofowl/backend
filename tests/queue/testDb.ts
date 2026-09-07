/**
 * Spin up a throwaway SQLite database for a test file: a fresh file in
 * the OS temp dir with the committed migrations applied. No Docker, no
 * external service.
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { PrismaClient } from "@prisma/client";

/** Walk up from this file until we find prisma/schema.prisma. */
function findRepoRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 10; i++) {
    if (existsSync(join(dir, "prisma", "schema.prisma"))) return dir;
    dir = dirname(dir);
  }
  throw new Error("could not locate repo root (prisma/schema.prisma) from " + import.meta.url);
}

const REPO_ROOT = findRepoRoot();
const SCHEMA_PATH = join(REPO_ROOT, "prisma", "schema.prisma");

export interface TestDb {
  prisma: PrismaClient;
  destroy(): Promise<void>;
}

export async function createTestDb(): Promise<TestDb> {
  const dir = mkdtempSync(join(tmpdir(), "proofowl-queue-"));
  const url = `file:${join(dir, "test.db")}`;

  // Apply the committed migrations to the fresh file.
  execFileSync("npx", ["prisma", "migrate", "deploy", "--schema", SCHEMA_PATH], {
    cwd: REPO_ROOT,
    env: { ...process.env, DATABASE_URL: url },
    stdio: "pipe",
  });

  const prisma = new PrismaClient({ datasourceUrl: url });
  return {
    prisma,
    async destroy() {
      await prisma.$disconnect();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
