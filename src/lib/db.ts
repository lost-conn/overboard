import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import { PrismaClient } from "@/generated/prisma/client";

const DB_URL = process.env.DATABASE_URL?.replace(/^file:/, "") ?? "./data/app.db";

const globalForPrisma = globalThis as unknown as {
  prisma?: PrismaClient;
};

function createClient(): PrismaClient {
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
