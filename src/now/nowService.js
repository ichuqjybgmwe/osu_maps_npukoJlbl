// «Сейчас в игре»: для карты, выбранной в osu! (меню или игра), с текущими модами
// считает pp по точности, FC, сколько нужно accuracy, чтобы побить свой скор и
// попасть в топ, и сколько это даст профилю. Пересчёт только при смене карты/модов.
import { calcPerformance, calcMapAttributes } from '../pp/calculator.js';
import { modsToString, modsRate } from '../pp/mods.js';
import { log } from '../logger.js';

const L = log('now');
const ACCS = [95, 96, 97, 98, 99, 100];

export class NowService {
  constructor({ db, ppService, profile, getSettings, events }) {
    this.db = db;
    this.pp = ppService;
    this.profile = profile;
    this.getSettings = getSettings;
    this.events = events;
    this.key = null;
    this.current = null;
    this.timer = null;
  }

  /** Вызывается на каждом кадре Tosu; считает только при смене карты/модов/правил. */
  onFrame(frame) {
    const b = frame?.beatmap;
    if (!b?.checksum) return;
    const modsSrc = frame.play?.mods?.array ?? frame.play?.mods?.name ?? frame.play?.mods?.number ?? '';
    const mods = modsToString(modsSrc);
    const lazer = frame.client === 'lazer' || this.getSettings().ppMode === 'lazer';
    const key = `${b.checksum}|${mods}|${lazer ? 1 : 0}`;
    if (key === this.key) return;
    this.key = key;
    const rate = frame.play?.mods?.rate || modsRate(modsSrc);
    // Пока игрок листает список песен, карты меняются каждые доли секунды — ждём паузу.
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      if (this.key !== key) return;
      this.compute({ frame, mods, lazer, rate, key })
        .then((res) => {
          if (this.key !== key || !res) return;
          this.current = res;
          this.events?.emit('nowpp', res);
        })
        .catch((e) => L.warn(`Расчёт для текущей карты: ${e.message}`));
    }, this.debounceMs ?? 250);
  }

  /** После нового score пересчитать цели (лучший скор и топ изменились). */
  invalidate() {
    this.key = null;
  }

  async compute({ frame, mods, lazer, rate, key }) {
    const b = frame.beatmap;
    const md5 = b.checksum;
    const loaded = await this.pp.loadMap({ md5, beatmapId: b.id > 0 ? b.id : undefined, allowDownload: true });
    const base = {
      key, md5, beatmapId: b.id > 0 ? b.id : null, setId: b.set > 0 ? b.set : null, mods, lazer,
      title: b.title, artist: b.artist, version: b.version, mapper: b.mapper, status: b.status?.name,
      local: !!this.db.get('SELECT 1 FROM beatmaps WHERE md5 = ? AND missing = 0', md5),
    };
    // Нет .osu (карта не в Songs и нет интернета) — берём таблицу pp, которую считает сам Tosu.
    if (!loaded) {
      const acc = frame.performance?.accuracy || {};
      return {
        ...base, source: 'tosu', exact: false,
        stars: b.stats?.stars?.total ?? null,
        attrs: { ar: b.stats?.ar?.converted, od: b.stats?.od?.converted, cs: b.stats?.cs?.converted, hp: b.stats?.hp?.converted },
        bpm: b.stats?.bpm?.common ?? null, maxCombo: b.stats?.maxCombo ?? null,
        table: ACCS.filter((a) => acc[a] != null).map((a) => ({ accuracy: a, pp: acc[a], gain: null })),
        targets: [],
      };
    }
    const { map, file } = loaded;
    const ss = calcPerformance(map, { mods, lazer, accuracy: 100 });
    const attrs = calcMapAttributes(map, { mods, lazer });
    const mapKey = md5;
    const best = this.db.get('SELECT MAX(COALESCE(pp, pp_calc)) AS pp, MAX(accuracy) AS acc FROM scores WHERE beatmap_md5 = ? AND passed = 1', md5);
    const top = this.profile.topForMath();
    const table = ACCS.map((a) => {
      const pp = a === 100 ? ss.pp : calcPerformance(map, { mods, lazer, accuracy: a }).pp;
      return { accuracy: a, pp, gain: top.length ? this.profile.projectGain(mapKey, pp).gain : null };
    });
    const ppAt = (acc) => calcPerformance(map, { mods, lazer, accuracy: acc }).pp;
    const targets = [];
    if (best?.pp) {
      targets.push({ id: 'beat', label: 'побить свой лучший скор', targetPp: best.pp, ...minAccuracy(ppAt, best.pp) });
    }
    if (top.length >= 100) {
      const sorted = top.map((t) => t.pp).sort((x, y) => y - x);
      const entry = sorted[Math.min(sorted.length, 100) - 1];
      targets.push({ id: 'top100', label: 'попасть в топ-100', targetPp: entry, ...minAccuracy(ppAt, Math.max(entry, best?.pp || 0)) });
    }
    if (top.length) {
      // Точность, при которой профиль вырастет хотя бы на 1pp и на 5pp.
      for (const g of [1, 5]) {
        const res = minAccuracy((acc) => this.profile.projectGain(mapKey, ppAt(acc)).gain, g);
        targets.push({ id: `gain${g}`, label: `+${g}pp к профилю`, targetPp: null, ...res });
      }
    }
    // Длина и BPM с учётом скорости.
    const row = file.row;
    return {
      ...base,
      source: file.source,
      exact: file.exactVersion,
      stars: ss.stars,
      maxCombo: ss.maxCombo,
      attrs: { ar: attrs.ar, od: attrs.od, cs: attrs.cs, hp: attrs.hp },
      bpm: row?.bpm_main ? row.bpm_main * rate : (b.stats?.bpm?.common ?? null),
      length: row?.length_drain ? Math.round(row.length_drain / rate) : null,
      breakdown: { aim: ss.ppAim, speed: ss.ppSpeed, accuracy: ss.ppAccuracy },
      myBest: best?.pp ? { pp: best.pp, accuracy: best.acc } : null,
      table,
      targets,
    };
  }
}

/**
 * Минимальная точность (без промахов), при которой value(acc) ≥ target.
 * value растёт вместе с точностью, поэтому бинарный поиск.
 */
export function minAccuracy(value, target) {
  if (value(100) < target) return { accuracy: null, reachable: false };
  let lo = 60;
  let hi = 100;
  if (value(lo) >= target) return { accuracy: lo, reachable: true };
  for (let i = 0; i < 18; i++) {
    const mid = (lo + hi) / 2;
    if (value(mid) >= target) hi = mid;
    else lo = mid;
  }
  return { accuracy: Math.ceil(hi * 100) / 100, reachable: true };
}
