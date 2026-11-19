import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { config } from './config.js';

function openDatabase() {
  const dir = path.dirname(config.databasePath);
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.accessSync(dir, fs.constants.W_OK);
    return new DatabaseSync(config.databasePath);
  } catch (err) {
    const uid = process.getuid?.() ?? '?';
    const gid = process.getgid?.() ?? '?';
    console.error(
      `Cannot open the database at ${config.databasePath} (${err.message}).\n` +
        `The folder ${dir} must be writable by user ${uid}:${gid}. In Docker, check the volume ` +
        `mounted at /data, or set PUID/PGID to the user that owns it.`,
    );
    process.exit(1);
  }
}

export const db = openDatabase();
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

/**
 * Apply any .sql files in migrations/ that have not been applied yet, in name order.
 * Returns true when the database was brand new (no migration had ever run), i.e. a fresh install.
 */
export function migrate() {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    name TEXT PRIMARY KEY, applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')))`);
  const applied = new Set(query('SELECT name FROM schema_migrations').rows.map((r) => r.name));
  const files = fs.readdirSync(config.migrationsDir).filter((f) => f.endsWith('.sql')).sort();
  // Foreign keys are off while migrating so a migration can rebuild a table (SQLite's way of
  // changing a constraint) without cascading deletes. They're checked again before commit.
  // The pragma is a no-op inside a transaction, so it is set out here.
  db.exec('PRAGMA foreign_keys = OFF');
  try {
    for (const file of files) {
      if (applied.has(file)) continue;
      const sql = fs.readFileSync(path.join(config.migrationsDir, file), 'utf8');
      withTransaction(() => {
        db.exec(sql);
        const broken = query('PRAGMA foreign_key_check').rows;
        if (broken.length) throw new Error(`Migration ${file} broke ${broken.length} foreign key reference(s)`);
        query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
      });
      console.log(`Applied migration ${file}`);
    }
  } finally {
    db.exec('PRAGMA foreign_keys = ON');
  }
  return applied.size === 0;
}

export function closeDatabase() {
  db.close();
}
