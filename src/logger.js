// Простой журнал: консоль + файл logs/mapvault.log с ротацией по размеру.
// Последние записи держим в памяти, чтобы показать их на странице «Настройки».
import fs from 'node:fs';
import path from 'node:path';

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const MAX_FILE_BYTES = 5 * 1024 * 1024;
const KEEP_FILES = 3;
const RING_SIZE = 500;

class Logger {
  constructor() {
    this.file = null;
    this.level = LEVELS.info;
    this.ring = [];
    this.console = true;
  }

  init({ dir, level = 'info', console: toConsole = true } = {}) {
    this.level = LEVELS[level] ?? LEVELS.info;
    this.console = toConsole;
    if (dir) {
      fs.mkdirSync(dir, { recursive: true });
      this.file = path.join(dir, 'mapvault.log');
    }
  }

  rotateIfNeeded() {
    if (!this.file) return;
    try {
      const st = fs.statSync(this.file);
      if (st.size < MAX_FILE_BYTES) return;
      for (let i = KEEP_FILES - 1; i >= 1; i--) {
        const from = `${this.file}.${i}`;
        if (fs.existsSync(from)) fs.renameSync(from, `${this.file}.${i + 1}`);
      }
      fs.renameSync(this.file, `${this.file}.1`);
    } catch {
      // файла ещё нет
    }
  }

  write(level, scope, msg, extra) {
    if (LEVELS[level] < this.level) return;
    const ts = new Date().toISOString();
    let detail = '';
    if (extra instanceof Error) detail = ` ${extra.stack || extra.message}`;
    else if (extra !== undefined) {
      try { detail = ` ${JSON.stringify(extra)}`; } catch { detail = ` ${String(extra)}`; }
    }
    const line = `${ts} ${level.toUpperCase().padEnd(5)} [${scope}] ${msg}${detail}`;
    this.ring.push({ ts, level, scope, msg: msg + detail });
    if (this.ring.length > RING_SIZE) this.ring.shift();
    if (this.console) (level === 'error' ? console.error : console.log)(line);
    if (this.file) {
      this.rotateIfNeeded();
      try { fs.appendFileSync(this.file, line + '\n'); } catch { /* диск недоступен — не роняем приложение */ }
    }
  }

  child(scope) {
    return {
      debug: (m, e) => this.write('debug', scope, m, e),
      info: (m, e) => this.write('info', scope, m, e),
      warn: (m, e) => this.write('warn', scope, m, e),
      error: (m, e) => this.write('error', scope, m, e),
    };
  }

  recent(limit = 200) {
    return this.ring.slice(-limit);
  }
}

export const logger = new Logger();
export const log = (scope) => logger.child(scope);
