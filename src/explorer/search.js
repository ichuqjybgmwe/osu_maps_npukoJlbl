// Поиск по локальному индексу карт.
// Текст ищется через FTS5 (название, артист, маппер, сложность, теги, источник),
// числовые фильтры поддерживают синтаксис osu!: "ar>9 stars>=6 bpm<200 length<3:00".
// С выбранными модами фильтры и сортировка работают по эффективным значениям
// (DT ускоряет BPM и длину, HR поднимает AR/OD/CS и т.д.).
import { parseMods } from '../pp/mods.js';

const KEY_ALIASES = {
  star: 'stars', stars: 'stars', sr: 'stars',
  ar: 'ar', od: 'od', cs: 'cs', hp: 'hp',
  bpm: 'bpm', length: 'length', len: 'length', drain: 'length',
  combo: 'combo', objects: 'objects',
  pp: 'pp', pp98: 'pp', pp95: 'pp95', pp100: 'pp100',
  mode: 'mode', m: 'mode',
  status: 'status', s: 'status',
  played: 'played', plays: 'played', attempts: 'attempts',
  creator: 'creator', mapper: 'creator', artist: 'artist', title: 'title', diff: 'version', version: 'version',
  acc: 'myacc', myacc: 'myacc', mypp: 'mypp', rank: 'myrank',
  id: 'id', set: 'set',
};
const MODE_NAMES = { osu: 0, std: 0, standard: 0, taiko: 1, catch: 2, fruits: 2, ctb: 2, mania: 3 };
const TEXT_KEYS = new Set(['creator', 'artist', 'title', 'version', 'status', 'myrank']);
const FILTER_RE = /^([a-z0-9]+)(<=|>=|!=|=|<|>|:)(.+)$/i;

function parseValue(key, raw) {
  const v = raw.replace(/^"|"$/g, '');
  if (key === 'length') {
    const m = /^(\d+):(\d{1,2})$/.exec(v);
    if (m) return Number(m[1]) * 60 + Number(m[2]);
    const s = /^(\d+(?:\.\d+)?)(s|m)?$/.exec(v);
    if (s) return s[2] === 'm' ? Number(s[1]) * 60 : Number(s[1]);
    return NaN;
  }
  if (key === 'mode') return MODE_NAMES[v.toLowerCase()] ?? Number(v);
  if (key === 'played') {
    if (/^(yes|y|true|1)$/i.test(v)) return 1;
    if (/^(no|n|false|0)$/i.test(v)) return 0;
    return Number(v);
  }
  if (TEXT_KEYS.has(key)) return v.toLowerCase();
  return Number(v);
}

/** Разобрать строку запроса на текст и фильтры. */
export function parseQuery(q) {
  const filters = [];
  const words = [];
  const tokens = String(q || '').match(/(?:[^\s"]+|"[^"]*")+/g) || [];
  for (const t of tokens) {
    const m = FILTER_RE.exec(t);
    const key = m && KEY_ALIASES[m[1].toLowerCase()];
    if (m && key) {
      const op = m[2] === ':' ? '=' : m[2];
      const value = parseValue(key, m[3]);
      if (typeof value === 'number' && Number.isNaN(value)) continue;
      filters.push({ key, op, value });
    } else {
      words.push(t.replace(/"/g, ''));
    }
  }
  return { text: words.join(' ').trim(), filters };
}

function ftsQuery(text) {
  // Каждое слово — префиксный поиск; спецсимволы FTS экранируем кавычками.
  return text
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => `"${w.replace(/"/g, '""')}"*`)
    .join(' ');
}

// --- эффективные параметры с учётом модов ---
const arToMs = (ar) => (ar <= 5 ? 1800 - 120 * ar : 1200 - 150 * (ar - 5));
const msToAr = (ms) => (ms > 1200 ? (1800 - ms) / 120 : 5 + (1200 - ms) / 150);
const odToMs = (od) => 80 - 6 * od;
const msToOd = (ms) => (80 - ms) / 6;

export function effectiveAttrs(row, mods) {
  const ms = parseMods(mods);
  const has = (m) => ms.includes(m);
  let { ar, od, cs, hp } = row;
  let mult = 1;
  if (has('HR')) mult = 1.4;
  if (has('EZ')) mult = 0.5;
  ar = Math.min(10, ar * mult);
  od = Math.min(10, od * mult);
  hp = Math.min(10, hp * mult);
  cs = has('HR') ? Math.min(10, cs * 1.3) : has('EZ') ? cs * 0.5 : cs;
  const rate = has('DT') || has('NC') ? 1.5 : has('HT') || has('DC') ? 0.75 : 1;
  if (rate !== 1) {
    ar = msToAr(arToMs(ar) / rate);
    od = msToOd(odToMs(od) / rate);
  }
  let stars = row.stars_nm;
  if (has('DT') || has('NC')) stars = row.stars_dt ?? stars;
  else if (has('HT')) stars = row.stars_ht ?? stars;
  if (has('HR') && !(has('DT') || has('NC'))) stars = row.stars_hr ?? stars;
  if (has('EZ') && !(has('DT') || has('NC'))) stars = row.stars_ez ?? stars;
  // Для комбинаций (например HRDT) точных звёзд в индексе нет — помечаем как приближение.
  const approxStars = (has('HR') || has('EZ')) && rate !== 1;
  return {
    ar: round2(ar), od: round2(od), cs: round2(cs), hp: round2(hp),
    bpm: row.bpm_main != null ? round2(row.bpm_main * rate) : null,
    length: row.length_drain != null ? Math.round(row.length_drain / rate) : null,
    stars, approxStars, rate,
  };
}

const round2 = (x) => (x == null ? x : Math.round(x * 100) / 100);

function cmp(a, op, b) {
  if (a == null) return false;
  if (typeof b === 'string') {
    const s = String(a).toLowerCase();
    return op === '!=' ? !s.includes(b) : s.includes(b);
  }
  switch (op) {
    case '<': return a < b;
    case '<=': return a <= b;
    case '>': return a > b;
    case '>=': return a >= b;
    case '!=': return Math.abs(a - b) > 0.005;
    // "=" для дробных, как в osu!: ar=9 совпадает с 8.95..9.05
    default: return Math.abs(a - b) < 0.05;
  }
}

const SORTS = {
  stars: (r) => r.eff.stars,
  pp: (r) => r.pp_nm_98,
  bpm: (r) => r.eff.bpm,
  length: (r) => r.eff.length,
  ar: (r) => r.eff.ar,
  od: (r) => r.eff.od,
  cs: (r) => r.eff.cs,
  title: (r) => (r.title || '').toLowerCase(),
  artist: (r) => (r.artist || '').toLowerCase(),
  creator: (r) => (r.creator || '').toLowerCase(),
  added: (r) => r.file_mtime,
  plays: (r) => r.my?.count ?? 0,
  mypp: (r) => r.my?.best_pp ?? -1,
  myacc: (r) => r.my?.best_acc ?? -1,
  lastplayed: (r) => r.my?.last_played ?? '',
  relevance: (r) => -(r.rank ?? 0),
};

export function searchBeatmaps(db, { q = '', mods = '', sort = 'relevance', order, limit = 50, offset = 0, mode } = {}) {
  const { text, filters } = parseQuery(q);
  const params = [];
  let sql;
  if (text) {
    sql = `SELECT b.*, f.rank AS rank FROM beatmaps_fts f JOIN beatmaps b ON b.md5 = f.md5 WHERE beatmaps_fts MATCH ? AND b.missing = 0`;
    params.push(ftsQuery(text));
  } else {
    sql = 'SELECT b.*, 0 AS rank FROM beatmaps b WHERE b.missing = 0';
  }
  if (mode != null && mode !== '') {
    sql += ' AND b.mode = ?';
    params.push(Number(mode));
  }
  let rows;
  try {
    rows = db.all(sql, ...params);
  } catch (e) {
    throw new Error(`Некорректный поисковый запрос: ${e.message}`);
  }

  // Мои результаты и попытки по картам — одним запросом.
  const mine = new Map();
  for (const s of db.all(
    `SELECT beatmap_md5 AS md5, COUNT(*) AS count, MAX(COALESCE(pp, pp_calc)) AS best_pp, MAX(accuracy) AS best_acc, MAX(played_at) AS last_played,
            MIN(CASE rank WHEN 'XH' THEN 1 WHEN 'X' THEN 2 WHEN 'SH' THEN 3 WHEN 'S' THEN 4 WHEN 'A' THEN 5 WHEN 'B' THEN 6 WHEN 'C' THEN 7 WHEN 'D' THEN 8 ELSE 9 END) AS best_rank_n
     FROM scores WHERE beatmap_md5 IS NOT NULL GROUP BY beatmap_md5`,
  )) mine.set(s.md5, s);
  const attempts = new Map();
  for (const a of db.all('SELECT beatmap_md5 AS md5, COUNT(*) AS n FROM attempts WHERE beatmap_md5 IS NOT NULL GROUP BY beatmap_md5')) attempts.set(a.md5, a.n);
  const RANKS = [null, 'XH', 'X', 'SH', 'S', 'A', 'B', 'C', 'D', null];

  const out = [];
  for (const r of rows) {
    r.eff = effectiveAttrs(r, mods);
    const my = mine.get(r.md5);
    r.my = my ? { count: my.count, best_pp: my.best_pp, best_acc: my.best_acc, last_played: my.last_played, best_rank: RANKS[my.best_rank_n] } : null;
    r.attempts = attempts.get(r.md5) || 0;
    let ok = true;
    for (const f of filters) {
      const v = {
        stars: r.eff.stars, ar: r.eff.ar, od: r.eff.od, cs: r.eff.cs, hp: r.eff.hp, bpm: r.eff.bpm, length: r.eff.length,
        combo: r.max_combo, objects: (r.n_circles || 0) + (r.n_sliders || 0) + (r.n_spinners || 0),
        pp: r.pp_nm_98, pp95: r.pp_nm_95, pp100: r.pp_nm_100, mode: r.mode, status: r.status || 'unknown',
        played: r.my ? 1 : 0, attempts: r.attempts,
        creator: r.creator, artist: `${r.artist} ${r.artist_unicode || ''}`, title: `${r.title} ${r.title_unicode || ''}`, version: r.version,
        myacc: r.my?.best_acc, mypp: r.my?.best_pp, myrank: r.my?.best_rank, id: r.beatmap_id, set: r.beatmapset_id,
      }[f.key];
      if (f.key === 'played' && f.op === '=') ok = ok && v === f.value;
      else ok = ok && cmp(v, f.op, f.value);
      if (!ok) break;
    }
    if (ok) out.push(r);
  }

  const key = SORTS[sort] ? sort : 'relevance';
  const dir = order === 'asc' ? 1 : order === 'desc' ? -1 : ['title', 'artist', 'creator', 'relevance'].includes(key) ? 1 : -1;
  const getter = SORTS[key];
  out.sort((a, b) => {
    const x = getter(a);
    const y = getter(b);
    if (x == null && y == null) return 0;
    if (x == null) return 1;
    if (y == null) return -1;
    return x < y ? -dir : x > y ? dir : 0;
  });

  const page = out.slice(Number(offset), Number(offset) + Number(limit)).map(slim);
  return { total: out.length, offset: Number(offset), limit: Number(limit), filters, text, items: page };
}

function slim(r) {
  return {
    md5: r.md5, beatmap_id: r.beatmap_id, beatmapset_id: r.beatmapset_id, mode: r.mode,
    title: r.title, title_unicode: r.title_unicode, artist: r.artist, creator: r.creator, version: r.version,
    status: r.status, ar: r.ar, od: r.od, cs: r.cs, hp: r.hp, bpm: r.bpm_main, length: r.length_drain,
    max_combo: r.max_combo, stars_nm: r.stars_nm, pp_nm_95: r.pp_nm_95, pp_nm_98: r.pp_nm_98, pp_nm_100: r.pp_nm_100,
    eff: r.eff, my: r.my, attempts: r.attempts, calc_error: r.calc_error,
  };
}
