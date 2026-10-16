// Где взять .osu-файл для расчёта: локальная папка Songs → кэш скачанных →
// скачивание с osu.ppy.sh (если есть интернет). Возвращает и источник,
// чтобы интерфейс мог честно показать достоверность расчёта.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { log } from '../logger.js';

const L = log('osu-source');

export class OsuFileSource {
  constructor({ db, cacheDir, getSongsDir, api }) {
    this.db = db;
    this.cacheDir = cacheDir;
    this.getSongsDir = getSongsDir;
    this.api = api;
  }

  localRow({ md5, beatmapId }) {
    if (md5) {
      const r = this.db.get('SELECT * FROM beatmaps WHERE md5 = ?', md5);
      if (r) return r;
    }
    if (beatmapId) return this.db.get('SELECT * FROM beatmaps WHERE beatmap_id = ? AND missing = 0 ORDER BY indexed_at DESC LIMIT 1', beatmapId) || null;
    return null;
  }

  /**
   * @returns {Promise<{content: Buffer, source: 'local'|'cache'|'download', md5: string, row: any, exactVersion: boolean} | null>}
   */
  async get({ md5, beatmapId, allowDownload = true }) {
    const row = this.localRow({ md5, beatmapId });
    const songsDir = this.getSongsDir();
    if (row && songsDir) {
      const file = path.join(songsDir, row.folder, row.file);
      try {
        const content = fs.readFileSync(file);
        const realMd5 = hash(content);
        return { content, source: 'local', md5: realMd5, row, exactVersion: !md5 || realMd5 === md5 };
      } catch {
        // файл удалён — пробуем дальше
      }
    }
    const bid = beatmapId || row?.beatmap_id || this.lookupBeatmapId(md5);
    if (!bid) return null;
    const cached = path.join(this.cacheDir, `${bid}.osu`);
    if (fs.existsSync(cached)) {
      const content = fs.readFileSync(cached);
      const realMd5 = hash(content);
      if (!md5 || realMd5 === md5 || !allowDownload) {
        return { content, source: 'cache', md5: realMd5, row, exactVersion: !md5 || realMd5 === md5 };
      }
    }
    if (!allowDownload || !this.api) return null;
    try {
      const content = await this.api.downloadOsuFile(bid);
      fs.writeFileSync(cached, content);
      const realMd5 = hash(content);
      return { content, source: 'download', md5: realMd5, row, exactVersion: !md5 || realMd5 === md5 };
    } catch (e) {
      L.warn(e.message);
      return null;
    }
  }

  lookupBeatmapId(md5) {
    if (!md5) return null;
    const r = this.db.get('SELECT beatmap_id FROM api_beatmaps WHERE checksum = ?', md5)
      || this.db.get('SELECT beatmap_id FROM scores WHERE beatmap_md5 = ? AND beatmap_id IS NOT NULL LIMIT 1', md5);
    return r?.beatmap_id || null;
  }
}

export function hash(buf) {
  return crypto.createHash('md5').update(buf).digest('hex');
}
