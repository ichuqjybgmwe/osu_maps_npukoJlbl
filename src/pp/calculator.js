// Обёртка над rosu-pp (Rust → WASM): та же реализация расчёта сложности и pp,
// которой пользуются Tosu и многие боты. Мы ничего не считаем «на глаз».
import * as rosu from 'rosu-pp-js';
import { parseMods, modsToString } from './mods.js';

export const CALCULATOR_INFO = {
  name: 'rosu-pp-js',
  version: '4.0.1',
  notes: [
    'Формулы соответствуют актуальному на момент выпуска rosu-pp алгоритму osu!. Если ppy изменит формулу pp, значения разойдутся до обновления библиотеки.',
    'Режим stable (по умолчанию) считает как для score из osu!stable; режим lazer — как для score из lazer (другие правила точности слайдеров).',
    'pp зависит от точной версии .osu-файла: при отличии локальной версии карты от ранкнутой результат может не совпасть с сайтом.',
  ],
};

const MAX_CACHED_MAPS = 64;
const mapCache = new Map(); // key -> rosu.Beatmap

export function parseBeatmap(content) {
  const bytes = typeof content === 'string' ? new TextEncoder().encode(content) : content;
  return new rosu.Beatmap(bytes);
}

/** Карта с кэшем (ключ — md5 или путь). Возвращаемый объект нельзя освобождать вручную. */
export function getCachedBeatmap(key, loadContent) {
  let map = mapCache.get(key);
  if (map) {
    mapCache.delete(key);
    mapCache.set(key, map);
    return map;
  }
  map = parseBeatmap(loadContent());
  mapCache.set(key, map);
  if (mapCache.size > MAX_CACHED_MAPS) {
    const [oldKey, old] = mapCache.entries().next().value;
    mapCache.delete(oldKey);
    try { old.free(); } catch { /* ignore */ }
  }
  return map;
}

function commonArgs(o = {}) {
  const mods = parseMods(o.mods);
  const args = { mods: mods.length ? modsToString(mods) : 0, lazer: !!o.lazer };
  if (o.clockRate) args.clockRate = o.clockRate;
  if (o.ar != null) { args.ar = o.ar; args.fixedAr = !!o.fixedAr; }
  if (o.cs != null) { args.cs = o.cs; args.fixedCs = !!o.fixedCs; }
  if (o.od != null) { args.od = o.od; args.fixedOd = !!o.fixedOd; }
  if (o.hp != null) { args.hp = o.hp; args.fixedHp = !!o.fixedHp; }
  if (o.passedObjects != null) args.passedObjects = o.passedObjects;
  return args;
}

/** Сложность карты с модами. */
export function calcDifficulty(map, opts = {}) {
  const diff = new rosu.Difficulty(commonArgs(opts));
  try {
    const attrs = diff.calculate(map);
    const json = attrs.toJSON();
    attrs.free();
    return json;
  } finally {
    diff.free();
  }
}

/**
 * pp для конкретного состояния: accuracy или точные попадания, комбо, промахи.
 * Возвращает pp, разбивку и итоговые попадания, которые реально использовались.
 */
export function calcPerformance(map, opts = {}) {
  const args = commonArgs(opts);
  for (const k of ['accuracy', 'combo', 'n300', 'n100', 'n50', 'misses', 'nGeki', 'nKatu', 'largeTickHits', 'smallTickHits', 'sliderEndHits', 'legacyTotalScore']) {
    if (opts[k] != null && opts[k] !== '') args[k] = Number(opts[k]);
  }
  const perf = new rosu.Performance(args);
  try {
    const res = perf.calculate(map);
    const json = res.toJSON();
    res.free();
    return {
      pp: json.pp,
      ppAim: json.ppAim ?? null,
      ppSpeed: json.ppSpeed ?? null,
      ppAccuracy: json.ppAccuracy ?? null,
      ppFlashlight: json.ppFlashlight ?? null,
      ppDifficulty: json.ppDifficulty ?? null,
      effectiveMissCount: json.effectiveMissCount ?? null,
      stars: json.difficulty?.stars,
      maxCombo: json.difficulty?.maxCombo,
      state: json.state || null,
      difficulty: json.difficulty,
    };
  } finally {
    perf.free();
  }
}

/** Параметры карты (AR/OD/CS/HP) с учётом модов. */
export function calcMapAttributes(map, opts = {}) {
  // build() забирает builder себе (Rust self по значению) — освобождать его повторно нельзя.
  const a = new rosu.BeatmapAttributesBuilder({ map, ...commonArgs(opts) }).build();
  try {
    return a.toJSON();
  } finally {
    a.free();
  }
}

/** Сводка по карте для индекса: звёзды в популярных модах и pp NM. */
export function summarizeForIndex(map, { lazer = false } = {}) {
  const diff = new rosu.Difficulty({ lazer });
  const nm = diff.calculate(map);
  diff.free();
  const out = {
    stars_nm: nm.stars,
    aim_nm: nm.aim ?? null,
    speed_nm: nm.speed ?? null,
    max_combo: nm.maxCombo,
  };
  // pp считаем от готовых атрибутов сложности, чтобы не пересчитывать карту.
  for (const acc of [95, 98, 100]) {
    const perf = new rosu.Performance({ lazer, accuracy: acc });
    try {
      const r = perf.calculate(nm);
      out[`pp_nm_${acc}`] = r.pp;
      r.free();
    } catch {
      out[`pp_nm_${acc}`] = null;
    } finally {
      perf.free();
    }
  }
  nm.free();
  const variants = { stars_hr: 'HR', stars_dt: 'DT', stars_ez: 'EZ', stars_ht: 'HT' };
  for (const [k, mods] of Object.entries(variants)) {
    try { out[k] = calcDifficulty(map, { mods, lazer }).stars; } catch { out[k] = null; }
  }
  return out;
}

export function freeCache() {
  for (const m of mapCache.values()) { try { m.free(); } catch { /* ignore */ } }
  mapCache.clear();
}
