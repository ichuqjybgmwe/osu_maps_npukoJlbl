// Математика профиля osu!: взвешенная сумма pp и прогноз прироста.
// Профильные pp = Σ pp_i · 0.95^i по лучшему score на каждой карте
// (отсортированы по убыванию) + бонус за количество ранкнутых scores.

export const WEIGHT = 0.95;

/** Лучший score на карту (по pp). items: [{ key, pp }] */
export function bestPerMap(items) {
  const best = new Map();
  for (const it of items) {
    if (it.pp == null || !(it.pp > 0)) continue;
    const prev = best.get(it.key);
    if (!prev || it.pp > prev.pp) best.set(it.key, it);
  }
  return [...best.values()].sort((a, b) => b.pp - a.pp);
}

export function weightedSum(sortedPps, limit = 200) {
  let total = 0;
  const n = Math.min(sortedPps.length, limit);
  for (let i = 0; i < n; i++) total += sortedPps[i] * WEIGHT ** i;
  return total;
}

/** Бонусные pp за количество ранкнутых scores (формула osu!). */
export function bonusPp(rankedScoreCount) {
  return (417 - 1 / 3) * (1 - 0.995 ** Math.min(rankedScoreCount, 1000));
}

/**
 * Сколько профильных pp даст новый score.
 * top: [{ key, pp }] — текущий список лучших (по одному на карту).
 * Если на этой карте уже есть score с большим pp — прирост 0.
 */
export function projectGain(top, candidate, limit = 200) {
  const before = bestPerMap(top);
  const beforeSum = weightedSum(before.map((x) => x.pp), limit);
  const after = bestPerMap([...before, candidate]);
  const afterSum = weightedSum(after.map((x) => x.pp), limit);
  const position = after.findIndex((x) => x === candidate);
  return {
    gain: Math.max(0, afterSum - beforeSum),
    position: position === -1 || position >= limit ? null : position + 1,
    before: beforeSum,
    after: afterSum,
  };
}

/**
 * Lifetime pp из снимков профиля: суммируем только реальные изменения
 * общего pp аккаунта, а не pp каждого нового score.
 */
export function lifetimeFromSnapshots(snapshots) {
  const pts = snapshots.filter((s) => s.pp != null).sort((a, b) => (a.taken_at < b.taken_at ? -1 : 1));
  if (!pts.length) return { first: null, current: null, gained: 0, lost: 0, net: 0, history: [] };
  let gained = 0;
  let lost = 0;
  for (let i = 1; i < pts.length; i++) {
    const d = pts[i].pp - pts[i - 1].pp;
    if (d > 0) gained += d;
    else lost += -d;
  }
  return {
    first: pts[0].pp,
    firstAt: pts[0].taken_at,
    current: pts[pts.length - 1].pp,
    currentAt: pts[pts.length - 1].taken_at,
    gained,
    lost,
    net: pts[pts.length - 1].pp - pts[0].pp,
    history: pts.map((p) => ({ t: p.taken_at, pp: p.pp, rank: p.global_rank })),
  };
}
