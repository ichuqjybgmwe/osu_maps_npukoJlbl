// Модульные тесты: моды, парсер .osu, математика pp, поиск, калькулятор.
import { test } from 'node:test';
import path from 'node:path';
import assert from 'node:assert/strict';
import { parseMods, modsToString, modsToBits, modsRate, difficultyMods } from '../src/pp/mods.js';
import { parseOsuFile } from '../src/songs/osuParser.js';
import { bestPerMap, weightedSum, projectGain, lifetimeFromSnapshots, bonusPp } from '../src/profile/ppMath.js';
import { parseQuery, effectiveAttrs } from '../src/explorer/search.js';
import { parseBeatmap, calcPerformance, calcDifficulty, summarizeForIndex } from '../src/pp/calculator.js';
import { fitAccuracyModel } from '../src/farm/farm.js';
import { resolveDataDir } from '../src/paths.js';
import { makeOsu } from './helpers.js';

test('моды: разные форматы приводятся к одному виду', () => {
  assert.equal(modsToString('DTHD'), 'HDDT');
  assert.equal(modsToString(72), 'HDDT');
  assert.equal(modsToString([{ acronym: 'HR' }, { acronym: 'HD' }, { acronym: 'CL' }]), 'HDHR', 'CL игнорируется');
  assert.equal(modsToString(['HD', 'DT']), 'HDDT');
  assert.equal(modsToString({ name: 'HDHR', number: 24 }), 'HDHR');
  assert.equal(modsToString('NM'), '');
  assert.equal(modsToString(576), 'NC', 'NC без дубля DT');
  assert.equal(modsToBits('HDNC'), 8 | 64 | 512);
  assert.equal(modsRate('DT'), 1.5);
  assert.equal(modsRate('HT'), 0.75);
  assert.equal(modsRate([{ acronym: 'DT', settings: { speed_change: 1.3 } }]), 1.3);
  assert.deepEqual(difficultyMods('HDNCSD'), ['HD', 'DT']);
  assert.deepEqual(parseMods(null), []);
});

test('парсер .osu: метаданные, BPM, длина, объекты', () => {
  const text = makeOsu({ title: 'Alpha', artist: 'Beta', bpm: 200, objects: 100, ar: 9.3, beatmapId: 42, setId: 7 });
  const m = parseOsuFile(text);
  assert.equal(m.title, 'Alpha');
  assert.equal(m.artist, 'Beta');
  assert.equal(m.beatmapId, 42);
  assert.equal(m.beatmapSetId, 7);
  assert.equal(m.ar, 9.3);
  assert.equal(m.nCircles, 100);
  assert.equal(Math.round(m.bpmMain), 200);
  // 100 объектов через 1/2 бита при 200 BPM = 99 * 150 мс ≈ 15 с
  assert.equal(m.lengthDrain, 15);
});

test('парсер .osu: старый формат без AR берёт OD', () => {
  const text = makeOsu({ od: 7 }).replace(/ApproachRate:.*\r\n/, '').replace('osu file format v14', 'osu file format v5');
  assert.equal(parseOsuFile(text).ar, 7);
});

test('pp профиля: взвешенная сумма и лучший score на карту', () => {
  const top = bestPerMap([
    { key: 'a', pp: 300 }, { key: 'a', pp: 250 }, { key: 'b', pp: 200 }, { key: 'c', pp: 100 },
  ]);
  assert.deepEqual(top.map((t) => t.pp), [300, 200, 100]);
  assert.equal(weightedSum([300, 200, 100]), 300 + 200 * 0.95 + 100 * 0.95 ** 2);
  assert.ok(Math.abs(bonusPp(1000) - 413.9) < 0.1, 'бонус ≈ 416.67·(1−0.995^1000)');
});

test('прирост профиля: хуже прежнего на той же карте — 0, новый топ — положительный', () => {
  const top = [{ key: 'a', pp: 300 }, { key: 'b', pp: 200 }, { key: 'c', pp: 100 }];
  assert.equal(projectGain(top, { key: 'a', pp: 250 }).gain, 0, 'хуже прежнего на карте a');
  const g = projectGain(top, { key: 'd', pp: 250 });
  assert.equal(g.position, 2);
  assert.ok(g.gain > 0 && g.gain < 250, 'прирост меньше pp самого score');
  // прирост = 250*0.95 + (200*0.95^2 - 200*0.95) + (100*0.95^3 - 100*0.95^2)
  const expected = 250 * 0.95 + 200 * (0.95 ** 2 - 0.95) + 100 * (0.95 ** 3 - 0.95 ** 2);
  assert.ok(Math.abs(g.gain - expected) < 1e-9);
});

test('прирост профиля: score ниже 200-го места не даёт pp', () => {
  const top = Array.from({ length: 200 }, (_, i) => ({ key: `m${i}`, pp: 500 - i }));
  assert.equal(projectGain(top, { key: 'new', pp: 1 }).gain, 0);
});

test('lifetime pp: считается по изменениям профиля, а не суммой pp scores', () => {
  const lt = lifetimeFromSnapshots([
    { taken_at: '2026-01-01T00:00:00Z', pp: 5000 },
    { taken_at: '2026-01-02T00:00:00Z', pp: 5010 },
    { taken_at: '2026-01-03T00:00:00Z', pp: 5010 }, // сыграл 10 scores по 200pp, но в топ не попал
    { taken_at: '2026-01-04T00:00:00Z', pp: 4990 }, // реворк
    { taken_at: '2026-01-05T00:00:00Z', pp: 5025.5 },
  ]);
  assert.equal(lt.gained, 10 + 35.5);
  assert.equal(lt.lost, 20);
  assert.equal(lt.net, 25.5);
  assert.equal(lifetimeFromSnapshots([]).gained, 0);
});

test('поиск: разбор запроса в стиле osu!', () => {
  const q = parseQuery('camellia stars>=6.5 ar>9 length<3:00 bpm<=200 mode=osu played=no "big song"');
  assert.equal(q.text, 'camellia big song');
  const f = Object.fromEntries(q.filters.map((x) => [x.key, x]));
  assert.deepEqual(f.stars, { key: 'stars', op: '>=', value: 6.5 });
  assert.equal(f.length.value, 180);
  assert.equal(f.mode.value, 0);
  assert.equal(f.played.value, 0);
  assert.equal(f.bpm.op, '<=');
});

test('поиск: эффективные параметры с модами', () => {
  const row = { ar: 9, od: 8, cs: 4, hp: 6, bpm_main: 200, length_drain: 120, stars_nm: 5, stars_dt: 7, stars_hr: 5.4, stars_ez: 4, stars_ht: 4.2 };
  const dt = effectiveAttrs(row, 'DT');
  assert.equal(dt.bpm, 300);
  assert.equal(dt.length, 80);
  assert.equal(dt.stars, 7);
  assert.equal(dt.ar, 10.33);
  const hr = effectiveAttrs(row, 'HR');
  assert.equal(hr.ar, 10);
  assert.equal(hr.cs, 5.2);
  assert.equal(hr.stars, 5.4);
  assert.equal(effectiveAttrs(row, 'HRDT').approxStars, true);
});

test('калькулятор rosu-pp: моды и точность влияют на pp правильно', () => {
  const map = parseBeatmap(makeOsu({ objects: 400, bpm: 200, spacing: 150 }));
  const nm = calcDifficulty(map, {});
  const dt = calcDifficulty(map, { mods: 'DT' });
  assert.ok(nm.stars > 1, `звёзды NM = ${nm.stars}`);
  assert.ok(dt.stars > nm.stars, 'DT сложнее NM');
  const ss = calcPerformance(map, { accuracy: 100 });
  const a95 = calcPerformance(map, { accuracy: 95 });
  const miss = calcPerformance(map, { accuracy: 100, misses: 5 });
  const hd = calcPerformance(map, { accuracy: 100, mods: 'HD' });
  assert.ok(ss.pp > a95.pp, 'точность снижает pp');
  assert.ok(ss.pp > miss.pp, 'промахи снижают pp');
  assert.ok(hd.pp > ss.pp, 'HD добавляет pp');
  assert.equal(ss.state.misses, 0);
  const sum = summarizeForIndex(map);
  assert.ok(sum.stars_dt > sum.stars_nm && sum.pp_nm_100 > sum.pp_nm_95);
  map.free();
});

test('Farm: модель точности падает со звёздами', () => {
  const pts = Array.from({ length: 20 }, (_, i) => ({ stars: 4 + i * 0.1, acc: 99 - i * 0.2 }));
  const m = fitAccuracyModel(pts);
  assert.ok(m.b < 0);
  assert.ok(Math.abs(m.a + m.b * 5 - 97) < 0.01);
  assert.equal(fitAccuracyModel([]).b, -1.5, 'без данных — запасной наклон');
});

test('папка данных: переменная окружения и платформы', () => {
  assert.equal(resolveDataDir({ MAPVAULT_DATA: '/x/y' }, 'linux'), path.resolve('/x/y'));
  assert.match(resolveDataDir({ APPDATA: 'C:\\Users\\a\\AppData\\Roaming' }, 'win32'), /MapVault$/);
});
