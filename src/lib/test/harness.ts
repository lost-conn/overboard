// Test harness for the `server-only` data layer.
//
// Everything under src/lib that touches Prisma was untestable until now, for
// two unrelated reasons: `import "server-only"` is a specifier only Next's
// bundler resolves (handled by scripts/test-resolve.mjs), and db.ts reads
// DATABASE_URL once at module load. The second is what this file is for —
// point DATABASE_URL at a scratch file *before* anything imports db, then
// `await import()` the module under test.
//
// The schema is built by replaying the committed migrations rather than by
// shelling out to `prisma migrate deploy`. That keeps the suite fast and
// offline, and it means every run is also a check that the migration chain
// applies cleanly from empty — which is exactly the assurance the promotion
// ladder's migration needed.

import Database from "better-sqlite3";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const MIGRATIONS_DIR = join(process.cwd(), "prisma", "migrations");

/** Migration directory names, in the order Prisma would apply them. */
export function migrationNames(): string[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((name) => statSync(join(MIGRATIONS_DIR, name)).isDirectory())
    .sort();
}

/** Replay the given migrations, in order, against an open connection. */
export function applyMigrations(raw: Database.Database, names: string[]): void {
  for (const name of names) {
    raw.exec(readFileSync(join(MIGRATIONS_DIR, name, "migration.sql"), "utf8"));
  }
}

/** An empty scratch file plus the disposer that removes its directory. */
export function scratchFile(): { file: string; dispose: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "overboard-test-"));
  return {
    file: join(dir, "test.db"),
    dispose: () => rmSync(dir, { recursive: true, force: true }),
  };
}

/**
 * A fresh SQLite file with the whole migration chain applied, and
 * DATABASE_URL pointed at it. Returns a disposer that drops the scratch
 * directory.
 */
export function createScratchDatabase(): () => void {
  const { file, dispose } = scratchFile();

  const raw = new Database(file);
  try {
    applyMigrations(raw, migrationNames());
  } finally {
    raw.close();
  }

  process.env.DATABASE_URL = `file:${file}`;
  return dispose;
}

let counter = 0;

/** Unique-enough id for a row we are about to create by hand. */
export function testId(prefix: string): string {
  counter += 1;
  return `${prefix}-${counter}-${Math.random().toString(36).slice(2, 10)}`;
}
