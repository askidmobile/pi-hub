/**
 * SQLite storage (node:sqlite DatabaseSync, WAL). Runs migrations from ./migrations
 * by `schema_version`. Behind this module so better-sqlite3 can replace node:sqlite (ADR-0003).
 */
export interface Storage {
  migrate(): void;
  close(): void;
}
