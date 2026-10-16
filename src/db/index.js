// SQLite через встроенный node:sqlite (без нативных модулей, поэтому exe
// собирается одним файлом). Схема версионируется через PRAGMA user_version.
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { migrations } from './migrations.js';
import { log } from '../logger.js';

const L = log('db');

export function openDatabase(file) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL');
  // FULL: подтверждённый score переживает даже внезапное отключение питания.
  db.exec('PRAGMA synchronous = FULL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA busy_timeout = 5000');
  migrate(db);
  return wrap(db, file);
}

function migrate(db) {
  const current = db.prepare('PRAGMA user_version').get().user_version;
  for (let v = current; v < migrations.length; v++) {
    L.info(`Применяю миграцию ${v + 1}`);
    db.exec('BEGIN');
    try {
      db.exec(migrations[v]);
      db.exec(`PRAGMA user_version = ${v + 1}`);
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
  }
}

function wrap(db, file) {
  const cache = new Map();
  const stmt = (sql) => {
    let s = cache.get(sql);
    if (!s) {
      s = db.prepare(sql);
      cache.set(sql, s);
    }
    return s;
  };
  const api = {
    raw: db,
    file,
    all: (sql, ...p) => stmt(sql).all(...p),
    get: (sql, ...p) => stmt(sql).get(...p),
    run: (sql, ...p) => stmt(sql).run(...p),
    exec: (sql) => db.exec(sql),
    tx(fn) {
      db.exec('BEGIN IMMEDIATE');
      try {
        const r = fn();
        db.exec('COMMIT');
        return r;
      } catch (e) {
        db.exec('ROLLBACK');
        throw e;
      }
    },
    getSetting(key, fallback = null) {
      const row = stmt('SELECT value FROM settings WHERE key = ?').get(key);
      if (!row) return fallback;
      try { return JSON.parse(row.value); } catch { return fallback; }
    },
    setSetting(key, value) {
      stmt(`INSERT INTO settings(key, value, updated_at) VALUES(?, ?, ?)
            ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`)
        .run(key, JSON.stringify(value), new Date().toISOString());
    },
    backup(targetFile) {
      if (fs.existsSync(targetFile)) fs.rmSync(targetFile);
      db.exec(`VACUUM INTO '${targetFile.replace(/'/g, "''")}'`);
    },
    close() {
      try { db.exec('PRAGMA wal_checkpoint(TRUNCATE)'); } catch { /* ignore */ }
      db.close();
    },
  };
  return api;
}

// Ежедневная резервная копия, храним последние N.
export function dailyBackup(db, backupsDir, keep = 7) {
  const day = new Date().toISOString().slice(0, 10);
  const target = path.join(backupsDir, `mapvault-${day}.db`);
  if (fs.existsSync(target)) return null;
  db.backup(target);
  const files = fs.readdirSync(backupsDir).filter((f) => /^mapvault-\d{4}-\d{2}-\d{2}\.db$/.test(f)).sort();
  for (const f of files.slice(0, Math.max(0, files.length - keep))) fs.rmSync(path.join(backupsDir, f));
  L.info(`Резервная копия базы: ${target}`);
  return target;
}
