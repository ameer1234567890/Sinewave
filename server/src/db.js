import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { config } from './config.js';

fs.mkdirSync(path.dirname(config.databasePath), { recursive: true });
export const db = new DatabaseSync(config.databasePath);
db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000; PRAGMA synchronous = NORMAL;');
// now() returns the same ISO format the schema uses for its defaults.
db.function('now', () => new Date().toISOString());

const statements = new Map();
function prepare(sql) {
  let stmt = statements.get(sql);
  if (!stmt) {
    // Queries are written with $1, $2 placeholders; SQLite's numbered form is ?1, ?2.
    stmt = db.prepare(sql.replace(/\$(\d+)/g, '?$1'));
    statements.set(sql, stmt);
  }
  return stmt;
}

function toParam(v) {
  if (v === undefined) return null;
  if (v instanceof Date) return v.toISOString();
  if (typeof v === 'boolean') return v ? 1 : 0;
  return v;
}

const returnsRows = (sql) => /^\s*(SELECT|WITH|PRAGMA)\b/i.test(sql) || /\bRETURNING\b/i.test(sql);

/**
 * Run one statement. Returns { rows, rowCount } so call sites read the same whether the
 * statement returns rows or not. SQLite is synchronous; callers may still `await` it.
 */
export function query(sql, params = []) {
  const stmt = prepare(sql);
  const args = params.map(toParam);
  if (returnsRows(sql)) {
    const rows = stmt.all(...args);
    return { rows, rowCount: rows.length };
  }
  const { changes } = stmt.run(...args);
  return { rows: [], rowCount: Number(changes) };
}

/**
 * Run `fn` inside a transaction. `fn` must be synchronous: SQLite has one connection, so an
 * `await` inside would let other requests' statements slip into this transaction.
 */
export function withTransaction(fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn({ query });
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

export const isForeignKeyError = (err) => /FOREIGN KEY constraint failed/i.test(err?.message || '');

/** Apply any .sql files in migrations/ that have not been applied yet, in name order. */
export function migrate() {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    name TEXT PRIMARY KEY, applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')))`);
  const applied = new Set(query('SELECT name FROM schema_migrations').rows.map((r) => r.name));
  const files = fs.readdirSync(config.migrationsDir).filter((f) => f.endsWith('.sql')).sort();
  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = fs.readFileSync(path.join(config.migrationsDir, file), 'utf8');
    withTransaction(() => {
      db.exec(sql);
      query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
    });
    console.log(`Applied migration ${file}`);
  }
}

export function closeDatabase() {
  db.close();
}
