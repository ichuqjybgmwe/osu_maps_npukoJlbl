// Эмуляция osu! API v2 для интеграционных тестов (fetch-совместимая функция).
import fs from 'node:fs';
import { parseBeatmap, calcPerformance, calcDifficulty } from '../src/pp/calculator.js';

export function createMockOsu({ playedMaps, remoteMaps = [], username = 'TestPlayer', userId = 4242 }) {
  const state = { online: true, pp: 0, playCount: 1000, requests: [], tokenRequests: 0 };

  // Лучшие scores пользователя: реальные pp через rosu-pp на этих картах.
  const best = playedMaps.map((m, i) => {
    const content = fs.readFileSync(m.file);
    const map = parseBeatmap(content);
    const acc = 98.5 - (i % 5) * 0.4;
    const mods = i % 3 === 0 ? [{ acronym: 'HD' }, { acronym: 'CL' }] : [{ acronym: 'CL' }];
    const modStr = mods.map((x) => x.acronym).filter((x) => x !== 'CL').join('');
    const perf = calcPerformance(map, { mods: modStr, accuracy: acc, lazer: false });
    const diff = calcDifficulty(map, {});
    map.free();
    const n = (perf.state.n300 || 0) + (perf.state.n100 || 0) + (perf.state.n50 || 0) + (perf.state.misses || 0);
    return {
      id: 100000 + i, user_id: userId, user: { id: userId, username }, beatmap_id: m.beatmapId, ruleset_id: 0,
      beatmap: { id: m.beatmapId, checksum: m.md5, beatmapset_id: m.setId, version: m.version || 'Hard', difficulty_rating: diff.stars, mode_int: 0, status: 'ranked', max_combo: perf.maxCombo, bpm: m.bpm, hit_length: 60 },
      beatmapset: { id: m.setId, title: m.title, artist: m.artist || 'Tester', creator: 'Mapper' },
      mods, statistics: { great: perf.state.n300, ok: perf.state.n100, meh: perf.state.n50, miss: perf.state.misses },
      accuracy: acc / 100, max_combo: perf.maxCombo, rank: 'S', pp: perf.pp, passed: true,
      total_score: 900000 + i, legacy_total_score: 5000000 + i * 1000, build_id: null,
      ended_at: new Date(Date.UTC(2026, 0, 1 + i)).toISOString(), _n: n,
    };
  }).sort((a, b) => b.pp - a.pp);
  state.pp = best.reduce((s, x, i) => s + x.pp * 0.95 ** i, 0) + 100;

  const json = (status, data) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });

  async function fetchImpl(input, init = {}) {
    const url = new URL(String(input));
    state.requests.push(`${init.method || 'GET'} ${url.pathname}`);
    if (!state.online) throw new TypeError('fetch failed (offline)');
    if (url.pathname === '/oauth/token') {
      state.tokenRequests++;
      return json(200, { access_token: 'tok', token_type: 'Bearer', expires_in: 86400 });
    }
    if (url.pathname.startsWith('/osu/')) {
      const id = Number(url.pathname.split('/')[2]);
      const m = [...playedMaps, ...remoteMaps].find((x) => x.beatmapId === id);
      return m ? new Response(fs.readFileSync(m.file)) : new Response('', { status: 404 });
    }
    if (!init.headers?.Authorization) return json(401, { error: 'unauthorized' });
    const p = url.pathname.replace('/api/v2', '');
    if (p === `/users/@${username}/osu` || p === `/users/${userId}/osu` || p === '/me/osu') {
      return json(200, {
        id: userId, username, country_code: 'RU', avatar_url: '',
        statistics: { pp: state.pp, global_rank: 12345, country_rank: 321, hit_accuracy: 98.1, play_count: state.playCount, ranked_score: 1e9 },
      });
    }
    if (p === `/users/${userId}/scores/best`) {
      const offset = Number(url.searchParams.get('offset') || 0);
      const limit = Number(url.searchParams.get('limit') || 100);
      return json(200, best.slice(offset, offset + limit));
    }
    if (p === `/users/${userId}/scores/recent`) return json(200, best.slice(0, 3));
    if (p === '/beatmapsets/search') {
      return json(200, {
        beatmapsets: remoteMaps.map((m) => ({
          id: m.setId, title: m.title, artist: m.artist || 'Remote', creator: 'Mapper', status: 'ranked', covers: {},
          beatmaps: [{ id: m.beatmapId, checksum: m.md5, version: m.version || 'Insane', mode_int: 0, difficulty_rating: m.starsHint ?? 4, ar: m.ar ?? 9, accuracy: 8, cs: 4, drain: 6, bpm: m.bpm ?? 180, hit_length: 90, max_combo: 400, status: 'ranked', playcount: 1000 }],
        })),
        cursor_string: null,
        total: remoteMaps.length,
      });
    }
    if (p === '/beatmaps') {
      const ids = url.searchParams.getAll('ids[]').map(Number);
      const all = [...playedMaps, ...(state.extraLocal || [])];
      return json(200, { beatmaps: all.filter((m) => ids.includes(m.beatmapId)).map((m, i) => ({ id: m.beatmapId, checksum: m.md5, beatmapset_id: m.setId, version: m.version || 'Hard', mode_int: 0, status: m.status || (i % 5 === 4 ? 'graveyard' : 'ranked'), difficulty_rating: 4 })) });
    }
    if (p.startsWith('/beatmaps/')) return json(404, { error: 'not found' });
    return json(404, { error: `mock: ${p}` });
  }

  return { fetchImpl, state, best };
}
