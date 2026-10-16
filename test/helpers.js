// Общие помощники тестов: синтетические .osu-файлы и временные папки.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

/** Сгенерировать валидную карту osu!standard: круги по кругу с заданным BPM и плотностью. */
export function makeOsu({
  title = 'Test Song', artist = 'Tester', creator = 'Mapper', version = 'Hard', tags = 'test',
  beatmapId = 0, setId = 0, bpm = 180, ar = 9, od = 8, cs = 4, hp = 6, objects = 300, spacing = 120, divisor = 2, mode = 0,
} = {}) {
  const beat = 60000 / bpm;
  const step = beat / divisor;
  const lines = [
    'osu file format v14', '',
    '[General]', 'AudioFilename: audio.mp3', 'AudioLeadIn: 0', 'PreviewTime: -1', `Mode: ${mode}`, '',
    '[Metadata]', `Title:${title}`, `TitleUnicode:${title}`, `Artist:${artist}`, `ArtistUnicode:${artist}`,
    `Creator:${creator}`, `Version:${version}`, 'Source:', `Tags:${tags}`, `BeatmapID:${beatmapId}`, `BeatmapSetID:${setId}`, '',
    '[Difficulty]', `HPDrainRate:${hp}`, `CircleSize:${cs}`, `OverallDifficulty:${od}`, `ApproachRate:${ar}`, 'SliderMultiplier:1.4', 'SliderTickRate:1', '',
    '[Events]', '0,0,"bg.jpg",0,0', '',
    '[TimingPoints]', `1000,${beat},4,2,0,60,1,0`, '',
    '[HitObjects]',
  ];
  for (let i = 0; i < objects; i++) {
    const a = (i / 8) * Math.PI * 2;
    const x = Math.round(256 + Math.cos(a) * spacing);
    const y = Math.round(192 + Math.sin(a) * spacing * 0.8);
    lines.push(`${x},${y},${Math.round(1000 + i * step)},${i === 0 ? 5 : 1},0,0:0:0:0:`);
  }
  return lines.join('\r\n') + '\r\n';
}

export function md5(text) {
  return crypto.createHash('md5').update(text).digest('hex');
}

export function tmpDir(prefix = 'mapvault-test-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/** Создать папку Songs с несколькими картами. Возвращает { songsDir, maps: [{file, md5, ...opts}] } */
export function makeSongs(defs, root = tmpDir()) {
  const songsDir = path.join(root, 'Songs');
  const maps = [];
  defs.forEach((d, i) => {
    const setId = d.setId ?? 1000 + i;
    const folder = path.join(songsDir, `${setId} ${d.artist || 'Tester'} - ${d.title || `Song ${i}`}`);
    fs.mkdirSync(folder, { recursive: true });
    const content = makeOsu({ ...d, setId, beatmapId: d.beatmapId ?? 5000 + i, title: d.title || `Song ${i}` });
    const file = path.join(folder, `${d.title || `Song ${i}`} [${d.version || 'Hard'}].osu`);
    fs.writeFileSync(file, content);
    maps.push({ ...d, setId, beatmapId: d.beatmapId ?? 5000 + i, file, md5: md5(content) });
  });
  return { root, songsDir, maps };
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function waitFor(fn, { timeout = 5000, interval = 25 } = {}) {
  const start = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - start > timeout) throw new Error('waitFor: timeout');
    await sleep(interval);
  }
}
