// Лёгкий парсер .osu: метаданные, параметры сложности, BPM, длина и
// количество объектов. Звёзды и pp считает rosu-pp, здесь только описание карты.

export function parseOsuFile(text) {
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  const out = {
    formatVersion: null,
    mode: 0,
    title: '', titleUnicode: '', artist: '', artistUnicode: '',
    creator: '', version: '', source: '', tags: '',
    beatmapId: null, beatmapSetId: null,
    hp: 5, cs: 5, od: 5, ar: null,
    bpmMin: null, bpmMax: null, bpmMain: null,
    lengthTotal: 0, lengthDrain: 0,
    nCircles: 0, nSliders: 0, nSpinners: 0,
    audioFilename: '', background: '',
  };
  const lines = text.split(/\r?\n/);
  const m = /^osu file format v(\d+)/.exec(lines[0] || '');
  if (m) out.formatVersion = Number(m[1]);
  let section = '';
  const timing = [];
  const breaks = [];
  let firstObj = null;
  let lastObj = null;

  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith('//')) continue;
    if (line.startsWith('[') && line.endsWith(']')) {
      section = line.slice(1, -1);
      continue;
    }
    if (section === 'General' || section === 'Metadata' || section === 'Difficulty') {
      const i = line.indexOf(':');
      if (i < 0) continue;
      const key = line.slice(0, i).trim();
      const val = line.slice(i + 1).trim();
      switch (key) {
        case 'Mode': out.mode = Number(val) || 0; break;
        case 'AudioFilename': out.audioFilename = val; break;
        case 'Title': out.title = val; break;
        case 'TitleUnicode': out.titleUnicode = val; break;
        case 'Artist': out.artist = val; break;
        case 'ArtistUnicode': out.artistUnicode = val; break;
        case 'Creator': out.creator = val; break;
        case 'Version': out.version = val; break;
        case 'Source': out.source = val; break;
        case 'Tags': out.tags = val; break;
        case 'BeatmapID': out.beatmapId = Number(val) > 0 ? Number(val) : null; break;
        case 'BeatmapSetID': out.beatmapSetId = Number(val) > 0 ? Number(val) : null; break;
        case 'HPDrainRate': out.hp = Number(val); break;
        case 'CircleSize': out.cs = Number(val); break;
        case 'OverallDifficulty': out.od = Number(val); break;
        case 'ApproachRate': out.ar = Number(val); break;
        default: break;
      }
    } else if (section === 'Events') {
      const parts = line.split(',');
      if ((parts[0] === '2' || parts[0] === 'Break') && parts.length >= 3) {
        breaks.push([Number(parts[1]), Number(parts[2])]);
      } else if (parts[0] === '0' && parts.length >= 3 && !out.background) {
        out.background = parts[2].replace(/^"|"$/g, '');
      }
    } else if (section === 'TimingPoints') {
      const parts = line.split(',');
      if (parts.length < 2) continue;
      const time = Number(parts[0]);
      const beatLength = Number(parts[1]);
      const uninherited = parts.length < 7 ? true : parts[6] === '1';
      if (uninherited && beatLength > 0) timing.push({ time, bpm: 60000 / beatLength });
    } else if (section === 'HitObjects') {
      const parts = line.split(',');
      if (parts.length < 4) continue;
      const time = Number(parts[2]);
      const type = Number(parts[3]);
      let end = time;
      if (type & 1) out.nCircles++;
      else if (type & 2) out.nSliders++;
      else if (type & 8) {
        out.nSpinners++;
        end = Number(parts[5]) || time;
      } else if (type & 128) {
        out.nSliders++; // hold note в mania
        end = Number(String(parts[5] || '').split(':')[0]) || time;
      }
      if (firstObj === null || time < firstObj) firstObj = time;
      if (lastObj === null || end > lastObj) lastObj = end;
    }
  }

  if (out.ar == null || Number.isNaN(out.ar)) out.ar = out.od; // старые форматы
  if (timing.length) {
    timing.sort((a, b) => a.time - b.time);
    const bpms = timing.map((t) => t.bpm).filter((b) => b > 0 && b < 10000);
    out.bpmMin = Math.min(...bpms);
    out.bpmMax = Math.max(...bpms);
    // «Основной» BPM — тот, что звучит дольше всего.
    const endTime = lastObj ?? timing[timing.length - 1].time;
    const dur = new Map();
    for (let i = 0; i < timing.length; i++) {
      const start = Math.max(timing[i].time, firstObj ?? timing[i].time);
      const stop = i + 1 < timing.length ? timing[i + 1].time : endTime;
      const d = Math.max(0, stop - start);
      const key = Math.round(timing[i].bpm * 100) / 100;
      dur.set(key, (dur.get(key) || 0) + d);
    }
    let best = null;
    for (const [bpm, d] of dur) if (!best || d > best[1]) best = [bpm, d];
    out.bpmMain = best && best[1] > 0 ? best[0] : timing[0].bpm;
  }
  if (firstObj !== null && lastObj !== null) {
    out.lengthTotal = Math.round(lastObj / 1000);
    const breakTime = breaks.reduce((s, [a, b]) => s + Math.max(0, Math.min(b, lastObj) - Math.max(a, firstObj)), 0);
    out.lengthDrain = Math.max(0, Math.round((lastObj - firstObj - breakTime) / 1000));
  }
  return out;
}
