import { mkdirSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

/**
 * SQLite storage (ADR-0003): node:sqlite behind this module so better-sqlite3 can replace it.
 * Only the hub daemon opens the database for writing.
 */
export type Db = DatabaseSync;

/** Bundled migrations: src/storage/migrations in tests, dist/storage/migrations after build. */
export const MIGRATIONS_DIR = fileURLToPath(new URL("./migrations/", import.meta.url));

export function openDatabase(file: string): Db {
  if (file !== ":memory:") mkdirSync(dirname(file), { recursive: true });
  const db = new DatabaseSync(file, { enableForeignKeyConstraints: true, timeout: 5000 });
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA synchronous = NORMAL;");
  return db;
}

export interface Migration {
  version: number;
  name: string;
  sql: string;
}

/** `NNN_name.sql`, sorted by version; duplicate versions are an error. */
export function listMigrations(dir: string = MIGRATIONS_DIR): Migration[] {
  const out: Migration[] = [];
  for (const name of readdirSync(dir)) {
    const m = /^(\d+)_.+\.sql$/.exec(name);
    if (!m) continue;
    out.push({ version: Number(m[1]), name, sql: readFileSync(join(dir, name), "utf8") });
  }
  out.sort((a, b) => a.version - b.version);
  for (let i = 1; i < out.length; i++) {
    if (out[i]?.version === out[i - 1]?.version) {
      throw new Error(`duplicate migration version ${out[i]?.version} in ${dir}`);
    }
  }
  return out;
}

export function schemaVersion(db: Db): number {
  const table = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'schema_version'")
    .get();
  if (!table) return 0;
  const row = db.prepare("SELECT MAX(version) AS v FROM schema_version").get() as
    | { v: number | null }
    | undefined;
  return row?.v ?? 0;
}

/** Applies every migration newer than the current version, each in its own transaction. */
export function migrate(db: Db, dir: string = MIGRATIONS_DIR): number[] {
  const applied: number[] = [];
  const current = schemaVersion(db);
  for (const m of listMigrations(dir)) {
    if (m.version <= current) continue;
    db.exec("BEGIN IMMEDIATE");
    try {
      db.exec(m.sql);
      db.exec("DELETE FROM schema_version");
      db.prepare("INSERT INTO schema_version (version) VALUES (?)").run(m.version);
      db.exec("COMMIT");
    } catch (e) {
      db.exec("ROLLBACK");
      throw new Error(`migration ${m.name} failed: ${(e as Error).message}`);
    }
    applied.push(m.version);
  }
  return applied;
}
