// Интеграционный тест: приложение целиком через HTTP API.
// osu! API эмулируется, Tosu — настоящим WebSocket-сервером.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createApp } from '../src/app.js';
import { logger } from '../src/logger.js';
import { makeSongs, tmpDir, waitFor } from './helpers.js';
import { createMockOsu } from './mockOsuApi.js';
import { startWsServer } from './wsServer.js';
import { tosuFrame, playFrame, resultFrame } from './tosuFrames.js';

logger.init({ console: false, level: 'warn' });

const defs = [];
for (let i = 0; i < 26; i++) {
  defs.push({ title: `Song ${i}`, artist: i % 4 === 0 ? 'Camellia' : 'Artist', bpm: 140 + (i % 9) * 15, spacing: 80 + (i % 7) * 20, objects: 250 + (i % 5) * 60, ar: 8 + (i % 3) * 0.5 });
}
let env;

before(async () => {
  const root = tmpDir();
  const songs = makeSongs(defs, root);
  const remote = makeSongs([{ title: 'Remote A', bpm: 190, spacing: 130, objects: 350, setId: 90001, beatmapId: 90001 }, { title: 'Remote B', bpm: 175, spacing: 120, objects: 320, setId: 90002, beatmapId: 90002 }], tmpDir());
  const mock = createMockOsu({ playedMaps: songs.maps.slice(0, 14), remoteMaps: remote.maps });
  const tosu = await startWsServer();
  env = { root, songs, mock, tosu, dataDir: path.join(root, 'data') };
  env.app = await start();
});

after(async () => {
  await env.app?.close().catch(() => {});
  await env.tosu.close();
});

async function start() {
  const app = createApp({ dataDir: env.dataDir, staticDir: path.resolve('web'), fetchImpl: env.mock.fetchImpl, tosuUrl: `ws://127.0.0.1:${env.tosu.port}/websocket/v2` });
  await app.listen(0);
  app.tosu.start();
  return app;
}

async function http(pathname, { method = 'GET', body } = {}) {
  const res = await fetch(`http://127.0.0.1:${env.app.port}${pathname}`, { method, body: body ? JSON.stringify(body) : undefined, headers: body ? { 'Content-Type': 'application/json' } : {} });
  const data = await res.json().catch(() => null);
  return { status: res.status, data };
}

test('1. настройки, сканирование Songs и поиск через HTTP', async () => {
  let r = await http('/api/settings', { method: 'PUT', body: { songsDir: env.songs.songsDir, clientId: '123', clientSecret: 'secret', username: 'TestPlayer', autoScanOnStart: false } });
  assert.equal(r.status, 200);
  assert.equal(r.data.clientSecret, '********', 'секрет не отдаётся наружу');
  r = await http('/api/songs/scan', { method: 'POST', body: {} });
  assert.equal(r.status, 200);
  await waitFor(async () => !(await http('/api/songs/status')).data.running && (await http('/api/songs/status')).data.indexed === 26, { timeout: 20000 });
  r = await http('/api/beatmaps/search?q=camellia&sort=stars');
  assert.equal(r.data.total, 7);
  r = await http(`/api/beatmaps/search?q=${encodeURIComponent('bpm>=250')}&mods=DT`);
  assert.ok(r.data.total > 0 && r.data.items.every((m) => m.eff.bpm >= 250));
  const page = await fetch(`http://127.0.0.1:${env.app.port}/maps`);
  assert.match(await page.text(), /MapVault/, 'SPA отдаётся на любом пути');
});

test('2. профиль из osu! API: снимок, top plays, recent, без дубликатов', async () => {
  let r = await http('/api/profile/refresh', { method: 'POST' });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.top, 14);
  const n1 = (await http('/api/status')).data.counts.scores;
  assert.equal(n1, 14, 'recent — это те же scores, что в топе: дубликатов нет');
  r = await http('/api/profile/refresh', { method: 'POST' });
  assert.equal(r.data.inserted, 0, 'повторная синхронизация ничего не дублирует');
  const prof = (await http('/api/profile')).data;
  assert.equal(prof.user.username, 'TestPlayer');
  assert.equal(prof.top.source, 'api');
  assert.equal(prof.top.count, 14);
  const top = (await http('/api/profile/top')).data;
  assert.ok(top.rows[0].pp >= top.rows[1].pp);
  assert.ok(top.rows.every((s) => s.pp_calc != null), 'pp пересчитаны rosu-pp по локальным картам');
  // наш пересчёт совпадает с «официальными» pp мока (они тоже из rosu-pp)
  assert.ok(top.rows.every((s) => Math.abs(s.pp_calc - s.pp) < 0.5), 'pp_calc ≈ pp');
});

test('3. Tosu: игра → результат в SQLite; повторный показ не дублирует; lifetime pp не растёт от слабого score', async () => {
  await waitFor(() => env.app.tosu.status.state === 'connected', { timeout: 8000 });
  const before = (await http('/api/profile')).data.lifetime;
  const m = env.songs.maps[20]; // карта, которой нет в топе
  const MAP = { checksum: m.md5, id: m.beatmapId, set: m.setId, artist: 'Artist', title: m.title, version: 'Hard', first: 1000, last: 60000, objects: m.objects };
  // Слабый результат: много промахов и низкий счёт
  const frames = [tosuFrame(MAP, 'selectPlay')];
  for (let p = 0.1; p <= 1.0001; p += 0.15) frames.push(playFrame(MAP, Math.min(1, p)));
  frames.push(playFrame(MAP, 1));
  frames.push(resultFrame(MAP, { score: 1111, n100: 60, misses: 40 }), resultFrame(MAP, { score: 1111, n100: 60, misses: 40 }));
  frames.push(tosuFrame(MAP, 'selectPlay'), resultFrame(MAP, { score: 1111, n100: 60, misses: 40 }), tosuFrame(MAP, 'menu'));
  for (const f of frames) {
    env.tosu.send(f);
    await new Promise((r) => setTimeout(r, 20));
  }
  const saved = await waitFor(async () => (await http(`/api/scores?md5=${m.md5}`)).data.find((s) => s.score === 1111));
  assert.equal((await http(`/api/scores?md5=${m.md5}`)).data.filter((s) => s.score === 1111).length, 1, 'ровно одна запись');
  assert.equal(saved.sources, 'tosu');
  assert.equal(saved.mods, 'HDDT');
  await waitFor(async () => (await http(`/api/scores/${saved.id}`)).data.pp_calc != null);
  const attempts = (await http(`/api/attempts?md5=${m.md5}`)).data;
  assert.equal(attempts[0].outcome, 'pass');
  assert.equal(attempts[0].score_id, saved.id, 'попытка привязана к score');

  const after = (await http('/api/profile')).data.lifetime;
  assert.equal(after.gained, before.gained, 'lifetime pp меняется только по снимкам профиля');
  const pp = (await http(`/api/scores/${saved.id}`)).data.pp_calc;
  assert.ok(after.pendingGain < pp, `ожидаемый прирост (${after.pendingGain}) меньше pp score (${pp})`);

  // Страница карты показывает мои результаты
  const pageRes = await http(`/api/beatmaps/${m.md5}`);
  assert.equal(pageRes.status, 200, JSON.stringify(pageRes.data));
  const page = pageRes.data;
  assert.ok(page.scores.some((s) => s.id === saved.id));
  assert.equal(page.attemptStats.pass >= 1, true);
});

test('4. lifetime pp растёт ровно на изменение профиля', async () => {
  const before = (await http('/api/profile')).data.lifetime;
  env.mock.state.pp += 12.5;
  env.mock.state.playCount += 3;
  await http('/api/profile/refresh', { method: 'POST' });
  const after = (await http('/api/profile')).data.lifetime;
  assert.ok(Math.abs(after.gained - before.gained - 12.5) < 1e-6);
  assert.equal(after.history.length, before.history.length + 1);
});

test('5. отключение Tosu не ломает приложение и переподключение работает', async () => {
  const port = env.tosu.port;
  await env.tosu.close();
  await waitFor(() => env.app.tosu.status.state !== 'connected', { timeout: 5000 });
  const st = await http('/api/status');
  assert.equal(st.status, 200);
  assert.notEqual(st.data.tosu.state, 'connected');
  assert.equal((await http('/api/scores')).status, 200, 'данные доступны без Tosu');
  env.tosu = await startWsServer(port);
  await waitFor(() => env.app.tosu.status.state === 'connected', { timeout: 10000 });
});

test('6. PP-калькулятор: сценарии, моды и достоверность', async () => {
  const m = env.songs.maps[3];
  let r = await http('/api/pp/calc', { method: 'POST', body: { md5: m.md5, scenarios: [{ accuracy: 100 }, { accuracy: 97, misses: 3 }, { mods: 'HDDT', accuracy: 98 }, { n100: 10, n50: 2, misses: 1, combo: 100 }] } });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const [ss, worse, dt, exact] = r.data.results;
  assert.ok(ss.pp > worse.pp);
  assert.ok(dt.pp > ss.pp && dt.stars > ss.stars);
  assert.equal(exact.state.n100, 10);
  assert.equal(exact.state.misses, 1);
  assert.equal(r.data.confidence.level, 'high');
  assert.equal(r.data.fileSource, 'local');
  // Карта не из Songs: скачивается по ID, достоверность «средняя» (версию не с чем сверить)
  r = await http('/api/pp/calc', { method: 'POST', body: { beatmapId: 90001, scenarios: [{ accuracy: 99 }] } });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.fileSource, 'download');
  assert.equal(r.data.confidence.level, 'medium');
  r = await http('/api/pp/calc', { method: 'POST', body: { beatmapId: 999999 } });
  assert.equal(r.status, 400, 'нет карты — понятная ошибка');
});

test('7. Farm: анализ профиля и рекомендации с объяснениями', async () => {
  const prof = (await http('/api/farm/profile')).data;
  assert.equal(prof.source, 'api');
  assert.ok(prof.stars.p25 > 0 && prof.stars.p90 >= prof.stars.p25);
  const r = await http('/api/farm/local', { method: 'POST', body: {} });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.ok, true, r.data.error);
  assert.ok(r.data.items.length > 0, 'есть рекомендации');
  for (const it of r.data.items) {
    assert.ok(it.gain > 0 && it.predictedPp > 0 && it.reasons.length >= 3);
    assert.ok(it.farmScore >= 0 && it.farmScore <= 100);
  }
  assert.equal(r.data.items[0].farmScore, 100);
  const played = new Set(env.songs.maps.slice(0, 14).map((m) => m.md5));
  for (const it of r.data.items) {
    if (played.has(it.md5)) assert.ok(it.predictedPp > (it.existingPp || 0), 'на сыгранной карте рекомендуется только улучшение');
  }
  const online = await http('/api/farm/online', { method: 'POST', body: { combo: 'NM' } });
  assert.equal(online.status, 200, JSON.stringify(online.data));
  assert.equal(online.data.ok, true, online.data.error);
  assert.ok(online.data.items.every((x) => x.kind === 'online' && x.links.download));
});

test('8. без интернета сохранённые данные доступны', async () => {
  env.mock.state.online = false;
  env.app.api.appToken = null;
  const r = await http('/api/profile/refresh', { method: 'POST' });
  assert.equal(r.status, 400);
  assert.match(r.data.error, /Сеть|offline|fetch/i);
  assert.equal((await http('/api/profile')).status, 200);
  assert.ok((await http('/api/profile/top')).data.rows.length > 0);
  assert.ok((await http('/api/beatmaps/search?q=song')).data.total > 0);
  const calc = await http('/api/pp/calc', { method: 'POST', body: { md5: env.songs.maps[0].md5 } });
  assert.equal(calc.status, 200, 'калькулятор работает офлайн по локальным картам');
  env.mock.state.online = true;
});

test('9. после закрытия и повторного запуска данные на месте', async () => {
  const before = (await http('/api/status')).data.counts;
  await env.app.close();
  env.app = await start();
  const after = (await http('/api/status')).data.counts;
  assert.deepEqual(after, before);
  const s = (await http('/api/settings')).data;
  assert.equal(s.songsDir, env.songs.songsDir);
  assert.equal(s.username, 'TestPlayer');
  assert.ok((await http('/api/profile')).data.lifetime.gained > 0, 'история профиля сохранилась');
});
