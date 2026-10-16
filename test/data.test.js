// Трекер Tosu, сохранение scores с дедупликацией, индексатор Songs, поиск.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { TosuTracker, normalizeTosuResult } from '../src/integrations/tosuTracker.js';
import { ScoreService, normalizeApiScore, dedupKey } from '../src/scores/scoreService.js';
import { openDatabase } from '../src/db/index.js';
import { SongsIndexer } from '../src/songs/indexer.js';
import { searchBeatmaps } from '../src/explorer/search.js';
import { makeSongs, tmpDir } from './helpers.js';
import { tosuFrame, playFrame, resultFrame } from './tosuFrames.js';

const MAP = { checksum: 'a'.repeat(32), id: 77, set: 7, artist: 'A', title: 'T', version: 'V', first: 1000, last: 61000, objects: 400 };

function collect(tracker) {
  const ev = { attempts: [], results: [], ignored: [] };
  tracker.on('attempt', (a) => ev.attempts.push(a));
  tracker.on('result', (r) => ev.results.push(r));
  tracker.on('ignoredResult', (r) => ev.ignored.push(r));
  return ev;
}

test('трекер: фейл, рестарт и пасс с результатом', () => {
  const t = new TosuTracker();
  const ev = collect(t);
  t.process(tosuFrame(MAP, 'selectPlay'));
  for (const p of [0.05, 0.2, 0.4]) t.process(playFrame(MAP, p));
  t.process(playFrame(MAP, 0.4, { failed: true, misses: 10 }));
  t.process(tosuFrame(MAP, 'selectPlay'));
  assert.equal(ev.attempts.length, 1);
  assert.equal(ev.attempts[0].outcome, 'fail');
  assert.ok(Math.abs(ev.attempts[0].progress - 0.4) < 0.01);

  for (const p of [0.05, 0.15, 0.25]) t.process(playFrame(MAP, p));
  t.process(playFrame(MAP, 0.01)); // быстрый рестарт
  assert.equal(ev.attempts[1].outcome, 'retry');

  for (let p = 0.1; p <= 1.0001; p += 0.1) t.process(playFrame(MAP, Math.min(1, p)));
  t.process(resultFrame(MAP));
  t.process(resultFrame(MAP)); // кадры результата приходят много раз
  assert.equal(ev.attempts[2].outcome, 'pass');
  assert.equal(ev.results.length, 1, 'результат обрабатывается один раз за показ экрана');
  assert.equal(ev.results[0].fromPlay, true);
  assert.equal(ev.results[0].mods, 'HDDT');
  assert.equal(ev.results[0].beatmapMd5, MAP.checksum);
});

test('трекер: чужой повтор и просмотр чужого результата не сохраняются', () => {
  const t = new TosuTracker({ getOwnName: () => 'Me' });
  const ev = collect(t);
  for (const p of [0.1, 0.5, 1]) t.process(playFrame(MAP, p, { player: 'Someone' }));
  t.process(resultFrame(MAP, { player: 'Someone' }));
  assert.equal(ev.attempts.length, 0, 'повтор чужой игры — не наша попытка');
  assert.equal(ev.results.length, 0);
  assert.equal(ev.ignored.length, 1);
});

test('трекер: без известного ника результат сохраняется только после игры', () => {
  const t = new TosuTracker();
  const ev = collect(t);
  const f = resultFrame(MAP, { player: 'X' });
  delete f.profile;
  t.process(tosuFrame(MAP, 'selectPlay', { profile: undefined }));
  t.process(f);
  assert.equal(ev.results.length, 0, 'открыли результат из таблицы, не играя');
});

test('трекер: Tosu присылает мусор — не падаем', () => {
  const t = new TosuTracker();
  t.process(null);
  t.process({});
  t.process({ state: { name: 'play' } });
  t.process({ state: { name: 'resultScreen' }, resultsScreen: null });
});

function freshDb() {
  return openDatabase(path.join(tmpDir(), 'test.db'));
}

test('scores: повторное сохранение того же результата не создаёт дубликат', () => {
  const db = freshDb();
  const svc = new ScoreService({ db });
  const s = normalizeTosuResult(resultFrame(MAP));
  const a = svc.save(s);
  const b = svc.save(s);
  const c = svc.save({ ...s, playedAt: '2030-01-01T00:00:00Z' }); // другая дата — тот же score
  assert.equal(a.inserted, true);
  assert.equal(b.inserted, false);
  assert.equal(c.inserted, false);
  assert.equal(db.get('SELECT COUNT(*) AS n FROM scores').n, 1);
  const other = svc.save({ ...s, score: s.score + 1 });
  assert.equal(other.inserted, true, 'другой счёт — другой score');
  db.close();
});

test('scores: результат из Tosu и тот же score из osu! API сливаются', () => {
  const db = freshDb();
  const svc = new ScoreService({ db });
  const tosu = normalizeTosuResult(resultFrame(MAP));
  svc.save(tosu);
  const apiScore = normalizeApiScore({
    id: 999, user_id: 5, user: { username: 'TestPlayer' }, beatmap_id: MAP.id, ruleset_id: 0,
    beatmap: { id: MAP.id, checksum: MAP.checksum, beatmapset_id: MAP.set, version: 'V' },
    beatmapset: { id: MAP.set, title: 'T', artist: 'A' },
    mods: [{ acronym: 'HD' }, { acronym: 'DT' }, { acronym: 'CL' }],
    statistics: { great: tosu.n300, ok: tosu.n100, meh: tosu.n50, miss: tosu.nmiss },
    accuracy: tosu.accuracy / 100, max_combo: tosu.maxCombo, rank: 'A', pp: 321.5, passed: true,
    total_score: 900000, legacy_total_score: tosu.score, build_id: null, ended_at: '2026-10-10T10:00:00Z',
  });
  assert.equal(dedupKey(apiScore), dedupKey(tosu), 'ключ совпадает несмотря на CL и разный формат');
  const r = svc.save(apiScore);
  assert.equal(r.inserted, false);
  const row = db.get('SELECT * FROM scores');
  assert.equal(row.sources, 'api,tosu');
  assert.equal(row.api_score_id, 999);
  assert.equal(row.pp, 321.5, 'официальные pp из API');
  assert.equal(row.played_at, '2026-10-10T10:00:00Z');
  // Повторная загрузка того же score из API (по id) — тоже без дубликата
  assert.equal(svc.save(apiScore).inserted, false);
  assert.equal(db.get('SELECT COUNT(*) AS n FROM scores').n, 1);
  db.close();
});

test('scores: попытки сохраняются и привязываются к результату', () => {
  const db = freshDb();
  const svc = new ScoreService({ db });
  svc.saveAttempt({ beatmapMd5: MAP.checksum, mode: 0, mods: 'HD', startedAt: 'x', endedAt: 'y', outcome: 'pass', progress: 1 });
  const r = svc.save(normalizeTosuResult(resultFrame(MAP)));
  svc.linkLastPassAttempt(MAP.checksum, r.id);
  assert.equal(db.get('SELECT score_id FROM attempts').score_id, r.id);
  db.close();
});

test('индексатор: сканирует Songs, повторный запуск инкрементальный, удалённые карты помечаются', async () => {
  const { songsDir, maps, root } = makeSongs([
    { title: 'Fast Song', artist: 'Speedy', bpm: 240, objects: 300, ar: 9.5 },
    { title: 'Slow Song', artist: 'Calm', bpm: 120, objects: 200, ar: 7 },
    { title: 'Mid Song', artist: 'Camellia', bpm: 180, objects: 500, ar: 9, tags: 'electronic hardcore' },
  ]);
  fs.writeFileSync(path.join(path.dirname(maps[0].file), 'broken.osu'), '');
  const db = openDatabase(path.join(root, 'db.sqlite'));
  const ix = new SongsIndexer({ db, getSettings: () => ({ songsDir, ppMode: 'stable' }) });
  const s1 = await ix.scan();
  assert.equal(s1.added, 3);
  assert.equal(s1.errors, 1, 'пустой файл — ошибка, но сканирование продолжается');
  assert.equal(s1.calculated, 3);
  const row = db.get('SELECT * FROM beatmaps WHERE md5 = ?', maps[0].md5);
  assert.equal(row.title, 'Fast Song');
  assert.ok(row.stars_nm > 0 && row.stars_dt > row.stars_nm && row.pp_nm_98 > 0);

  const s2 = await ix.scan();
  assert.equal(s2.added + s2.updated, 0, 'неизменённые файлы пропускаются');

  fs.rmSync(path.dirname(maps[1].file), { recursive: true });
  const s3 = await ix.scan();
  assert.equal(s3.removed, 1);
  assert.equal(db.get('SELECT missing FROM beatmaps WHERE md5 = ?', maps[1].md5).missing, 1);

  // поиск: текст, теги, фильтры, моды, сортировка
  assert.equal(searchBeatmaps(db, { q: 'camel' }).total, 1, 'префиксный поиск по артисту');
  assert.equal(searchBeatmaps(db, { q: 'hardcore' }).total, 1, 'поиск по тегам');
  assert.equal(searchBeatmaps(db, { q: 'slow' }).total, 0, 'удалённая карта не ищется');
  assert.equal(searchBeatmaps(db, { q: 'bpm>200' }).items[0].title, 'Fast Song');
  assert.equal(searchBeatmaps(db, { q: 'bpm>200', mods: 'DT' }).total, 2, 'с DT обе оставшиеся карты быстрее 200');
  const byStars = searchBeatmaps(db, { q: '', sort: 'stars', order: 'desc' }).items;
  assert.ok(byStars[0].eff.stars >= byStars[1].eff.stars);
  assert.equal(searchBeatmaps(db, { q: 'played=no' }).total, 2);
  assert.doesNotThrow(() => searchBeatmaps(db, { q: 'a" OR (' }), 'спецсимволы FTS экранируются');
  db.close();
});
