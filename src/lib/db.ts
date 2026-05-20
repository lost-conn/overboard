import Database from "better-sqlite3";
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import { PrismaClient } from "@/generated/prisma/client";

const DB_URL = process.env.DATABASE_URL?.replace(/^file:/, "") ?? "./data/app.db";

const globalForPrisma = globalThis as unknown as {
  prisma?: PrismaClient;
  walEnabled?: boolean;
};

// WAL persists in the file, but assert it on cold start so fresh deploys are covered.
// Readers won't block writers — needed once an MCP client mutates concurrently with the UI.
function ensureWal(): void {
  if (globalForPrisma.walEnabled) return;
  try {
    const raw = new Database(DB_URL);
    raw.pragma("journal_mode = WAL");
    raw.close();
    globalForPrisma.walEnabled = true;
  } catch {
    // DB may not exist yet at build time; migrate step or first connection will create it.
  }
}

function createClient(): PrismaClient {
  ensureWal();
  const adapter = new PrismaBetterSqlite3({ url: DB_URL });
  return new PrismaClient({
    adapter,
    log:
      process.env.NODE_ENV === "development" ? ["warn", "error"] : ["error"],
  });
}

export const db = globalForPrisma.prisma ?? createClient();

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prisma = db;
}
