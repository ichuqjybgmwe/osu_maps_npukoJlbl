// Кадры в формате tosu /websocket/v2 для тестов.
export function tosuFrame(map, stateName, extra = {}) {
  return {
    client: 'stable',
    state: { number: { menu: 0, play: 2, selectPlay: 5, resultScreen: 7 }[stateName] ?? 0, name: stateName },
    profile: { name: 'TestPlayer', id: 1, pp: 5000 },
    beatmap: {
      checksum: map.checksum, id: map.id, set: map.set, mode: { number: 0, name: 'osu' },
      artist: map.artist, title: map.title, version: map.version, mapper: 'M',
      time: { live: 0, firstObject: map.first, lastObject: map.last, mp3Length: map.last + 1000 },
      stats: { stars: { total: 6 }, ar: { converted: 9 }, od: { converted: 8 }, cs: { converted: 4 }, bpm: { common: 180 } },
    },
    play: { playerName: 'TestPlayer', mode: { number: 0 }, score: 0, accuracy: 100, failed: false, hits: { 0: 0, 50: 0, 100: 0, 300: 0 }, combo: { current: 0, max: 0 }, mods: { number: 72, name: 'HDDT', array: [{ acronym: 'HD' }, { acronym: 'DT' }], rate: 1.5 }, pp: { current: 0, fc: 0 } },
    resultsScreen: null,
    folders: { game: '', songs: '' },
    ...extra,
  };
}

export function playFrame(map, progress, { failed = false, misses = 0, player = 'TestPlayer' } = {}) {
  const f = tosuFrame(map, 'play');
  const n = Math.floor(map.objects * progress);
  f.beatmap.time.live = map.first + (map.last - map.first) * progress;
  f.play.playerName = player;
  f.play.hits = { 0: misses, 50: 0, 100: Math.floor(n * 0.02), 300: Math.max(0, n - Math.floor(n * 0.02) - misses) };
  f.play.score = n * 1000;
  f.play.combo = { current: n, max: n };
  f.play.accuracy = 98;
  f.play.failed = failed;
  return f;
}

export function resultFrame(map, { player = 'TestPlayer', score = 7654321, n100 = 8, misses = 1 } = {}) {
  const f = tosuFrame(map, 'resultScreen');
  const n300 = map.objects - n100 - misses;
  f.resultsScreen = {
    scoreId: 0, playerName: player, name: player, mode: { number: 0, name: 'osu' }, score,
    accuracy: ((300 * n300 + 100 * n100) / (300 * map.objects)) * 100,
    hits: { 0: misses, 50: 0, 100: n100, 300: n300, geki: 0, katu: 0, sliderEndHits: 0, smallTickHits: 0, largeTickHits: 0 },
    mods: { checksum: '', number: 72, name: 'HDDT', array: [{ acronym: 'HD' }, { acronym: 'DT' }], rate: 1.5 },
    maxCombo: map.objects - 20, rank: 'A', pp: { current: 0, fc: 0 }, createdAt: '2026-10-16T12:00:00.000Z',
  };
  return f;
}
