/**
 * Local persistence — a single queue of verified-but-not-yet-submittable
 * contributions. See ./repository.ts.
 */

import { PrismaClient } from "@prisma/client";

import { PendingContributionRepository } from "./repository.js";

export * from "./status.js";
export * from "./repository.js";

let shared: PrismaClient | undefined;

/** Process-wide PrismaClient (lazy). Pass an explicit one in tests. */
export function getPrisma(): PrismaClient {
  if (!shared) shared = new PrismaClient();
  return shared;
}

export function createQueue(prisma: PrismaClient = getPrisma()): PendingContributionRepository {
  return new PendingContributionRepository(prisma);
}

export async function disconnectPrisma(): Promise<void> {
  if (shared) {
    await shared.$disconnect();
    shared = undefined;
  }
}
