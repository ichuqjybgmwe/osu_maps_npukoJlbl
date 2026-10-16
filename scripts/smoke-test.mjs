#!/usr/bin/env node
// Смоук-тест собранного исполняемого файла (MapVault.exe / mapvault) как чёрного ящика:
//  1) запуск без node/npm, сайт открывается;
//  2) сканирование папки Songs находит карты, поиск работает;
//  3) эмулятор Tosu: игра → результат сохраняется в SQLite, повтор не дублирует;
//  4) отключение Tosu не ломает API;
//  5) перезапуск — данные на месте.
//
//   node scripts/smoke-test.mjs --exe=dist/MapVault-0.1.0-win-x64/MapVault.exe [--runner=wine]
import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import { makeSongs, tmpDir, waitFor, sleep } from '../test/helpers.js';
import { startWsServer } from '../test/wsServer.js';
import { tosuFrame, playFrame, resultFrame } from '../test/tosuFrames.js';

const args = Object.fromEntries(process.argv.slice(2).map((a) => a.replace(/^--/, '').split('=')));
if (!args.exe) {
  console.error('Укажите --exe=путь/к/MapVault.exe');
  process.exit(2);
}
const exe = path.resolve(args.exe);
const port = Number(args.port || 47900);
const runner = args.runner || null; // например wine
const root = tmpDir('mapvault-smoke-');
const dataDir = path.join(root, 'data');
const toNative = (p) => (runner === 'wine' ? `Z:${p.replace(/\//g, '\\')}` : p);
const step = (m) => console.log(`[smoke] ${m}`);
let child = null;

async function startExe(tosuPort) {
  const argv = [exe, '--no-browser', `--port=${port}`, `--tosu=ws://127.0.0.1:${tosuPort}/websocket/v2`];
  const cmd = runner || argv.shift();
  child = spawn(cmd, runner ? argv : argv, { env: { ...process.env, MAPVAULT_DATA: toNative(dataDir), WINEDEBUG: '-all' }, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', (d) => process.env.SMOKE_VERBOSE && process.stdout.write(d));
  child.stderr.on('data', (d) => process.env.SMOKE_VERBOSE && process.stderr.write(d));
  await waitFor(async () => (await api('/api/health').catch(() => null))?.app === 'mapvault', { timeout: 90000, interval: 500 });
}

async function stopExe() {
  await api('/api/shutdown', { method: 'POST' }).catch(() => {});
  await new Promise((r) => {
    const t = setTimeout(() => { child.kill(); r(); }, 10000);
    child.on('exit', () => { clearTimeout(t); r(); });
  });
  await sleep(500);
}

async function api(p, { method = 'GET', body } = {}) {
  const res = await fetch(`http://127.0.0.1:${port}${p}`, { method, body: body ? JSON.stringify(body) : undefined, headers: body ? { 'Content-Type': 'application/json' } : {}, signal: AbortSignal.timeout(10000) });
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new Error(`${p}: HTTP ${res.status} ${JSON.stringify(data)}`);
  return data;
}

function check(cond, msg) {
  if (!cond) throw new Error(`ПРОВАЛ: ${msg}`);
  step(`OK: ${msg}`);
}

async function main() {
  const songs = makeSongs([
    { title: 'Smoke One', artist: 'Camellia', bpm: 200, spacing: 140, objects: 400 },
    { title: 'Smoke Two', artist: 'Other', bpm: 150, spacing: 100, objects: 300 },
    { title: 'Smoke Three', artist: 'Other', bpm: 180, spacing: 120, objects: 350 },
  ], root);
  const tosu = await startWsServer();
  step(`exe: ${exe}`);
  await startExe(tosu.port);
  const page = await (await fetch(`http://127.0.0.1:${port}/`)).text();
  check(page.includes('MapVault'), 'локальный сайт открывается');

  await api('/api/settings', { method: 'PUT', body: { songsDir: toNative(songs.songsDir) } });
  await api('/api/songs/scan', { method: 'POST', body: {} });
  await waitFor(async () => { const s = await api('/api/songs/status'); return !s.running && s.indexed === 3; }, { timeout: 60000, interval: 500 });
  check(true, 'Songs просканирована: 3 карты');
  const found = await api(`/api/beatmaps/search?q=${encodeURIComponent('camellia bpm>=190')}`);
  check(found.total === 1 && found.items[0].title === 'Smoke One', 'поиск с фильтром работает');

  await waitFor(() => tosu.clients > 0, { timeout: 30000, interval: 200 });
  check(true, 'подключение к Tosu установлено');
  const m = songs.maps[0];
  const MAP = { checksum: m.md5, id: m.beatmapId, set: m.setId, artist: 'Camellia', title: m.title, version: 'Hard', first: 1000, last: 60000, objects: m.objects };
  const frames = [tosuFrame(MAP, 'selectPlay')];
  for (let p = 0.1; p <= 1.0001; p += 0.1) frames.push(playFrame(MAP, Math.min(1, p)));
  frames.push(resultFrame(MAP), resultFrame(MAP), tosuFrame(MAP, 'selectPlay'), resultFrame(MAP), tosuFrame(MAP, 'menu'));
  for (const f of frames) { tosu.send(f); await sleep(60); }
  await waitFor(async () => (await api(`/api/scores?md5=${m.md5}`)).length > 0, { timeout: 20000, interval: 300 });
  await sleep(1000);
  const scores = await api(`/api/scores?md5=${m.md5}`);
  check(scores.length === 1, 'результат из Tosu сохранён ровно один раз');
  await waitFor(async () => (await api(`/api/scores/${scores[0].id}`)).pp_calc > 0, { timeout: 15000, interval: 300 });
  check(true, 'pp результата посчитан rosu-pp внутри exe');
  const calc = await api('/api/pp/calc', { method: 'POST', body: { md5: m.md5, scenarios: [{ accuracy: 98, mods: 'HDDT' }] } });
  check(calc.results[0].pp > 0 && calc.confidence.level === 'high', 'PP-калькулятор работает');

  await tosu.close();
  await sleep(1500);
  const st = await api('/api/status');
  check(st.tosu.state !== 'connected', 'после отключения Tosu API отвечает, статус «нет связи»');

  const before = st.counts;
  await stopExe();
  step('exe остановлен, запускаю снова');
  await startExe(65000);
  const after = (await api('/api/status')).counts;
  check(after.scores === before.scores && after.beatmaps === before.beatmaps && after.attempts === before.attempts, `данные сохранились после перезапуска (${JSON.stringify(after)})`);
  await stopExe();
  step('ВСЕ ПРОВЕРКИ ПРОЙДЕНЫ');
}

main().catch(async (e) => {
  console.error(`[smoke] ${e.message}`);
  try { child?.kill(); } catch { /* ignore */ }
  process.exit(1);
}).finally(() => {
  try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* ignore */ }
});
