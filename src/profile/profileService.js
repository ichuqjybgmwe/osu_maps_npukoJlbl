// Профиль: данные из osu! API (снимки, top/recent plays) и локальная
// оценка по сохранённым scores, когда API недоступен.
import { normalizeApiScore } from '../scores/scoreService.js';
import { bestPerMap, weightedSum, projectGain, lifetimeFromSnapshots } from './ppMath.js';
import { MODES } from '../integrations/osuApi.js';
import { log } from '../logger.js';

const L = log('profile');

export class ProfileService {
  constructor({ db, api, scores, getSettings, events }) {
    this.db = db;
    this.api = api;
    this.scores = scores;
    this.getSettings = getSettings;
    this.events = events;
    this.refreshing = false;
    this.lastRefresh = null;
    this.lastError = null;
  }

  modeName() {
    return MODES[this.getSettings().mode ?? 0] || 'osu';
  }

  async fetchUser() {
    const s = this.getSettings();
    const mode = this.modeName();
    if (this.api.hasUser()) return this.api.me(mode);
    if (s.username) return this.api.user(s.username, mode);
    throw new Error('Не задан ник и не выполнен вход через osu!. Укажите ник в настройках или войдите через osu!.');
  }

  /** Обновить профиль, top plays и recent plays из osu! API. */
  async refresh() {
    if (this.refreshing) return { busy: true };
    this.refreshing = true;
    try {
      const user = await this.fetchUser();
      if (!user) throw new Error('Пользователь не найден');
      const modeIdx = MODES.indexOf(this.modeName());
      const st = user.statistics || {};
      this.db.setSetting('profile.user', {
        id: user.id, username: user.username, avatar_url: user.avatar_url, country_code: user.country_code,
        cover_url: user.cover?.url || user.cover_url || null, mode: modeIdx,
      });
      // Снимок сохраняем, только если что-то изменилось — история получается компактной.
      const last = this.db.get('SELECT * FROM profile_snapshots WHERE user_id = ? AND mode = ? ORDER BY taken_at DESC, id DESC LIMIT 1', user.id, modeIdx);
      const changed = !last || last.pp !== st.pp || last.play_count !== st.play_count || last.global_rank !== st.global_rank;
      if (changed) {
        this.db.run(
          `INSERT INTO profile_snapshots (user_id, mode, taken_at, pp, global_rank, country_rank, accuracy, play_count, ranked_score, raw_json)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          user.id, modeIdx, new Date().toISOString(), st.pp ?? null, st.global_rank ?? null, st.country_rank ?? null,
          st.hit_accuracy ?? null, st.play_count ?? null, st.ranked_score ?? null, JSON.stringify(st),
        );
      }

      const best = [];
      for (const offset of [0, 100]) {
        const page = await this.api.userScores(user.id, 'best', { mode: this.modeName(), limit: 100, offset });
        if (!page?.length) break;
        best.push(...page);
        if (page.length < 100) break;
      }
      const recent = (await this.api.userScores(user.id, 'recent', { mode: this.modeName(), limit: 50, includeFails: true })) || [];

      let inserted = 0;
      const fetchedAt = new Date().toISOString();
      const topIds = [];
      for (const a of best) {
        cacheApiBeatmap(this.db, a.beatmap, a.beatmapset);
        const r = await this.scores.saveAndEnrich(normalizeApiScore(a));
        if (r.inserted) inserted++;
        topIds.push(r.id);
      }
      this.db.tx(() => {
        this.db.run('DELETE FROM top_plays WHERE user_id = ? AND mode = ?', user.id, modeIdx);
        topIds.forEach((id, i) => {
          const pp = best[i].pp ?? 0;
          this.db.run('INSERT INTO top_plays (user_id, mode, position, score_id, weighted_pp, fetched_at) VALUES (?, ?, ?, ?, ?, ?)', user.id, modeIdx, i + 1, id, pp * 0.95 ** i, fetchedAt);
        });
      });
      for (const a of recent) {
        cacheApiBeatmap(this.db, a.beatmap, a.beatmapset);
        if (!a.beatmap?.checksum && !a.beatmap_id) continue;
        const r = await this.scores.saveAndEnrich(normalizeApiScore(a));
        if (r.inserted) inserted++;
      }
      this.lastRefresh = fetchedAt;
      this.lastError = null;
      L.info(`Профиль ${user.username} обновлён: pp ${st.pp}, top ${best.length}, recent ${recent.length}, новых scores ${inserted}`);
      this.events?.emit('profile', { refreshedAt: fetchedAt });
      return { ok: true, user: user.username, pp: st.pp, top: best.length, recent: recent.length, inserted };
    } catch (e) {
      this.lastError = e.message;
      throw e;
    } finally {
      this.refreshing = false;
    }
  }

  user() {
    return this.db.getSetting('profile.user');
  }

  /** Текущий список лучших: из API, если он есть, иначе локальный по сохранённым scores. */
  topList() {
    const u = this.user();
    const mode = this.getSettings().mode ?? 0;
    if (u) {
      const rows = this.db.all(
        `SELECT s.*, t.position FROM top_plays t JOIN scores s ON s.id = t.score_id WHERE t.user_id = ? AND t.mode = ? ORDER BY t.position`,
        u.id, mode,
      );
      if (rows.length) return { source: 'api', rows };
    }
    const rows = this.db.all('SELECT * FROM scores WHERE passed = 1 AND mode = ? AND COALESCE(pp, pp_calc) IS NOT NULL', mode);
    const best = bestPerMap(rows.map((r) => ({ key: r.beatmap_md5 || `bid:${r.beatmap_id}`, pp: r.pp ?? r.pp_calc, row: r })));
    return { source: 'local', rows: best.slice(0, 200).map((b, i) => ({ ...b.row, position: i + 1 })) };
  }

  topForMath() {
    return this.topList().rows.map((r) => ({ key: r.beatmap_md5 || `bid:${r.beatmap_id}`, pp: r.pp ?? r.pp_calc }));
  }

  /** Прирост профильных pp от гипотетического score (используется Farm и экраном результата). */
  projectGain(mapKey, pp) {
    return projectGain(this.topForMath(), { key: mapKey, pp });
  }

  summary() {
    const u = this.user();
    const mode = this.getSettings().mode ?? 0;
    const snaps = u ? this.db.all('SELECT * FROM profile_snapshots WHERE user_id = ? AND mode = ? ORDER BY taken_at', u.id, mode) : [];
    const lifetime = lifetimeFromSnapshots(snaps);
    const top = this.topList();
    const topPps = top.rows.map((r) => r.pp ?? r.pp_calc).filter((x) => x != null);
    const localWeighted = weightedSum(topPps);
    const last = snaps[snaps.length - 1];
    // Оценка прироста после последнего обновления API: только scores новее
    // снимка, и только через пересчёт взвешенной суммы — не простым сложением.
    let pendingGain = 0;
    if (last) {
      const newer = this.db.all(
        "SELECT * FROM scores WHERE passed = 1 AND mode = ? AND saved_at > ? AND sources NOT LIKE '%api%' AND COALESCE(pp, pp_calc) IS NOT NULL",
        mode, last.taken_at,
      );
      let list = this.topForMath();
      for (const s of newer) {
        const cand = { key: s.beatmap_md5 || `bid:${s.beatmap_id}`, pp: s.pp ?? s.pp_calc };
        const g = projectGain(list, cand);
        pendingGain += g.gain;
        list = bestPerMap([...list, cand]);
      }
    }
    const counts = this.db.get(
      "SELECT COUNT(*) AS scores, SUM(CASE WHEN sources LIKE '%tosu%' THEN 1 ELSE 0 END) AS from_tosu, SUM(CASE WHEN sources LIKE '%api%' THEN 1 ELSE 0 END) AS from_api FROM scores",
    );
    const attempts = this.db.get(
      "SELECT COUNT(*) AS total, SUM(CASE WHEN outcome = 'pass' THEN 1 ELSE 0 END) AS passes, SUM(CASE WHEN outcome = 'fail' THEN 1 ELSE 0 END) AS fails, SUM(CASE WHEN outcome IN ('quit','retry') THEN 1 ELSE 0 END) AS quits FROM attempts",
    );
    return {
      user: u,
      snapshot: last ? { ...last, raw_json: undefined } : null,
      lifetime: { ...lifetime, pendingGain },
      top: { source: top.source, count: top.rows.length, weighted: localWeighted },
      counts,
      attempts,
      lastRefresh: this.lastRefresh,
      lastError: this.lastError,
      apiConfigured: this.api.configured(),
      loggedIn: this.api.hasUser(),
    };
  }
}

export function cacheApiBeatmap(db, bm, bs) {
  if (!bm?.id) return;
  db.run(
    `INSERT INTO api_beatmaps (beatmap_id, beatmapset_id, checksum, mode, status, title, artist, creator, version, stars, ar, cs, od, hp, bpm, length_drain, max_combo, fetched_at, raw_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(beatmap_id) DO UPDATE SET checksum = COALESCE(excluded.checksum, checksum), status = COALESCE(excluded.status, status),
       title = COALESCE(excluded.title, title), artist = COALESCE(excluded.artist, artist), creator = COALESCE(excluded.creator, creator),
       stars = COALESCE(excluded.stars, stars), max_combo = COALESCE(excluded.max_combo, max_combo), fetched_at = excluded.fetched_at`,
    bm.id, bm.beatmapset_id ?? bs?.id ?? null, bm.checksum ?? null, bm.mode_int ?? null, bm.status ?? null,
    bs?.title ?? bm.beatmapset?.title ?? null, bs?.artist ?? bm.beatmapset?.artist ?? null, bs?.creator ?? bm.beatmapset?.creator ?? null,
    bm.version ?? null, bm.difficulty_rating ?? null, bm.ar ?? null, bm.cs ?? null, bm.accuracy ?? null, bm.drain ?? null,
    bm.bpm ?? null, bm.hit_length ?? null, bm.max_combo ?? null, new Date().toISOString(), null,
  );
  if (bm.checksum && bm.status) {
    db.run('UPDATE beatmaps SET status = ?, beatmap_id = COALESCE(beatmap_id, ?), status_checked_at = ? WHERE md5 = ?', bm.status, bm.id, new Date().toISOString(), bm.checksum);
  }
}
