// Расчёт pp для калькулятора, scores и Farm, с оценкой достоверности.
import { getCachedBeatmap, calcPerformance, calcDifficulty, calcMapAttributes, CALCULATOR_INFO } from './calculator.js';
import { parseMods, modsToString } from './mods.js';

export class PpService {
  constructor({ source, getSettings }) {
    this.source = source;
    this.getSettings = getSettings;
  }

  defaultLazer() {
    return this.getSettings().ppMode === 'lazer';
  }

  async loadMap({ md5, beatmapId, allowDownload = true }) {
    const file = await this.source.get({ md5, beatmapId, allowDownload });
    if (!file) return null;
    const map = getCachedBeatmap(`md5:${file.md5}`, () => file.content);
    return { map, file };
  }

  /** pp конкретного сохранённого score по его точным попаданиям. */
  async ppForScore(row) {
    const loaded = await this.loadMap({ md5: row.beatmap_md5, beatmapId: row.beatmap_id, allowDownload: true });
    if (!loaded) return null;
    if (row.beatmap_md5 && loaded.file.md5 !== row.beatmap_md5) return null; // другая версия карты — не выдумываем
    const opts = {
      mods: row.mods,
      lazer: !!row.lazer,
      combo: row.max_combo,
      n300: row.n300, n100: row.n100, n50: row.n50, misses: row.nmiss, nGeki: row.ngeki, nKatu: row.nkatu,
    };
    if (row.lazer && row.slider_end_hits != null) opts.sliderEndHits = row.slider_end_hits;
    if (row.lazer && row.large_tick_hits != null) opts.largeTickHits = row.large_tick_hits;
    if (row.lazer && row.small_tick_hits != null) opts.smallTickHits = row.small_tick_hits;
    if (row.rate && Math.abs(row.rate - 1) > 1e-6 && ![1.5, 0.75].includes(row.rate)) opts.clockRate = row.rate;
    if (!row.passed) {
      opts.passedObjects = row.n300 + row.n100 + row.n50 + row.nmiss;
    }
    const cur = calcPerformance(loaded.map, opts);
    const fc = calcPerformance(loaded.map, { mods: row.mods, lazer: !!row.lazer, accuracy: row.accuracy, misses: 0 });
    return { pp: cur.pp, ppFc: fc.pp, stars: cur.stars };
  }

  /**
   * Калькулятор: один или несколько сценариев на одной карте.
   * scenario: { mods, accuracy, combo, misses, n100, n50, lazer, clockRate, ar, od, cs, hp }
   */
  async calculate({ md5, beatmapId, scenarios, allowDownload = true }) {
    const loaded = await this.loadMap({ md5, beatmapId, allowDownload });
    if (!loaded) {
      return {
        ok: false,
        error: beatmapId || md5
          ? 'Не удалось получить .osu-файл: карты нет в Songs, а скачать её не получилось (нет интернета или неизвестен ID карты).'
          : 'Укажите карту: md5 из индекса или ID карты на osu.ppy.sh.',
      };
    }
    const { map, file } = loaded;
    const confidence = assessConfidence(file, md5);
    const results = [];
    for (const sc of scenarios?.length ? scenarios : [{}]) {
      const lazer = sc.lazer ?? this.defaultLazer();
      const mods = modsToString(sc.mods);
      const base = { mods, lazer, clockRate: sc.clockRate || undefined, ar: num(sc.ar), od: num(sc.od), cs: num(sc.cs), hp: num(sc.hp) };
      const usesExactHits = sc.n100 != null || sc.n50 != null;
      const perfOpts = {
        ...base,
        accuracy: usesExactHits ? undefined : num(sc.accuracy) ?? 100,
        combo: num(sc.combo),
        misses: num(sc.misses) ?? 0,
        n100: num(sc.n100),
        n50: num(sc.n50),
      };
      const cur = calcPerformance(map, perfOpts);
      const fc = calcPerformance(map, { ...base, accuracy: accuracyOf(cur.state, map.mode) ?? perfOpts.accuracy, misses: 0 });
      const ss = calcPerformance(map, { ...base, accuracy: 100 });
      const attrs = calcMapAttributes(map, base);
      const scenarioNotes = [];
      if (!usesExactHits) scenarioNotes.push('Попадания (100/50) подобраны под заданную точность — реальный score с той же точностью может дать немного другое pp.');
      if (perfOpts.combo != null && perfOpts.combo < cur.maxCombo && (perfOpts.misses || 0) === 0) scenarioNotes.push('Комбо меньше максимального без промахов — считается как слайдербрейки.');
      if (parseMods(mods).some((m) => !['NF', 'EZ', 'HD', 'HR', 'DT', 'NC', 'HT', 'FL', 'SO', 'SD', 'PF', 'TD', 'CL'].includes(m))) {
        scenarioNotes.push('Некоторые выбранные моды не учитываются в pp или делают score нерейтинговым.');
      }
      results.push({
        input: { ...sc, mods, lazer },
        pp: cur.pp,
        ppFc: fc.pp,
        ppSs: ss.pp,
        breakdown: { aim: cur.ppAim, speed: cur.ppSpeed, accuracy: cur.ppAccuracy, flashlight: cur.ppFlashlight, difficulty: cur.ppDifficulty, effectiveMissCount: cur.effectiveMissCount },
        stars: cur.stars,
        maxCombo: cur.maxCombo,
        state: cur.state,
        accuracy: accuracyOf(cur.state, map.mode),
        attributes: { ar: attrs.ar, od: attrs.od, cs: attrs.cs, hp: attrs.hp, clockRate: attrs.clockRate },
        notes: scenarioNotes,
      });
    }
    const row = file.row;
    return {
      ok: true,
      beatmap: {
        md5: file.md5,
        beatmap_id: row?.beatmap_id ?? beatmapId ?? null,
        title: row ? `${row.artist} - ${row.title} [${row.version}]` : null,
        mode: map.mode,
        nObjects: map.nObjects,
      },
      fileSource: file.source,
      confidence,
      calculator: CALCULATOR_INFO,
      results,
    };
  }

  /** Быстрая таблица pp по точностям — для страницы карты. */
  async ppTable({ md5, beatmapId, mods = '', accs = [95, 97, 98, 99, 100] }) {
    const loaded = await this.loadMap({ md5, beatmapId, allowDownload: false });
    if (!loaded) return null;
    const lazer = this.defaultLazer();
    const diff = calcDifficulty(loaded.map, { mods, lazer });
    return {
      stars: diff.stars,
      maxCombo: diff.maxCombo,
      rows: accs.map((a) => ({ accuracy: a, pp: calcPerformance(loaded.map, { mods, lazer, accuracy: a }).pp })),
    };
  }
}

function num(v) {
  if (v === '' || v == null) return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

/** Точность по итоговым попаданиям (osu!standard). */
function accuracyOf(state, mode) {
  if (!state) return undefined;
  const { n300 = 0, n100 = 0, n50 = 0, misses = 0 } = state;
  const total = n300 + n100 + n50 + misses;
  if (!total) return undefined;
  if (mode === 0) return ((300 * n300 + 100 * n100 + 50 * n50) / (300 * total)) * 100;
  return undefined;
}

export function assessConfidence(file, requestedMd5) {
  const notes = [];
  let level = 'high';
  if (file.source === 'local') notes.push('Используется .osu из вашей папки Songs.');
  if (file.source === 'cache' || file.source === 'download') notes.push('Используется .osu, скачанный с osu.ppy.sh (текущая версия карты).');
  if (requestedMd5 && !file.exactVersion) {
    level = 'low';
    notes.push('Версия файла отличается от той, на которой был сыгран score (md5 не совпадает) — pp может не совпасть.');
  } else if (!requestedMd5 && file.source !== 'local') {
    level = 'medium';
    notes.push('Версию карты сверить не с чем: если карту обновляли после ранка, значение может отличаться.');
  }
  return { level, notes };
}
