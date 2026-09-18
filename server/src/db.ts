import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

export type Database = DatabaseSync;

/**
 * Schema steps applied in order. Each entry moves PRAGMA user_version one step up, so a running site upgrades its own
 * database at startup and there is no separate migration command to forget.
 */
const MIGRATIONS: string[] = [
  `CREATE TABLE users (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     username TEXT NOT NULL,
     username_lower TEXT NOT NULL UNIQUE,
     password_hash TEXT NOT NULL,
     minecraft_username TEXT NOT NULL,
     minecraft_username_lower TEXT NOT NULL UNIQUE,
     created_at TEXT NOT NULL,
     updated_at TEXT NOT NULL
   );
   CREATE TABLE sessions (
     token_hash BLOB PRIMARY KEY,
     user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
     created_at INTEGER NOT NULL,
     last_seen_at INTEGER NOT NULL,
     expires_at INTEGER NOT NULL
   );
   CREATE INDEX sessions_user ON sessions(user_id);
   CREATE INDEX sessions_expires ON sessions(expires_at);`,

  // one skin per account, owned by users.id: renaming the player in Minecraft never moves the skin
  `CREATE TABLE skins (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     user_id INTEGER NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
     original_filename TEXT,
     stored_filename TEXT NOT NULL UNIQUE,
     public_url TEXT NOT NULL,
     mime_type TEXT NOT NULL,
     source_mime_type TEXT NOT NULL,
     file_size INTEGER NOT NULL,
     width INTEGER NOT NULL,
     height INTEGER NOT NULL,
     created_at TEXT NOT NULL,
     updated_at TEXT NOT NULL
   );
   CREATE INDEX skins_user ON skins(user_id);`,

  /*
   * A skin name players actually type in Minecraft, and the Minecraft UUID of an account. SQLite cannot add a column
   * with a constraint, so the uniqueness lives in an index and the values are filled in by the code.
   */
  `ALTER TABLE skins ADD COLUMN skin_name TEXT;
   ALTER TABLE skins ADD COLUMN skin_name_lower TEXT;
   UPDATE skins SET skin_name = 'os' || substr(stored_filename, 1, 6), skin_name_lower = 'os' || substr(stored_filename, 1, 6);
   CREATE UNIQUE INDEX skins_name ON skins(skin_name_lower);
   ALTER TABLE users ADD COLUMN minecraft_uuid TEXT;
   CREATE UNIQUE INDEX users_minecraft_uuid ON users(minecraft_uuid);`,
];

export function schemaVersion(db: Database): number {
  const row = db.prepare("PRAGMA user_version").get();
  return Number(row?.["user_version"] ?? 0);
}

/** Brings the database up to the newest schema. A failed step is rolled back, so a broken file is never half migrated. */
export function migrate(db: Database): number {
  let version = schemaVersion(db);
  while (version < MIGRATIONS.length) {
    const step = MIGRATIONS[version]!;
    db.exec("BEGIN");
    try {
      db.exec(step);
      // interpolation is safe: the value is a loop counter, not user input
      db.exec(`PRAGMA user_version = ${version + 1}`);
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
    version++;
  }
  return version;
}

/** Opens (and creates) the site database. Pass ":memory:" in tests. */
export function openDatabase(filePath: string): Database {
  if (filePath !== ":memory:") {
    mkdirSync(path.dirname(filePath), { recursive: true });
  }
  const db = new DatabaseSync(filePath);
  // WAL keeps reads working while a write is in flight; foreign keys are off by default in SQLite
  if (filePath !== ":memory:") {
    db.exec("PRAGMA journal_mode = WAL");
  }
  db.exec("PRAGMA foreign_keys = ON");
  db.exec("PRAGMA busy_timeout = 5000");
  migrate(db);
  return db;
}
