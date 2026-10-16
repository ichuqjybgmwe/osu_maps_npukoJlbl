// Сохранение результатов с дедупликацией.
// Ключ дедупликации строится из того, что одинаково у одного и того же score
// во всех источниках (Tosu, osu! API): карта, режим, счёт, комбо, попадания,
// моды. Имя игрока в ключ не входит (может смениться), а дата — тоже нет,
// потому что Tosu и API отдают её с разной точностью.
import crypto from 'node:crypto';
import { parseMods, modsToString, modsRate } from '../pp/mods.js';
import { log } from '../logger.js';

const L = log('scores');

export function dedupKey(s) {
  const mapKey = s.beatmapMd5 ? `md5:${s.beatmapMd5.toLowerCase()}` : `bid:${s.beatmapId}`;
  const mods = parseMods(s.mods).map((m) => (m === 'NC' ? 'DT' : m)).sort().join('');
  const parts = [mapKey, s.mode ?? 0, s.score, s.maxCombo, s.n300, s.n100, s.n50, s.nmiss, mods];
  return crypto.createHash('sha1').update(parts.join('|')).digest('hex');
}

/** Нормализация score из osu! API v2 (x-api-version 20240529, есть фолбэк на старый формат). */
export function normalizeApiScore(a) {
  const st = a.statistics || {};
  const legacy = 'count_300' in st;
  const mods = a.mods || [];
  const isLazer = a.build_id != null;
  const scoreValue = !isLazer && a.legacy_total_score ? a.legacy_total_score : a.total_score ?? a.score ?? 0;
  const bm = a.beatmap || {};
  const bs = a.beatmapset || {};
  return {
    source: 'api',
    apiScoreId: a.id ?? null,
    beatmapMd5: bm.checksum || null,
    beatmapId: a.beatmap_id ?? bm.id ?? null,
    beatmapsetId: bm.beatmapset_id ?? bs.id ?? null,
    beatmapTitle: bs.title ? `${bs.artist} - ${bs.title} [${bm.version}]` : null,
    mode: a.ruleset_id ?? a.mode_int ?? 0,
    userId: a.user_id ?? a.user?.id ?? null,
    playerName: a.user?.username ?? null,
    score: Number(scoreValue) || 0,
    accuracy: (Number(a.accuracy) || 0) * 100,
    maxCombo: a.max_combo ?? 0,
    n300: legacy ? st.count_300 ?? 0 : st.great ?? 0,
    n100: legacy ? st.count_100 ?? 0 : st.ok ?? 0,
    n50: legacy ? st.count_50 ?? 0 : st.meh ?? 0,
    nmiss: legacy ? st.count_miss ?? 0 : st.miss ?? 0,
    ngeki: legacy ? st.count_geki ?? 0 : st.perfect ?? 0,
    nkatu: legacy ? st.count_katu ?? 0 : st.good ?? 0,
    sliderEndHits: st.slider_tail_hit ?? null,
    smallTickHits: st.small_tick_hit ?? null,
    largeTickHits: st.large_tick_hit ?? null,
    mods: modsToString(mods),
    modsJson: Array.isArray(mods) ? mods : null,
    rate: modsRate(mods),
    rank: a.rank ?? null,
    passed: a.passed !== false,
    pp: a.pp ?? null,
    lazer: isLazer,
    playedAt: a.ended_at || a.created_at || null,
    raw: a,
  };
}

export class ScoreService {
  constructor({ db, events, ppForScore }) {
    this.db = db;
    this.events = events;
    this.ppForScore = ppForScore; // async (score) => {pp, ppFc, stars} | null
  }

  /**
   * Сохранить score. Повторное сохранение того же результата (из любого источника)
   * не создаёт новую строку, а дополняет существующую.
   * @returns {{ id: number, inserted: boolean }}
   */
  save(s) {
    if (!s.beatmapMd5 && !s.beatmapId) throw new Error('У результата нет идентификатора карты');
    const key = dedupKey(s);
    const now = new Date().toISOString();
    return this.db.tx(() => {
      let existing = this.db.get('SELECT * FROM scores WHERE dedup_key = ?', key);
      if (!existing && s.apiScoreId) existing = this.db.get('SELECT * FROM scores WHERE api_score_id = ?', s.apiScoreId);
      if (existing) {
        const sources = new Set(existing.sources.split(',').filter(Boolean));
        sources.add(s.source);
        // Официальные pp (из API) важнее, чем оценка Tosu.
        const pp = s.source === 'api' && s.pp != null ? s.pp : existing.pp ?? s.pp ?? null;
        this.db.run(
          `UPDATE scores SET sources = ?, api_score_id = COALESCE(api_score_id, ?), beatmap_md5 = COALESCE(beatmap_md5, ?),
             beatmap_id = COALESCE(beatmap_id, ?), beatmapset_id = COALESCE(beatmapset_id, ?), user_id = COALESCE(user_id, ?),
             player_name = COALESCE(player_name, ?), rank = COALESCE(rank, ?), pp = ?,
             played_at = CASE WHEN ? = 'api' AND ? IS NOT NULL THEN ? ELSE COALESCE(played_at, ?) END,
             beatmap_title = COALESCE(beatmap_title, ?)
           WHERE id = ?`,
          [...sources].sort().join(','), s.apiScoreId ?? null, s.beatmapMd5 ?? null, s.beatmapId ?? null, s.beatmapsetId ?? null,
          s.userId ?? null, s.playerName ?? null, s.rank ?? null, pp,
          s.source, s.playedAt ?? null, s.playedAt ?? null, s.playedAt ?? null,
          s.beatmapTitle ?? null, existing.id,
        );
        return { id: existing.id, inserted: false, key };
      }
      const r = this.db.run(
        `INSERT INTO scores (dedup_key, sources, api_score_id, beatmap_md5, beatmap_id, beatmapset_id, mode, user_id, player_name,
           score, accuracy, max_combo, n300, n100, n50, nmiss, ngeki, nkatu, slider_end_hits, small_tick_hits, large_tick_hits,
           mods, mods_json, rate, rank, passed, pp, pp_fc, lazer, played_at, saved_at, beatmap_title, raw_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        key, s.source, s.apiScoreId ?? null, s.beatmapMd5 ?? null, s.beatmapId ?? null, s.beatmapsetId ?? null, s.mode ?? 0,
        s.userId ?? null, s.playerName ?? null, s.score, s.accuracy, s.maxCombo, s.n300, s.n100, s.n50, s.nmiss,
        s.ngeki ?? 0, s.nkatu ?? 0, s.sliderEndHits ?? null, s.smallTickHits ?? null, s.largeTickHits ?? null,
        modsToString(s.mods), s.modsJson ? JSON.stringify(s.modsJson) : null, s.rate ?? 1, s.rank ?? null, s.passed ? 1 : 0,
        s.pp ?? null, s.ppFc ?? null, s.lazer ? 1 : 0, s.playedAt ?? now, now, s.beatmapTitle ?? null,
        s.raw ? JSON.stringify(s.raw) : null,
      );
      return { id: Number(r.lastInsertRowid), inserted: true, key };
    });
  }

  /** Сохранить и асинхронно досчитать pp/звёзды нашим калькулятором. */
  async saveAndEnrich(s) {
    const res = this.save(s);
    if (res.inserted) L.info(`Сохранён новый результат #${res.id} (${s.source}): ${s.beatmapTitle || s.beatmapMd5} ${s.mods || 'NM'} ${s.accuracy.toFixed(2)}%`);
    if (this.ppForScore) {
      try {
        const row = this.db.get('SELECT * FROM scores WHERE id = ?', res.id);
        if (row.pp_calc == null) {
          const calc = await this.ppForScore(row);
          if (calc) this.db.run('UPDATE scores SET pp_calc = ?, pp_fc = COALESCE(pp_fc, ?), stars = ? WHERE id = ?', calc.pp, calc.ppFc ?? null, calc.stars ?? null, res.id);
        }
      } catch (e) {
        L.warn(`Не удалось пересчитать pp для результата #${res.id}: ${e.message}`);
      }
    }
    if (res.inserted) this.events?.emit('score', { id: res.id });
    return res;
  }

  saveAttempt(a, scoreId = null) {
    const r = this.db.run(
      `INSERT INTO attempts (beatmap_md5, beatmap_id, mode, mods, started_at, ended_at, outcome, progress, accuracy, max_combo, nmiss, score, pp_current, score_id, player_name)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      a.beatmapMd5 ?? null, a.beatmapId ?? null, a.mode ?? 0, a.mods || '', a.startedAt, a.endedAt ?? null, a.outcome ?? null,
      a.progress ?? null, a.accuracy ?? null, a.maxCombo ?? null, a.nmiss ?? null, a.score ?? null, a.ppCurrent ?? null,
      scoreId ?? null, a.playerName ?? null,
    );
    return Number(r.lastInsertRowid);
  }

  /** Привязать последнюю успешную попытку на этой карте к сохранённому score. */
  linkLastPassAttempt(md5, scoreId) {
    const a = this.db.get("SELECT id FROM attempts WHERE beatmap_md5 = ? AND outcome = 'pass' AND score_id IS NULL ORDER BY id DESC LIMIT 1", md5);
    if (a) this.db.run('UPDATE attempts SET score_id = ? WHERE id = ?', scoreId, a.id);
  }

  list({ md5, beatmapId, limit = 50, offset = 0, order = 'recent', passedOnly = false } = {}) {
    const where = [];
    const params = [];
    if (md5 && beatmapId) { where.push('(s.beatmap_md5 = ? OR s.beatmap_id = ?)'); params.push(md5, beatmapId); }
    else if (md5) { where.push('s.beatmap_md5 = ?'); params.push(md5); }
    else if (beatmapId) { where.push('s.beatmap_id = ?'); params.push(beatmapId); }
    if (passedOnly) where.push('s.passed = 1');
    const orderBy = order === 'pp' ? 'COALESCE(s.pp, s.pp_calc) DESC NULLS LAST' : 's.played_at DESC';
    return this.db.all(
      `SELECT s.id, s.sources, s.api_score_id, s.beatmap_md5, s.beatmap_id, s.beatmapset_id, s.mode, s.player_name, s.score,
              s.accuracy, s.max_combo, s.n300, s.n100, s.n50, s.nmiss, s.mods, s.rank, s.passed, s.pp, s.pp_calc, s.pp_fc,
              s.stars, s.lazer, s.played_at, s.saved_at,
              COALESCE(b.artist || ' - ' || b.title || ' [' || b.version || ']', s.beatmap_title,
                       ab.artist || ' - ' || ab.title || ' [' || ab.version || ']') AS title,
              b.max_combo AS map_max_combo, b.md5 AS local_md5
       FROM scores s
       LEFT JOIN beatmaps b ON b.md5 = s.beatmap_md5
       LEFT JOIN api_beatmaps ab ON ab.beatmap_id = s.beatmap_id
       ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
       ORDER BY ${orderBy} LIMIT ? OFFSET ?`,
      ...params, limit, offset,
    );
  }

  attempts({ md5, limit = 100 } = {}) {
    if (md5) return this.db.all('SELECT * FROM attempts WHERE beatmap_md5 = ? ORDER BY id DESC LIMIT ?', md5, limit);
    return this.db.all(
      `SELECT a.*, COALESCE(b.artist || ' - ' || b.title || ' [' || b.version || ']', ab.artist || ' - ' || ab.title || ' [' || ab.version || ']') AS title
       FROM attempts a LEFT JOIN beatmaps b ON b.md5 = a.beatmap_md5 LEFT JOIN api_beatmaps ab ON ab.beatmap_id = a.beatmap_id
       ORDER BY a.id DESC LIMIT ?`, limit,
    );
  }
}
