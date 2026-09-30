// ~/.config/opencode/plugins/opencode-vcc/storage/migrations.ts

import type { Database } from "bun:sqlite";

export interface Migration {
  version: number;
  up: (db: Database) => void;
}

export const migrations: Migration[] = [
  {
    version: 1,
    up: (db) => {
      db.run(`
        CREATE TABLE IF NOT EXISTS vcc_summaries (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          session_id TEXT NOT NULL,
          summary TEXT NOT NULL,
          goals_json TEXT,
          files_json TEXT,
          commits_json TEXT,
          preferences_json TEXT,
          blockers_json TEXT,
          created_at TEXT DEFAULT (datetime('now'))
        )
      `);
      db.run(`CREATE INDEX IF NOT EXISTS idx_vcc_summaries_session ON vcc_summaries(session_id)`);

      db.run(`
        CREATE VIRTUAL TABLE IF NOT EXISTS vcc_messages USING fts5(
          session_id,
          entry_id UNINDEXED,
          role,
          content,
          created_at,
          tokenize='porter unicode61'
        )
      `);

      db.run(`
        CREATE TABLE IF NOT EXISTS vcc_extractions (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          session_id TEXT NOT NULL,
          goals_json TEXT,
          files_json TEXT,
          commits_json TEXT,
          preferences_json TEXT,
          blockers_json TEXT,
          transcript TEXT,
          created_at TEXT DEFAULT (datetime('now'))
        )
      `);
      db.run(`CREATE INDEX IF NOT EXISTS idx_vcc_extractions_session ON vcc_extractions(session_id)`);

      db.run(`
        CREATE TABLE IF NOT EXISTS vcc_schema_version (
          version INTEGER PRIMARY KEY,
          applied_at TEXT DEFAULT (datetime('now'))
        )
      `);
      db.run(`INSERT INTO vcc_schema_version (version) VALUES (1)`);
    },
  },
];

export function runMigrations(db: Database): void {
  // Check if schema version table exists before querying it
  const tableExists = db.query(
    "SELECT name FROM sqlite_master WHERE type='table' AND name='vcc_schema_version'"
  ).get() as { name: string } | null;

  let currentVersion = 0;
  if (tableExists) {
    const current = db.query("SELECT MAX(version) as v FROM vcc_schema_version").get() as { v: number | null } | null;
    currentVersion = current?.v ?? 0;
  }

  for (const migration of migrations) {
    if (migration.version > currentVersion) {
      db.transaction(() => {
        migration.up(db);
      })();
    }
  }
}
