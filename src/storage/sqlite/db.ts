import Database from "better-sqlite3";
import { runMigrations } from "./migrations.js";

export type Db = Database.Database;

/**
 * One write connection, owned by the daemon transactor. CLI processes
 * and browsers never open the database directly.
 */
export function openDatabase(path: string): Db {
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 5000");
  db.pragma("synchronous = NORMAL");
  runMigrations(db);
  return db;
}
