#!/usr/bin/env node
// Эмулятор Tosu для проверки без игры: поднимает ws://127.0.0.1:24050/websocket/v2
// и проигрывает сценарий «выбор карты → игра → экран результатов», плюс фейл и рестарт.
// Формат кадров повторяет tosu v2 (packages/tosu/src/api/types/v2.ts).
//
//   node scripts/fake-tosu.mjs --osu "path/to/map.osu" [--player Name] [--port 24050] [--loop]
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';

const args = Object.fromEntries(process.argv.slice(2).map((a) => {
  const m = /^--([^=]+)(?:=(.*))?$/.exec(a);
  return m ? [m[1], m[2] ?? true] : [a, true];
}));
const port = Number(args.port || 24050);
const player = args.player || 'TestPlayer';

function readMap(file) {
  const text = fs.readFileSync(file, 'utf8');
  const get = (k) => (new RegExp(`^${k}:\\s*(.*)$`, 'm').exec(text) || [])[1]?.trim() || '';
  const objects = (text.split('[HitObjects]')[1] || '').split(/\r?\n/).filter((l) => l.split(',').length >= 4);
  const times = objects.map((l) => Number(l.split(',')[2]));
  return {
    checksum: crypto.createHash('md5').update(fs.readFileSync(file)).digest('hex'),
    id: Number(get('BeatmapID')) || 0, set: Number(get('BeatmapSetID')) || 0,
    artist: get('Artist'), title: get('Title'), version: get('Version'), mapper: get('Creator'),
    objects: objects.length, first: Math.min(...times), last: Math.max(...times),
  };
}

const map = args.osu ? readMap(args.osu) : { checksum: 'd41d8cd98f00b204e9800998ecf8427e', id: 1, set: 1, artist: 'Fake', title: 'Map', version: 'Hard', mapper: 'nobody', objects: 500, first: 1000, last: 120000 };

function frame(stateName, extra = {}) {
  return {
    client: 'stable', server: 'ppy.sh',
    state: { number: { menu: 0, play: 2, selectPlay: 5, resultScreen: 7 }[stateName] ?? 0, name: stateName },
    game: { focused: true, paused: false },
    profile: { name: player, id: 123, pp: 5000, globalRank: 10000, mode: { number: 0, name: 'osu' } },
    beatmap: {
      checksum: map.checksum, id: map.id, set: map.set, mode: { number: 0, name: 'osu' },
      artist: map.artist, title: map.title, version: map.version, mapper: map.mapper,
      status: { number: 4, name: 'ranked' },
      time: { live: 0, firstObject: map.first, lastObject: map.last, mp3Length: map.last + 3000 },
      stats: { stars: { total: 6, live: 0 }, ar: { original: 9, converted: 9 }, od: { original: 8, converted: 8 }, cs: { original: 4, converted: 4 }, hp: { original: 6, converted: 6 }, bpm: { common: 200, min: 200, max: 200, realtime: 200 }, maxCombo: map.objects },
    },
    play: { playerName: player, mode: { number: 0, name: 'osu' }, score: 0, accuracy: 100, failed: false, hits: { 0: 0, 50: 0, 100: 0, 300: 0, geki: 0, katu: 0, sliderBreaks: 0 }, combo: { current: 0, max: 0 }, mods: { number: 72, name: 'HDDT', array: [{ acronym: 'HD' }, { acronym: 'DT' }], rate: 1.5 }, pp: { current: 0, fc: 0 } },
    resultsScreen: { scoreId: 0, playerName: '', mode: { number: 0, name: 'osu' }, score: 0, accuracy: 0, name: '', hits: { 0: 0, 50: 0, 100: 0, 300: 0, geki: 0, katu: 0 }, mods: { number: 0, name: '', array: [], rate: 1 }, maxCombo: 0, rank: '', pp: { current: 0, fc: 0 }, createdAt: '' },
    folders: { game: '', skin: '', songs: args.songs || '', beatmap: '' },
    ...extra,
  };
}

function playFrame(progress, { failed = false, misses = 0 } = {}) {
  const f = frame('play');
  const n = Math.floor(map.objects * progress);
  const n100 = Math.floor(n * 0.03);
  f.beatmap.time.live = map.first + (map.last - map.first) * progress;
  f.play.hits = { 0: misses, 50: 0, 100: n100, 300: Math.max(0, n - n100 - misses), geki: 0, katu: 0, sliderBreaks: 0 };
  f.play.score = n * 1000;
  f.play.combo = { current: n, max: n };
  f.play.accuracy = n ? ((300 * (n - n100 - misses) + 100 * n100) / (300 * n)) * 100 : 100;
  f.play.failed = failed;
  return f;
}

function resultFrame(createdAt) {
  const f = frame('resultScreen');
  const n100 = Math.floor(map.objects * 0.03);
  const n300 = map.objects - n100 - 1;
  f.resultsScreen = {
    scoreId: 0, playerName: player, name: player, mode: { number: 0, name: 'osu' },
    score: 12345678, accuracy: ((300 * n300 + 100 * n100) / (300 * map.objects)) * 100,
    hits: { 0: 1, 50: 0, 100: n100, 300: n300, geki: 0, katu: 0, sliderEndHits: 0, smallTickHits: 0, largeTickHits: 0 },
    mods: { checksum: '', number: 72, name: 'HDDT', array: [{ acronym: 'HD' }, { acronym: 'DT' }], rate: 1.5 },
    maxCombo: Math.floor(map.objects * 0.7), rank: 'A', pp: { current: 0, fc: 0 }, createdAt,
  };
  return f;
}

// --- минимальный WebSocket-сервер (только отправка текстовых кадров) ---
const clients = new Set();
const server = http.createServer((req, res) => { res.writeHead(200); res.end('fake tosu'); });
server.on('upgrade', (req, socket) => {
  if (!req.url.startsWith('/websocket/v2')) return socket.destroy();
  const accept = crypto.createHash('sha1').update(req.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
  socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
  clients.add(socket);
  socket.on('close', () => clients.delete(socket));
  socket.on('error', () => clients.delete(socket));
  socket.on('data', (buf) => { if ((buf[0] & 0x0f) === 8) socket.end(); });
});
function send(obj) {
  const payload = Buffer.from(JSON.stringify(obj));
  let header;
  if (payload.length < 126) header = Buffer.from([0x81, payload.length]);
  else if (payload.length < 65536) { header = Buffer.alloc(4); header[0] = 0x81; header[1] = 126; header.writeUInt16BE(payload.length, 2); }
  else { header = Buffer.alloc(10); header[0] = 0x81; header[1] = 127; header.writeBigUInt64BE(BigInt(payload.length), 2); }
  for (const c of clients) c.write(Buffer.concat([header, payload]));
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function scenario() {
  const createdAt = new Date().toISOString();
  console.log(`[fake-tosu] сценарий на карте ${map.artist} - ${map.title} [${map.version}] (${map.checksum})`);
  for (let i = 0; i < 3; i++) { send(frame('selectPlay')); await sleep(200); }
  // 1) Фейл на 40%
  for (let p = 0; p <= 0.4; p += 0.1) { send(playFrame(p)); await sleep(150); }
  send(playFrame(0.4, { failed: true, misses: 12 })); await sleep(300);
  send(frame('selectPlay')); await sleep(300);
  // 2) Быстрый рестарт: прогресс 20% → сброс в начало (то же состояние play)
  for (let p = 0; p <= 0.2; p += 0.1) { send(playFrame(p)); await sleep(150); }
  // 3) Полное прохождение → экран результатов
  for (let p = 0; p <= 1.0001; p += 0.1) { send(playFrame(Math.min(1, p), { misses: 1 })); await sleep(150); }
  for (let i = 0; i < 6; i++) { send(resultFrame(createdAt)); await sleep(200); }
  send(frame('selectPlay')); await sleep(300);
  // 4) Повторно открываем тот же результат (как при просмотре в таблице) — дубликата быть не должно
  for (let i = 0; i < 4; i++) { send(resultFrame(createdAt)); await sleep(200); }
  send(frame('menu'));
  console.log('[fake-tosu] сценарий завершён');
}

server.listen(port, '127.0.0.1', async () => {
  console.log(`[fake-tosu] ws://127.0.0.1:${port}/websocket/v2`);
  while (!clients.size) await sleep(200);
  await sleep(500);
  do {
    await scenario();
    await sleep(1000);
  } while (args.loop);
  if (!args.stay) setTimeout(() => process.exit(0), 500);
});
