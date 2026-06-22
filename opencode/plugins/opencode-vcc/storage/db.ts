// ~/.config/opencode/plugins/opencode-vcc/storage/db.ts

import { Database } from "bun:sqlite";
import { join } from "node:path";
import { mkdirSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { runMigrations } from "./migrations.js";

let _db: Database | null = null;

function getDbPath(): string {
  const dir = join(homedir(), ".opencode", "vcc");
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  return join(dir, "vcc.db");
}

export function getDb(): Database {
  if (!_db) {
    const path = getDbPath();
    _db = new Database(path);
    _db.run("PRAGMA journal_mode=WAL");
    _db.run("PRAGMA synchronous=NORMAL");
    runMigrations(_db);
  }
  return _db;
}

export function closeDb(): void {
  if (_db) {
    _db.close();
    _db = null;
  }
}
