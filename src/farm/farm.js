// Farm: поиск карт, которые с наибольшей вероятностью дадут прирост
// профильных pp при наименьших затратах времени.
//
// 1. Анализ профиля: рабочий диапазон звёзд, точность по сложности, моды,
//    порог входа в топ — по реальным top plays (API) или сохранённым scores.
// 2. Для каждой карты-кандидата × набора модов: прогноз точности →
//    точный pp через rosu-pp → прирост профиля через взвешенную сумму.
// 3. Farm Score = прирост × вероятность успеха ÷ время. Каждая рекомендация
//    объясняется, а реальные результаты по рекомендованным картам
//    корректируют прогноз точности (обратная связь).
import fs from 'node:fs';
import path from 'node:path';
import { calcPerformance, getCachedBeatmap } from '../pp/calculator.js';
import { difficultyMods, modsToString } from '../pp/mods.js';
import { projectGain, bestPerMap } from '../profile/ppMath.js';
import { effectiveAttrs } from '../explorer/search.js';
import { cacheApiBeatmap } from '../profile/profileService.js';
import { log } from '../logger.js';

const L = log('farm');

const COMBOS = ['', 'HD', 'HR', 'DT', 'HDHR', 'HDDT'];
const RANKED = new Set(['ranked', 'approved']);
const yieldToLoop = () => new Promise((r) => setImmediate(r));

const quantile = (arr, q) => {
  if (!arr.length) return null;
  const s = [...arr].sort((a, b) => a - b);
  const pos = (s.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return s[lo] + (s[hi] - s[lo]) * (pos - lo);
};
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const sigmoid = (x) => 1 / (1 + Math.exp(-x));
const fmtLen = (s) => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')}`;
const comboName = (c) => c || 'NM';

/** Линейная регрессия точности от звёзд: acc ≈ a + b·stars (b ≤ 0). */
export function fitAccuracyModel(points) {
  const pts = points.filter((p) => p.stars > 0 && p.acc > 0);
  const meanAcc = pts.length ? pts.reduce((s, p) => s + p.acc, 0) / pts.length : 97;
  const meanStars = pts.length ? pts.reduce((s, p) => s + p.stars, 0) / pts.length : 5;
  let b = -1.5;
  if (pts.length >= 8) {
    let num = 0;
    let den = 0;
    for (const p of pts) {
      num += (p.stars - meanStars) * (p.acc - meanAcc);
      den += (p.stars - meanStars) ** 2;
    }
    if (den > 0.01) b = clamp(num / den, -4, -0.3);
  }
  return { a: meanAcc - b * meanStars, b, meanAcc, meanStars, n: pts.length };
}

export class FarmService {
  constructor({ db, profile, ppService, api, getSettings, getSongsDir, events }) {
    this.db = db;
    this.profile = profile;
    this.pp = ppService;
    this.api = api;
    this.getSettings = getSettings;
    this.getSongsDir = getSongsDir;
    this.events = events;
    this.ppCache = new Map(); // md5|mods|acc -> pp
    this.running = false;
    this.last = null;
  }

  /** Анализ профиля по лучшим результатам. */
  analyze() {
    const mode = this.getSettings().mode ?? 0;
    const top = this.profile.topList();
    const rows = top.rows.filter((r) => (r.mode ?? 0) === mode);
    const plays = [];
    for (const r of rows) {
      const local = r.beatmap_md5 ? this.db.get('SELECT * FROM beatmaps WHERE md5 = ?', r.beatmap_md5) : null;
      const apiMap = r.beatmap_id ? this.db.get('SELECT * FROM api_beatmaps WHERE beatmap_id = ?', r.beatmap_id) : null;
      const combo = modsToString(difficultyMods(r.mods).filter((m) => ['HD', 'HR', 'DT'].includes(m)));
      let stars = r.stars;
      let eff = null;
      if (local) {
        eff = effectiveAttrs(local, r.mods);
        if (stars == null) stars = eff.stars;
      } else if (stars == null && apiMap?.stars && !/DT|NC|HR|EZ|HT/.test(r.mods)) stars = apiMap.stars;
      plays.push({
        pp: r.pp ?? r.pp_calc, acc: r.accuracy, stars, combo, mods: r.mods, md5: r.beatmap_md5, beatmapId: r.beatmap_id,
        bpm: eff?.bpm ?? (apiMap?.bpm ? apiMap.bpm * (r.rate || 1) : null),
        length: eff?.length ?? (apiMap?.length_drain ? apiMap.length_drain / (r.rate || 1) : null),
        ar: eff?.ar ?? null, misses: r.nmiss,
      });
    }
    const withStars = plays.filter((p) => p.stars != null);
    const top50 = withStars.slice(0, 50);
    const starsList = top50.map((p) => p.stars);
    const comboShare = {};
    for (const p of plays.slice(0, 100)) comboShare[comboName(p.combo)] = (comboShare[comboName(p.combo)] || 0) + 1;
    const n100 = Math.min(plays.length, 100) || 1;
    for (const k of Object.keys(comboShare)) comboShare[k] = comboShare[k] / n100;

    const feedback = this.feedback();
    const model = fitAccuracyModel(top50.map((p) => ({ stars: p.stars, acc: p.acc })));
    const pps = plays.map((p) => p.pp).filter((x) => x != null);
    return {
      source: top.source,
      plays: plays.length,
      withStars: withStars.length,
      topPp: pps[0] ?? null,
      entryPp: pps.length >= 100 ? pps[99] : 0, // ниже этого pp score не попадёт в топ-100
      medianPp: quantile(pps.slice(0, 50), 0.5),
      stars: {
        p25: quantile(starsList, 0.25), median: quantile(starsList, 0.5), p75: quantile(starsList, 0.75), p90: quantile(starsList, 0.9), max: starsList.length ? Math.max(...starsList) : null,
      },
      accuracy: { median: quantile(top50.map((p) => p.acc), 0.5), p25: quantile(top50.map((p) => p.acc), 0.25) },
      length: { median: quantile(plays.slice(0, 50).map((p) => p.length).filter(Boolean), 0.5) },
      bpm: { median: quantile(plays.slice(0, 50).map((p) => p.bpm).filter(Boolean), 0.5) },
      ar: { median: quantile(plays.slice(0, 50).map((p) => p.ar).filter(Boolean), 0.5) },
      comboShare,
      model: { ...model, bias: feedback.bias, biasSamples: feedback.samples },
      feedback,
    };
  }

  /** Сравнение рекомендаций с реальными результатами. */
  feedback() {
    const rows = this.db.all(
      `SELECT r.*, s.accuracy AS actual_acc, COALESCE(s.pp, s.pp_calc) AS actual_pp, s.played_at, s.passed,
              COALESCE(b.artist || ' - ' || b.title || ' [' || b.version || ']', ab.artist || ' - ' || ab.title || ' [' || ab.version || ']') AS title
       FROM farm_recommendations r
       JOIN scores s ON (s.beatmap_md5 = r.beatmap_md5 OR (r.beatmap_md5 IS NULL AND s.beatmap_id = r.beatmap_id))
                     AND s.saved_at >= r.created_at
       LEFT JOIN beatmaps b ON b.md5 = r.beatmap_md5
       LEFT JOIN api_beatmaps ab ON ab.beatmap_id = r.beatmap_id
       ORDER BY s.played_at DESC LIMIT 300`,
    );
    // Сравниваем только сыгранное с теми же модами, что рекомендовали.
    const matched = rows.filter((r) => {
      const s = this.db.get('SELECT mods FROM scores WHERE (beatmap_md5 = ? OR beatmap_id = ?) AND saved_at >= ? ORDER BY saved_at LIMIT 1', r.beatmap_md5, r.beatmap_id, r.created_at);
      return s && modsToString(difficultyMods(s.mods).filter((m) => ['HD', 'HR', 'DT'].includes(m))) === r.mods;
    });
    const seen = new Set();
    const uniq = matched.filter((r) => {
      const k = `${r.beatmap_md5}|${r.beatmap_id}|${r.mods}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
    const diffs = uniq.filter((r) => r.passed && r.predicted_acc != null).map((r) => r.actual_acc - r.predicted_acc);
    // Сглаживаем к нулю, пока данных мало.
    const bias = diffs.length ? (diffs.reduce((a, b) => a + b, 0) / diffs.length) * (diffs.length / (diffs.length + 3)) : 0;
    return {
      samples: diffs.length,
      bias: clamp(bias, -5, 3),
      items: uniq.slice(0, 30).map((r) => ({
        title: r.title, mods: comboName(r.mods), predicted_acc: r.predicted_acc, actual_acc: r.actual_acc,
        predicted_pp: r.predicted_pp, actual_pp: r.actual_pp, played_at: r.played_at, passed: !!r.passed,
      })),
    };
  }

  successProbability({ stars, length, md5, profile }) {
    const hi = profile.stars.p90 ?? profile.stars.max ?? 5;
    let p = sigmoid((hi + 0.15 - stars) / 0.3);
    if (length > 300) p *= 0.85;
    if (length > 420) p *= 0.85;
    let attemptsNote = null;
    if (md5) {
      const a = this.db.get("SELECT SUM(CASE WHEN outcome = 'fail' THEN 1 ELSE 0 END) AS fails, SUM(CASE WHEN outcome IN ('quit','retry') THEN 1 ELSE 0 END) AS quits, SUM(CASE WHEN outcome = 'pass' THEN 1 ELSE 0 END) AS passes FROM attempts WHERE beatmap_md5 = ?", md5);
      if (a && (a.fails || a.quits || a.passes)) {
        const penalty = 0.85 ** (a.fails || 0) * 0.95 ** Math.min(a.quits || 0, 10);
        p *= Math.max(0.35, penalty) * (a.passes ? 1.1 : 1);
        attemptsNote = { fails: a.fails || 0, quits: a.quits || 0, passes: a.passes || 0 };
      }
    }
    return { p: clamp(p, 0.02, 0.98), attemptsNote };
  }

  predictAcc(stars, profile) {
    const m = profile.model;
    const raw = m.a + m.b * stars + (m.bias || 0);
    const cap = Math.min(100, (profile.accuracy.median ?? 98) + 1.5);
    return clamp(raw, 80, cap);
  }

  ppAt(md5, map, combo, acc, misses, lazer) {
    const key = `${md5}|${combo}|${acc.toFixed(2)}|${misses}|${lazer ? 1 : 0}`;
    let v = this.ppCache.get(key);
    if (v === undefined) {
      v = calcPerformance(map, { mods: combo, accuracy: acc, misses, lazer }).pp;
      this.ppCache.set(key, v);
      if (this.ppCache.size > 50000) this.ppCache.clear();
    }
    return v;
  }

  explain({ profile, combo, stars, acc, pp, gain, length, p, attemptsNote, status, comboShare, position }) {
    const reasons = [];
    reasons.push(`Прогноз: ${pp.toFixed(0)}pp при ${acc.toFixed(2)}% → +${gain.toFixed(1)}pp к профилю${position ? ` (место #${position} в топе)` : ''}.`);
    const { p25, p90 } = profile.stars;
    if (p25 != null && p90 != null) {
      if (stars >= p25 && stars <= p90) reasons.push(`${stars.toFixed(2)}★ — в вашем рабочем диапазоне ${p25.toFixed(2)}–${p90.toFixed(2)}★.`);
      else if (stars > p90) reasons.push(`${stars.toFixed(2)}★ — выше привычного (${p90.toFixed(2)}★), шанс пасса ниже.`);
      else reasons.push(`${stars.toFixed(2)}★ — ниже привычного: проще, но и pp меньше.`);
    }
    if (combo) {
      const share = comboShare[combo] || 0;
      reasons.push(share > 0 ? `${combo}: ${Math.round(share * 100)}% ваших топ-скоров с этим набором модов.` : `${combo}: в топе таких scores пока нет — пробный вариант.`);
    }
    if (length) reasons.push(`Длина ${fmtLen(length)}${length <= 150 ? ' — короткая, быстро пробовать.' : length > 300 ? ' — длинная, ошибиться проще.' : '.'}`);
    reasons.push(`Оценка шанса сыграть на прогноз: ${Math.round(p * 100)}%.`);
    if (attemptsNote) reasons.push(`История: пассов ${attemptsNote.passes}, фейлов ${attemptsNote.fails}, выходов/рестартов ${attemptsNote.quits}.`);
    if (!status) reasons.push('Статус карты не проверен (подключите osu! API): pp дают только ranked/approved карты.');
    return reasons;
  }

  /** Рекомендации по локальным картам. */
  async recommendLocal({ limit = 50, combos, starsMin, starsMax, maxLength } = {}) {
    if (this.running) throw new Error('Расчёт Farm уже идёт');
    this.running = true;
    const started = Date.now();
    try {
      const settings = this.getSettings();
      const mode = settings.mode ?? 0;
      const lazer = settings.ppMode === 'lazer';
      const profile = this.analyze();
      if (profile.withStars < 5) {
        return { ok: false, profile, error: 'Мало данных для анализа: нужно хотя бы 5 лучших результатов со звёздами. Обновите профиль через osu! API или сыграйте несколько карт с запущенным Tosu.' };
      }
      const songsDir = this.getSongsDir();
      if (!songsDir) return { ok: false, profile, error: 'Папка Songs не задана — локальные рекомендации недоступны.' };

      const comboList = (combos?.length ? combos : COMBOS.filter((c) => c === '' || (profile.comboShare[comboName(c)] || 0) >= 0.05)).map((c) => (c === 'NM' ? '' : c));
      const lo = starsMin ?? Math.max(0, (profile.stars.p25 ?? 3) - 0.4);
      const hi = starsMax ?? (profile.stars.p90 ?? 6) + 0.5;
      const top = this.profile.topForMath();
      const bestByMap = new Map();
      for (const t of bestPerMap(top)) bestByMap.set(t.key, t.pp);
      const myBest = new Map();
      for (const s of this.db.all('SELECT beatmap_md5, MAX(COALESCE(pp, pp_calc)) AS pp FROM scores WHERE passed = 1 AND beatmap_md5 IS NOT NULL GROUP BY beatmap_md5')) myBest.set(s.beatmap_md5, s.pp);

      const rows = this.db.all('SELECT * FROM beatmaps WHERE missing = 0 AND mode = ? AND stars_nm IS NOT NULL', mode);
      // Первичный отбор по звёздам каждой комбинации модов.
      const pre = [];
      for (const r of rows) {
        if (r.status && !RANKED.has(r.status)) continue;
        for (const combo of comboList) {
          const eff = effectiveAttrs(r, combo);
          if (eff.stars == null || eff.stars < lo || eff.stars > hi) continue;
          if (maxLength && eff.length > maxLength) continue;
          // Грубая оценка до точного расчёта: близость к рабочему уровню.
          const center = profile.stars.p75 ?? profile.stars.median ?? eff.stars;
          pre.push({ r, combo, eff, h: -Math.abs(eff.stars - center) + (r.pp_nm_98 || 0) / 2000 });
        }
      }
      pre.sort((a, b) => b.h - a.h);
      const budget = pre.slice(0, 1500);
      const out = [];
      let t = Date.now();
      for (const c of budget) {
        const { r, combo, eff } = c;
        let map;
        try {
          map = getCachedBeatmap(`md5:${r.md5}`, () => readLocalOsu(songsDir, r));
        } catch {
          continue;
        }
        const acc = this.predictAcc(eff.stars, profile);
        const misses = eff.length > 240 ? 1 : 0;
        const pp = this.ppAt(r.md5, map, combo, acc, misses, lazer);
        const key = r.md5;
        const existing = Math.max(bestByMap.get(key) || 0, myBest.get(key) || 0);
        if (existing >= pp) continue;
        const g = projectGain(top, { key, pp });
        if (g.gain < 0.05) continue;
        const { p, attemptsNote } = this.successProbability({ stars: eff.stars, length: eff.length || 0, md5: r.md5, profile });
        const minutes = (r.length_total || eff.length || 120) / eff.rate / 60 + 0.5;
        const value = (g.gain * p) / Math.sqrt(minutes);
        out.push({
          kind: 'local', md5: r.md5, beatmap_id: r.beatmap_id, beatmapset_id: r.beatmapset_id,
          title: `${r.artist} - ${r.title} [${r.version}]`, creator: r.creator, status: r.status,
          mods: comboName(combo), stars: eff.stars, approxStars: eff.approxStars, ar: eff.ar, od: eff.od, cs: eff.cs, bpm: eff.bpm, length: eff.length,
          predictedAcc: acc, predictedPp: pp, existingPp: existing || null, gain: g.gain, position: g.position, probability: p, value,
          reasons: this.explain({ profile, combo, stars: eff.stars, acc, pp, gain: g.gain, length: eff.length, p, attemptsNote, status: r.status, comboShare: profile.comboShare, position: g.position }),
        });
        if (Date.now() - t > 30) {
          await yieldToLoop();
          t = Date.now();
        }
      }
      // Один лучший вариант модов на карту, остальные — как альтернативы.
      const byMap = new Map();
      for (const o of out.sort((a, b) => b.value - a.value)) {
        const prev = byMap.get(o.md5);
        if (!prev) byMap.set(o.md5, { ...o, alternatives: [] });
        else if (prev.alternatives.length < 3) prev.alternatives.push({ mods: o.mods, predictedPp: o.predictedPp, gain: o.gain, probability: o.probability, stars: o.stars });
      }
      const list = [...byMap.values()].slice(0, limit);
      const maxV = list[0]?.value || 1;
      for (const o of list) o.farmScore = Math.round((o.value / maxV) * 100);
      this.remember(list);
      this.last = { at: new Date().toISOString(), count: list.length };
      L.info(`Farm: ${rows.length} карт, ${pre.length} кандидатов, рассчитано ${budget.length}, рекомендаций ${list.length} за ${Date.now() - started} мс`);
      return { ok: true, profile, items: list, stats: { maps: rows.length, candidates: pre.length, calculated: budget.length, ms: Date.now() - started }, modsAdvice: this.modsAdvice(profile, out) };
    } finally {
      this.running = false;
    }
  }

  modsAdvice(profile, candidates) {
    const advice = [];
    const byCombo = {};
    for (const c of candidates) {
      const k = c.mods;
      byCombo[k] = byCombo[k] || { n: 0, gain: 0, p: 0 };
      byCombo[k].n++;
      byCombo[k].gain += c.gain;
      byCombo[k].p += c.probability;
    }
    const entries = Object.entries(byCombo).map(([k, v]) => ({ mods: k, count: v.n, avgGain: v.gain / v.n, avgP: v.p / v.n, share: profile.comboShare[k] || 0 }));
    entries.sort((a, b) => b.avgGain * b.avgP - a.avgGain * a.avgP);
    for (const e of entries) {
      advice.push({
        ...e,
        text: `${e.mods}: ${e.count} подходящих карт, в среднем +${e.avgGain.toFixed(1)}pp при шансе ${Math.round(e.avgP * 100)}%${e.share ? `; ${Math.round(e.share * 100)}% вашего топа` : ''}.`,
      });
    }
    return advice;
  }

  remember(list) {
    const now = new Date().toISOString();
    this.db.tx(() => {
      for (const o of list) {
        const mods = o.mods === 'NM' ? '' : o.mods;
        this.db.run(
          `INSERT INTO farm_recommendations (created_at, beatmap_md5, beatmap_id, mods, predicted_acc, predicted_pp, predicted_gain, farm_score)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(beatmap_md5, beatmap_id, mods) DO UPDATE SET predicted_acc = excluded.predicted_acc, predicted_pp = excluded.predicted_pp,
             predicted_gain = excluded.predicted_gain, farm_score = excluded.farm_score`,
          now, o.md5 ?? null, o.beatmap_id ?? null, mods, o.predictedAcc, o.predictedPp, o.gain, o.farmScore ?? null,
        );
      }
    });
  }

  /** Новые карты из каталога osu! (нужен API и интернет). */
  async recommendOnline({ limit = 20, combo = '', maxDownloads = 15 } = {}) {
    if (!this.api.configured()) return { ok: false, error: 'Для поиска новых карт подключите osu! API в настройках.' };
    const settings = this.getSettings();
    const lazer = settings.ppMode === 'lazer';
    const profile = this.analyze();
    if (profile.withStars < 5) return { ok: false, profile, error: 'Мало данных профиля для подбора карт.' };
    combo = combo === 'NM' ? '' : combo;
    // DT поднимает звёзды примерно в 1.35–1.45 раза — переводим рабочий диапазон в NM-звёзды для поиска.
    const factor = combo.includes('DT') ? 1.4 : combo.includes('HR') ? 1.08 : 1;
    const lo = ((profile.stars.median ?? 4) - 0.2) / factor;
    const hi = ((profile.stars.p90 ?? 6) + 0.3) / factor;
    const modeName = ['osu', 'taiko', 'fruits', 'mania'][settings.mode ?? 0];
    const sets = [];
    for (let page = 0; page < 3; page++) {
      const res = await this.api.searchBeatmapsets({ q: `stars>${lo.toFixed(2)} stars<${hi.toFixed(2)}`, m: settings.mode ?? 0, s: 'ranked', sort: 'plays_desc', cursor_string: page ? sets.cursor : undefined });
      if (!res?.beatmapsets?.length) break;
      sets.push(...res.beatmapsets);
      sets.cursor = res.cursor_string;
      if (!res.cursor_string) break;
    }
    const localSets = new Set(this.db.all('SELECT DISTINCT beatmapset_id FROM beatmaps WHERE missing = 0 AND beatmapset_id IS NOT NULL').map((r) => r.beatmapset_id));
    const top = this.profile.topForMath();
    const cands = [];
    for (const s of sets) {
      if (localSets.has(s.id)) continue;
      for (const b of s.beatmaps || []) {
        if (b.mode_int !== (settings.mode ?? 0)) continue;
        if (b.difficulty_rating < lo || b.difficulty_rating > hi) continue;
        cacheApiBeatmap(this.db, b, s);
        cands.push({ s, b });
      }
    }
    const center = ((profile.stars.p75 ?? profile.stars.median ?? 5) / factor);
    cands.sort((x, y) => Math.abs(x.b.difficulty_rating - center) - Math.abs(y.b.difficulty_rating - center));
    const out = [];
    let downloads = 0;
    for (const { s, b } of cands.slice(0, 80)) {
      let pp = null;
      let stars = b.difficulty_rating * factor;
      let exact = false;
      const acc = this.predictAcc(stars, profile);
      if (downloads < maxDownloads || this.ppCache.has(`dl:${b.id}`)) {
        try {
          const file = await this.pp.source.get({ beatmapId: b.id, md5: b.checksum, allowDownload: true });
          if (file?.source === 'download') downloads++;
          if (file) {
            const map = getCachedBeatmap(`md5:${file.md5}`, () => file.content);
            const r1 = calcPerformance(map, { mods: combo, accuracy: this.predictAcc(stars, profile), lazer });
            stars = r1.stars;
            pp = calcPerformance(map, { mods: combo, accuracy: this.predictAcc(stars, profile), lazer }).pp;
            exact = true;
            this.ppCache.set(`dl:${b.id}`, true);
          }
        } catch (e) {
          L.warn(`Farm online: ${e.message}`);
        }
      }
      if (pp == null) continue;
      const g = projectGain(top, { key: b.checksum || `bid:${b.id}`, pp });
      if (g.gain < 0.05) continue;
      const length = b.hit_length / (combo.includes('DT') ? 1.5 : 1);
      const { p } = this.successProbability({ stars, length, md5: b.checksum, profile });
      const value = (g.gain * p) / Math.sqrt(length / 60 + 0.5);
      out.push({
        kind: 'online', beatmap_id: b.id, beatmapset_id: s.id, md5: b.checksum,
        title: `${s.artist} - ${s.title} [${b.version}]`, creator: s.creator, status: b.status,
        mods: comboName(combo), stars, ar: b.ar, od: b.accuracy, cs: b.cs, bpm: b.bpm * (combo.includes('DT') ? 1.5 : 1), length,
        predictedAcc: this.predictAcc(stars, profile), predictedPp: pp, gain: g.gain, position: g.position, probability: p, value, exact,
        playcount: b.playcount, cover: s.covers?.card,
        reasons: this.explain({ profile, combo, stars, acc: this.predictAcc(stars, profile), pp, gain: g.gain, length, p, attemptsNote: null, status: b.status, comboShare: profile.comboShare, position: g.position }),
        links: {
          page: `https://osu.ppy.sh/beatmapsets/${s.id}#${modeName}/${b.id}`,
          download: `https://osu.ppy.sh/beatmapsets/${s.id}/download`,
          direct: `osu://s/${s.id}`,
          mirror: `https://catboy.best/d/${s.id}`,
        },
      });
    }
    out.sort((a, b) => b.value - a.value);
    const list = out.slice(0, limit);
    const maxV = list[0]?.value || 1;
    for (const o of list) o.farmScore = Math.round((o.value / maxV) * 100);
    this.remember(list);
    return { ok: true, profile, items: list, stats: { sets: sets.length, candidates: cands.length, downloads } };
  }
}

function readLocalOsu(songsDir, r) {
  return fs.readFileSync(path.join(songsDir, r.folder, r.file));
}
