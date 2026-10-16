// Сборка приложения: база, сервисы, интеграции и HTTP API.
// Используется и main.js (обычный запуск), и интеграционными тестами.
import path from 'node:path';
import fs from 'node:fs';
import { openDatabase, dailyBackup } from './db/index.js';
import { ensureDataDirs } from './paths.js';
import { logger, log } from './logger.js';
import { createSettings } from './settings.js';
import { createRouter, createServer, createStaticSource, EventHub, HttpError } from './server/http.js';
import { TosuClient } from './integrations/tosu.js';
import { TosuTracker } from './integrations/tosuTracker.js';
import { OsuApi } from './integrations/osuApi.js';
import { detectOsu } from './integrations/osuDetect.js';
import { SongsIndexer } from './songs/indexer.js';
import { ScoreService } from './scores/scoreService.js';
import { ProfileService, cacheApiBeatmap } from './profile/profileService.js';
import { OsuFileSource } from './pp/osuSource.js';
import { PpService } from './pp/ppService.js';
import { FarmService } from './farm/farm.js';
import { searchBeatmaps, effectiveAttrs } from './explorer/search.js';
import { CALCULATOR_INFO } from './pp/calculator.js';
import { VERSION } from './version.js';

const L = log('app');

export function createApp({ dataDir, staticDir, assets, fetchImpl, tosuUrl, port } = {}) {
  const dirs = ensureDataDirs(dataDir);
  const db = openDatabase(dirs.db);
  const settings = createSettings(db);
  if (tosuUrl) settings.update({ tosuUrl });
  const events = new EventHub();
  const getSettings = () => settings.get();
  const getSongsDir = () => settings.get().songsDir;

  const api = new OsuApi({
    getConfig: () => {
      const s = settings.get();
      return { clientId: s.clientId, clientSecret: s.clientSecret, userToken: settings.userToken() };
    },
    saveTokens: (t) => settings.setUserToken(t),
    fetchImpl,
  });
  const source = new OsuFileSource({ db, cacheDir: dirs.osuCache, getSongsDir, api });
  const ppService = new PpService({ source, getSettings });
  const scores = new ScoreService({ db, events, ppForScore: (row) => ppService.ppForScore(row) });
  const profile = new ProfileService({ db, api, scores, getSettings, events });
  const indexer = new SongsIndexer({ db, events, getSettings });
  const farm = new FarmService({ db, profile, ppService, api, getSettings, getSongsDir, events });

  // --- Tosu ---
  const tosu = new TosuClient({ url: settings.get().tosuUrl });
  const tracker = new TosuTracker({ getOwnName: () => profile.user()?.username || settings.get().username || null });
  let lastNowEmit = 0;
  let now = null;
  let songsFromTosuChecked = false;
  let profileRefreshTimer = null;

  tosu.on('status', (st) => events.emit('tosu', st));
  tosu.on('frame', (frame) => {
    tracker.process(frame);
    now = summarizeFrame(frame);
    if (Date.now() - lastNowEmit > 500) {
      lastNowEmit = Date.now();
      events.emit('now', now);
    }
    // Tosu знает точный путь к Songs запущенной игры — используем его, если папка не задана.
    if (!songsFromTosuChecked && frame.folders?.songs) {
      songsFromTosuChecked = true;
      const s = settings.get();
      if (!s.songsDir && fs.existsSync(frame.folders.songs)) {
        settings.update({ songsDir: frame.folders.songs, gameDir: frame.folders.game || s.gameDir });
        L.info(`Папка Songs получена от Tosu: ${frame.folders.songs}`);
        indexer.scan().catch((e) => L.warn(`Сканирование: ${e.message}`));
      }
    }
  });
  tosu.on('disconnect', () => {
    now = null;
    events.emit('now', null);
  });
  tracker.on('attempt', (a) => {
    try {
      scores.saveAttempt(a);
      events.emit('attempt', a);
    } catch (e) {
      L.error('Не удалось сохранить попытку', e);
    }
  });
  tracker.on('result', async (s) => {
    try {
      const r = await scores.saveAndEnrich(s);
      if (r.inserted) {
        scores.linkLastPassAttempt(s.beatmapMd5, r.id);
        const row = db.get('SELECT * FROM scores WHERE id = ?', r.id);
        const pp = row.pp ?? row.pp_calc;
        const gain = pp != null && row.passed ? profile.projectGain(row.beatmap_md5, pp) : null;
        events.emit('result', { id: r.id, pp, gain, title: s.beatmapTitle, accuracy: s.accuracy, mods: s.mods });
        // Через минуту спросим API: официальные pp и новый общий pp профиля.
        if (api.configured()) {
          clearTimeout(profileRefreshTimer);
          profileRefreshTimer = setTimeout(() => profile.refresh().catch((e) => L.warn(`Обновление профиля: ${e.message}`)), 60000);
        }
      }
    } catch (e) {
      L.error('Не удалось сохранить результат из Tosu', e);
    }
  });
  tracker.on('ignoredResult', (info) => L.info(`Результат не сохранён: ${info.reason} (${info.playerName})`));

  // --- HTTP API ---
  const router = createRouter();
  const staticSource = createStaticSource({ dir: staticDir, assets });
  let actualPort = port;
  let oauthState = null;
  let shutdownHandler = null;

  router.get('/api/health', () => ({ app: 'mapvault', version: VERSION, ok: true }));

  router.get('/api/status', () => {
    const s = settings.get();
    return {
      version: VERSION,
      dataDir: dirs.root,
      dbFile: dirs.db,
      tosu: { ...tosu.status, enabled: s.tosuEnabled },
      osuApi: { configured: api.configured(), loggedIn: api.hasUser(), user: profile.user(), lastError: api.lastError || profile.lastError, lastRefresh: profile.lastRefresh },
      osu: { gameDir: s.gameDir, songsDir: s.songsDir, songsExists: s.songsDir ? fs.existsSync(s.songsDir) : false },
      indexer: indexer.status(),
      counts: db.get('SELECT (SELECT COUNT(*) FROM scores) AS scores, (SELECT COUNT(*) FROM attempts) AS attempts, (SELECT COUNT(*) FROM beatmaps WHERE missing = 0) AS beatmaps'),
      calculator: CALCULATOR_INFO,
      now,
    };
  });

  router.get('/api/settings', () => settings.public());
  router.put('/api/settings', ({ body }) => {
    const before = settings.get();
    const next = settings.update(body);
    if (next.tosuUrl !== before.tosuUrl) tosu.setUrl(next.tosuUrl);
    if (next.tosuEnabled !== before.tosuEnabled) (next.tosuEnabled ? tosu.start() : tosu.stop());
    if (next.clientId !== before.clientId || (body.clientSecret && body.clientSecret !== '********')) api.appToken = null;
    scheduleProfileRefresh();
    return settings.public();
  });

  router.post('/api/osu/detect', async ({ body }) => {
    const res = await detectOsu({ tosuFolders: tracker.lastFrame?.folders });
    if (res.found && (body.apply ?? true)) settings.update({ gameDir: res.gameDir, songsDir: res.songsDir });
    return res;
  });

  router.get('/api/songs/status', () => indexer.status());
  router.post('/api/songs/scan', ({ body }) => {
    const s = settings.get();
    if (!s.songsDir) throw new HttpError(400, 'Папка Songs не задана. Нажмите «Найти osu!» или укажите путь вручную.');
    if (!fs.existsSync(s.songsDir)) throw new HttpError(400, `Папка не найдена: ${s.songsDir}`);
    indexer.scan({ force: !!body.force }).catch((e) => L.error('Сканирование', e));
    return indexer.status();
  });
  router.post('/api/songs/cancel', () => {
    indexer.cancel();
    return indexer.status();
  });

  router.get('/api/now', () => ({ tosu: tosu.status, now }));

  router.get('/api/scores', ({ query }) => scores.list({
    md5: query.md5, beatmapId: query.beatmapId ? Number(query.beatmapId) : undefined,
    limit: clampInt(query.limit, 1, 500, 50), offset: clampInt(query.offset, 0, 1e9, 0), order: query.order, passedOnly: query.passed === '1',
  }));
  router.get('/api/scores/:id', ({ params }) => {
    const row = db.get('SELECT * FROM scores WHERE id = ?', Number(params.id));
    if (!row) throw new HttpError(404, 'Результат не найден');
    return { ...row, raw_json: undefined };
  });
  router.get('/api/attempts', ({ query }) => scores.attempts({ md5: query.md5, limit: clampInt(query.limit, 1, 1000, 100) }));

  router.get('/api/profile', () => profile.summary());
  router.post('/api/profile/refresh', async () => {
    try {
      return await profile.refresh();
    } catch (e) {
      throw new HttpError(400, e.message);
    }
  });
  router.get('/api/profile/top', () => {
    const t = profile.topList();
    return { source: t.source, rows: t.rows.map((r) => decorateScore(db, r)) };
  });
  router.get('/api/profile/recent', ({ query }) => scores.list({ limit: clampInt(query.limit, 1, 200, 50), order: 'recent' }));

  router.get('/api/beatmaps/search', ({ query }) => searchBeatmaps(db, {
    q: query.q || '', mods: query.mods || '', sort: query.sort || 'relevance', order: query.order,
    limit: clampInt(query.limit, 1, 500, 50), offset: clampInt(query.offset, 0, 1e9, 0),
    mode: query.mode,
  }));
  router.get('/api/beatmaps/by-id/:id', async ({ params }) => {
    const id = Number(params.id);
    const local = db.get('SELECT md5 FROM beatmaps WHERE beatmap_id = ? AND missing = 0 LIMIT 1', id);
    if (local) return { md5: local.md5 };
    let cached = db.get('SELECT * FROM api_beatmaps WHERE beatmap_id = ?', id);
    if (!cached && api.configured()) {
      try {
        const b = await api.beatmap(id);
        if (b) {
          cacheApiBeatmap(db, b, b.beatmapset);
          cached = db.get('SELECT * FROM api_beatmaps WHERE beatmap_id = ?', id);
        }
      } catch (e) {
        L.warn(e.message);
      }
    }
    return { md5: cached?.checksum || null, api: cached || null };
  });
  router.get('/api/beatmaps/:md5', async ({ params, query }) => {
    const row = db.get('SELECT * FROM beatmaps WHERE md5 = ?', params.md5);
    const apiRow = row?.beatmap_id ? db.get('SELECT * FROM api_beatmaps WHERE beatmap_id = ?', row.beatmap_id) : db.get('SELECT * FROM api_beatmaps WHERE checksum = ?', params.md5);
    if (!row && !apiRow) throw new HttpError(404, 'Карта не найдена в индексе');
    const mods = query.mods || '';
    const myScores = scores.list({ md5: params.md5, beatmapId: row?.beatmap_id || apiRow?.beatmap_id, limit: 200, order: 'pp' });
    const attempts = scores.attempts({ md5: params.md5, limit: 200 });
    let ppTable = null;
    try {
      ppTable = await ppService.ppTable({ md5: params.md5, beatmapId: row?.beatmap_id || apiRow?.beatmap_id, mods });
    } catch (e) {
      L.warn(`pp-таблица: ${e.message}`);
    }
    const s = settings.get();
    return {
      local: row ? { ...row, eff: effectiveAttrs(row, mods), path: s.songsDir ? path.join(s.songsDir, row.folder, row.file) : null } : null,
      api: apiRow ? { ...apiRow, raw_json: undefined } : null,
      scores: myScores,
      attempts,
      ppTable,
      attemptStats: summarizeAttempts(attempts),
    };
  });
  router.get('/api/beatmaps/:md5/background', ({ params, res }) => {
    const row = db.get('SELECT folder, file FROM beatmaps WHERE md5 = ?', params.md5);
    const songsDir = settings.get().songsDir;
    if (!row || !songsDir) throw new HttpError(404, 'Нет фона');
    try {
      const text = fs.readFileSync(path.join(songsDir, row.folder, row.file), 'utf8');
      const m = /^0,0,"([^"]+)"/m.exec(text) || /^0,0,([^,\r\n]+)/m.exec(text);
      if (!m) throw new Error('no bg');
      const file = path.join(songsDir, row.folder, m[1]);
      const buf = fs.readFileSync(file);
      const ext = path.extname(file).toLowerCase();
      res.writeHead(200, { 'Content-Type': ext === '.png' ? 'image/png' : 'image/jpeg', 'Cache-Control': 'max-age=86400' });
      res.end(buf);
    } catch {
      throw new HttpError(404, 'Нет фона');
    }
  });

  router.get('/api/catalog/search', async ({ query }) => {
    if (!api.configured()) throw new HttpError(400, 'Каталог osu! недоступен: подключите osu! API в настройках.');
    let res;
    try {
      res = await api.searchBeatmapsets({ q: query.q || '', m: query.m ?? settings.get().mode, s: query.s || 'ranked', sort: query.sort || undefined, cursor_string: query.cursor || undefined, nsfw: query.nsfw ? 1 : undefined });
    } catch (e) {
      throw new HttpError(502, e.message);
    }
    const localSets = new Set(db.all('SELECT DISTINCT beatmapset_id FROM beatmaps WHERE missing = 0 AND beatmapset_id IS NOT NULL').map((r) => r.beatmapset_id));
    const sets = (res?.beatmapsets || []).map((s) => ({
      id: s.id, title: s.title, artist: s.artist, creator: s.creator, status: s.status, cover: s.covers?.card, play_count: s.play_count,
      favourite_count: s.favourite_count, ranked_date: s.ranked_date, local: localSets.has(s.id),
      beatmaps: (s.beatmaps || []).map((b) => {
        cacheApiBeatmap(db, b, s);
        return { id: b.id, version: b.version, mode: b.mode_int, stars: b.difficulty_rating, ar: b.ar, od: b.accuracy, cs: b.cs, bpm: b.bpm, length: b.hit_length, max_combo: b.max_combo, checksum: b.checksum };
      }).sort((a, b) => a.stars - b.stars),
      links: { page: `https://osu.ppy.sh/beatmapsets/${s.id}`, download: `https://osu.ppy.sh/beatmapsets/${s.id}/download`, direct: `osu://s/${s.id}`, mirror: `https://catboy.best/d/${s.id}` },
    }));
    return { total: res?.total ?? sets.length, cursor: res?.cursor_string || null, sets };
  });

  router.post('/api/pp/calc', async ({ body }) => {
    const res = await ppService.calculate({ md5: body.md5 || undefined, beatmapId: body.beatmapId ? Number(body.beatmapId) : undefined, scenarios: body.scenarios, allowDownload: body.allowDownload !== false });
    if (!res.ok) throw new HttpError(400, res.error);
    return res;
  });

  router.get('/api/farm/profile', () => farm.analyze());
  router.get('/api/farm/feedback', () => farm.feedback());
  router.post('/api/farm/local', async ({ body }) => {
    try {
      return await farm.recommendLocal(body || {});
    } catch (e) {
      throw new HttpError(400, e.message);
    }
  });
  router.post('/api/farm/online', async ({ body }) => {
    try {
      return await farm.recommendOnline(body || {});
    } catch (e) {
      throw new HttpError(400, e.message);
    }
  });

  // --- OAuth (вход через osu!) ---
  const redirectUri = () => `http://localhost:${actualPort}/api/osu/callback`;
  router.get('/api/osu/redirect-uri', () => ({ redirectUri: redirectUri() }));
  router.get('/api/osu/login', ({ res }) => {
    if (!api.configured()) throw new HttpError(400, 'Сначала укажите Client ID и Client Secret в настройках.');
    oauthState = Math.random().toString(36).slice(2);
    res.writeHead(302, { Location: api.authorizeUrl(redirectUri(), oauthState) });
    res.end();
  });
  router.get('/api/osu/callback', async ({ query, res }) => {
    const page = (title, text) => {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(`<!doctype html><meta charset="utf-8"><title>MapVault</title><body style="font-family:system-ui;background:#111;color:#eee;padding:40px"><h2>${title}</h2><p>${text}</p><p><a style="color:#8ab4ff" href="/profile">Вернуться в MapVault</a></p>`);
    };
    if (query.error) return page('Вход отменён', escapeHtml(query.error));
    if (!query.code || query.state !== oauthState) return page('Ошибка входа', 'Неверный ответ авторизации. Попробуйте ещё раз.');
    try {
      await api.exchangeCode(query.code, redirectUri());
      oauthState = null;
      profile.refresh().catch((e) => L.warn(`Профиль после входа: ${e.message}`));
      return page('Вход выполнен', 'Профиль загружается. Можно закрыть эту вкладку.');
    } catch (e) {
      return page('Ошибка входа', escapeHtml(e.message));
    }
  });
  router.post('/api/osu/logout', () => {
    settings.setUserToken(null);
    return { ok: true };
  });

  router.get('/api/logs', ({ query }) => logger.recent(clampInt(query.limit, 1, 500, 200)));
  router.post('/api/shutdown', () => {
    setTimeout(() => shutdownHandler?.(), 200);
    return { ok: true };
  });

  const server = createServer({ router, staticSource, events });

  function scheduleProfileRefresh() {
    clearInterval(app.profileTimer);
    const s = settings.get();
    if (!api.configured() || !(api.hasUser() || s.username) || !s.profileRefreshMinutes) return;
    app.profileTimer = setInterval(() => profile.refresh().catch((e) => L.warn(`Автообновление профиля: ${e.message}`)), s.profileRefreshMinutes * 60000);
  }

  const app = {
    db, dirs, settings, events, api, tosu, tracker, scores, profile, indexer, farm, ppService, server,
    profileTimer: null,
    get port() { return actualPort; },
    async listen(p = port ?? settings.get().port, host = '127.0.0.1') {
      await new Promise((resolve, reject) => {
        const onErr = (e) => { server.off('listening', onOk); reject(e); };
        const onOk = () => { server.off('error', onErr); resolve(); };
        server.once('error', onErr);
        server.once('listening', onOk);
        server.listen(p, host);
      });
      actualPort = server.address().port;
      return actualPort;
    },
    startBackground({ tosuEnabled = settings.get().tosuEnabled } = {}) {
      try { dailyBackup(db, dirs.backups); } catch (e) { L.warn(`Резервная копия не создана: ${e.message}`); }
      if (tosuEnabled) tosu.start();
      const s = settings.get();
      if (s.autoScanOnStart && s.songsDir && fs.existsSync(s.songsDir)) {
        indexer.scan().catch((e) => L.warn(`Сканирование при запуске: ${e.message}`));
      } else if (!s.songsDir) {
        detectOsu().then((r) => {
          if (r.found && !settings.get().songsDir) {
            settings.update({ gameDir: r.gameDir, songsDir: r.songsDir });
            L.info(`Найдена osu!: ${r.gameDir} (Songs: ${r.songsDir})`);
            if (settings.get().autoScanOnStart) indexer.scan().catch((e) => L.warn(e.message));
          }
        }).catch(() => {});
      }
      if (api.configured() && (api.hasUser() || s.username)) {
        setTimeout(() => profile.refresh().catch((e) => L.warn(`Профиль при запуске: ${e.message}`)), 3000);
      }
      scheduleProfileRefresh();
    },
    onShutdown(fn) { shutdownHandler = fn; },
    async close() {
      clearInterval(app.profileTimer);
      clearTimeout(profileRefreshTimer);
      tosu.stop();
      indexer.cancel();
      await new Promise((r) => server.close(() => r()));
      server.closeAllConnections?.();
      db.close();
    },
  };
  return app;
}

function summarizeFrame(f) {
  const b = f.beatmap || {};
  return {
    state: f.state?.name,
    client: f.client,
    profile: f.profile ? { name: f.profile.name, pp: f.profile.pp, globalRank: f.profile.globalRank } : null,
    beatmap: { md5: b.checksum, id: b.id, set: b.set, artist: b.artist, title: b.title, version: b.version, mapper: b.mapper, stars: b.stats?.stars?.total, ar: b.stats?.ar?.converted, od: b.stats?.od?.converted, cs: b.stats?.cs?.converted, bpm: b.stats?.bpm?.common, status: b.status?.name },
    play: f.state?.name === 'play' ? {
      player: f.play?.playerName, accuracy: f.play?.accuracy, combo: f.play?.combo?.current, maxCombo: f.play?.combo?.max,
      pp: f.play?.pp?.current, ppFc: f.play?.pp?.fc, mods: f.play?.mods?.name, hits: f.play?.hits, failed: f.play?.failed,
      progress: b.time ? Math.max(0, Math.min(1, (b.time.live - b.time.firstObject) / Math.max(1, b.time.lastObject - b.time.firstObject))) : null,
    } : null,
    results: f.state?.name === 'resultScreen' ? f.resultsScreen : null,
  };
}

function summarizeAttempts(list) {
  const s = { total: list.length, pass: 0, fail: 0, quit: 0, retry: 0, bestProgress: 0 };
  for (const a of list) {
    s[a.outcome] = (s[a.outcome] || 0) + 1;
    if (a.progress != null) s.bestProgress = Math.max(s.bestProgress, a.progress);
  }
  return s;
}

function decorateScore(db, r) {
  const b = r.beatmap_md5 ? db.get('SELECT artist, title, version, md5 FROM beatmaps WHERE md5 = ?', r.beatmap_md5) : null;
  const ab = !b && r.beatmap_id ? db.get('SELECT artist, title, version FROM api_beatmaps WHERE beatmap_id = ?', r.beatmap_id) : null;
  const t = b || ab;
  return { ...r, raw_json: undefined, title: t ? `${t.artist} - ${t.title} [${t.version}]` : r.beatmap_title, local_md5: b?.md5 || null };
}

function clampInt(v, min, max, def) {
  const n = parseInt(v, 10);
  if (!Number.isFinite(n)) return def;
  return Math.max(min, Math.min(max, n));
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}
