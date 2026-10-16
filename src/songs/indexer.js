// Индексатор папки Songs. Сканирование инкрементальное: неизменённые файлы
// (тот же размер и время изменения) пропускаются, так что повторный запуск быстрый.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { parseOsuFile } from './osuParser.js';
import { parseBeatmap, summarizeForIndex } from '../pp/calculator.js';
import { log } from '../logger.js';

const L = log('indexer');

const yieldToLoop = () => new Promise((r) => setImmediate(r));

export class SongsIndexer {
  constructor({ db, events, getSettings }) {
    this.db = db;
    this.events = events;
    this.getSettings = getSettings;
    this.state = { running: false, phase: 'idle', total: 0, done: 0, added: 0, updated: 0, removed: 0, errors: 0, startedAt: null, finishedAt: null, songsDir: null, lastError: null };
    this.cancelRequested = false;
  }

  status() {
    const counts = this.db.get('SELECT COUNT(*) AS total, SUM(CASE WHEN stars_nm IS NOT NULL THEN 1 ELSE 0 END) AS calculated FROM beatmaps WHERE missing = 0');
    return { ...this.state, indexed: counts.total || 0, calculated: counts.calculated || 0 };
  }

  emit() {
    this.events?.emit('indexer', this.status());
  }

  cancel() {
    if (this.state.running) this.cancelRequested = true;
  }

  async scan({ songsDir, force = false } = {}) {
    if (this.state.running) return this.status();
    const settings = this.getSettings();
    songsDir = songsDir || settings.songsDir;
    if (!songsDir) throw new Error('Не задана папка Songs. Укажите её в настройках или запустите автопоиск osu!.');
    if (!fs.existsSync(songsDir)) throw new Error(`Папка Songs не найдена: ${songsDir}`);
    const lazer = settings.ppMode === 'lazer';

    this.cancelRequested = false;
    Object.assign(this.state, { running: true, phase: 'listing', total: 0, done: 0, added: 0, updated: 0, removed: 0, errors: 0, startedAt: new Date().toISOString(), finishedAt: null, songsDir, lastError: null });
    this.emit();
    L.info(`Сканирование ${songsDir}${force ? ' (полное)' : ''}`);

    try {
      const files = await listOsuFiles(songsDir);
      this.state.total = files.length;
      this.state.phase = 'indexing';
      this.emit();

      const known = new Map();
      for (const r of this.db.all('SELECT md5, folder, file, file_size, file_mtime, stars_nm, calc_error FROM beatmaps')) {
        known.set(`${r.folder}/${r.file}`, r);
      }
      const seen = new Set();
      let lastEmit = Date.now();
      let sliceStart = Date.now();

      for (const f of files) {
        if (this.cancelRequested) break;
        const key = `${f.folder}/${f.file}`;
        const prev = known.get(key);
        try {
          if (!force && prev && prev.file_size === f.size && prev.file_mtime === f.mtime && (prev.stars_nm != null || prev.calc_error)) {
            seen.add(prev.md5);
            this.db.run('UPDATE beatmaps SET missing = 0 WHERE md5 = ? AND missing = 1', prev.md5);
          } else {
            const md5 = this.indexFile(songsDir, f, lazer);
            seen.add(md5);
            if (prev) this.state.updated++; else this.state.added++;
          }
        } catch (e) {
          this.state.errors++;
          this.state.lastError = `${key}: ${e.message}`;
          L.warn(`Не удалось проиндексировать ${key}: ${e.message}`);
        }
        this.state.done++;
        if (Date.now() - sliceStart > 30) {
          await yieldToLoop(); // не блокируем HTTP-сервер и Tosu
          sliceStart = Date.now();
        }
        if (Date.now() - lastEmit > 500) {
          this.emit();
          lastEmit = Date.now();
        }
      }

      if (!this.cancelRequested) {
        // Карты, которых больше нет на диске, помечаем, но не удаляем:
        // на них могут ссылаться сохранённые scores.
        const all = this.db.all('SELECT md5 FROM beatmaps WHERE missing = 0');
        this.db.tx(() => {
          for (const r of all) {
            if (!seen.has(r.md5)) {
              this.db.run('UPDATE beatmaps SET missing = 1 WHERE md5 = ?', r.md5);
              this.state.removed++;
            }
          }
        });
      }
      this.state.phase = this.cancelRequested ? 'cancelled' : 'done';
      L.info(`Сканирование завершено: всего ${files.length}, новых ${this.state.added}, обновлено ${this.state.updated}, пропало ${this.state.removed}, ошибок ${this.state.errors}`);
    } catch (e) {
      this.state.phase = 'error';
      this.state.lastError = e.message;
      L.error('Сканирование упало', e);
      throw e;
    } finally {
      this.state.running = false;
      this.state.finishedAt = new Date().toISOString();
      this.emit();
    }
    return this.status();
  }

  indexFile(songsDir, f, lazer) {
    const full = path.join(songsDir, f.folder, f.file);
    const buf = fs.readFileSync(full);
    const md5 = crypto.createHash('md5').update(buf).digest('hex');
    const meta = parseOsuFile(buf.toString('utf8'));
    if (!meta.formatVersion && meta.nCircles + meta.nSliders + meta.nSpinners === 0) {
      throw new Error('файл пустой или не является .osu');
    }
    let calc = {};
    let calcError = null;
    let map = null;
    try {
      map = parseBeatmap(buf);
      calc = summarizeForIndex(map, { lazer });
    } catch (e) {
      calcError = String(e.message || e).slice(0, 300);
    } finally {
      try { map?.free(); } catch { /* ignore */ }
    }
    const now = new Date().toISOString();
    const row = {
      md5, beatmap_id: meta.beatmapId, beatmapset_id: meta.beatmapSetId ?? guessSetId(f.folder),
      folder: f.folder, file: f.file, file_size: f.size, file_mtime: f.mtime, mode: meta.mode,
      title: meta.title, title_unicode: meta.titleUnicode, artist: meta.artist, artist_unicode: meta.artistUnicode,
      creator: meta.creator, version: meta.version, source: meta.source, tags: meta.tags,
      ar: meta.ar, cs: meta.cs, od: meta.od, hp: meta.hp,
      bpm_min: meta.bpmMin, bpm_max: meta.bpmMax, bpm_main: meta.bpmMain,
      length_drain: meta.lengthDrain, length_total: meta.lengthTotal,
      n_circles: meta.nCircles, n_sliders: meta.nSliders, n_spinners: meta.nSpinners,
      max_combo: calc.max_combo ?? null,
      stars_nm: calc.stars_nm ?? null, stars_hr: calc.stars_hr ?? null, stars_dt: calc.stars_dt ?? null,
      stars_ez: calc.stars_ez ?? null, stars_ht: calc.stars_ht ?? null,
      aim_nm: calc.aim_nm ?? null, speed_nm: calc.speed_nm ?? null,
      pp_nm_95: calc.pp_nm_95 ?? null, pp_nm_98: calc.pp_nm_98 ?? null, pp_nm_100: calc.pp_nm_100 ?? null,
      calc_error: calcError, indexed_at: now,
    };
    upsertBeatmap(this.db, row);
    return md5;
  }
}

export function upsertBeatmap(db, row) {
  const cols = Object.keys(row);
  const updates = cols.filter((c) => c !== 'md5').map((c) => `${c} = excluded.${c}`).join(', ');
  db.tx(() => {
    // Если файл с тем же путём раньше имел другой md5 (карту обновили) — убираем старую запись из индекса.
    const old = db.get('SELECT md5 FROM beatmaps WHERE folder = ? AND file = ? AND md5 != ?', row.folder, row.file, row.md5);
    if (old) {
      db.run('UPDATE beatmaps SET missing = 1 WHERE md5 = ?', old.md5);
      db.run('DELETE FROM beatmaps_fts WHERE md5 = ?', old.md5);
    }
    db.run(
      `INSERT INTO beatmaps (${cols.join(', ')}, missing) VALUES (${cols.map(() => '?').join(', ')}, 0)
       ON CONFLICT(md5) DO UPDATE SET ${updates}, missing = 0`,
      ...cols.map((c) => row[c]),
    );
    db.run('DELETE FROM beatmaps_fts WHERE md5 = ?', row.md5);
    db.run(
      'INSERT INTO beatmaps_fts (md5, title, artist, creator, version, source, tags) VALUES (?, ?, ?, ?, ?, ?, ?)',
      row.md5,
      [row.title, row.title_unicode].filter(Boolean).join(' '),
      [row.artist, row.artist_unicode].filter(Boolean).join(' '),
      row.creator || '', row.version || '', row.source || '', row.tags || '',
    );
  });
}

function guessSetId(folder) {
  const m = /^(\d+)\s/.exec(folder);
  return m ? Number(m[1]) : null;
}

async function listOsuFiles(songsDir) {
  const out = [];
  const entries = await fsp.readdir(songsDir, { withFileTypes: true });
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const dir = path.join(songsDir, e.name);
    let files;
    try {
      files = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const f of files) {
      if (!f.isFile() || !f.name.toLowerCase().endsWith('.osu')) continue;
      try {
        const st = await fsp.stat(path.join(dir, f.name));
        out.push({ folder: e.name, file: f.name, size: st.size, mtime: Math.floor(st.mtimeMs) });
      } catch {
        // файл исчез во время сканирования
      }
    }
  }
  return out;
}

export function beatmapFilePath(songsDir, row) {
  return path.join(songsDir, row.folder, row.file);
}
