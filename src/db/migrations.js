// Каждый элемент — одна миграция. Существующие элементы не меняем,
// новые изменения схемы добавляем в конец массива.
export const migrations = [
  `
  CREATE TABLE settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  -- Локальные карты из папки Songs.
  CREATE TABLE beatmaps (
    md5 TEXT PRIMARY KEY,
    beatmap_id INTEGER,
    beatmapset_id INTEGER,
    folder TEXT NOT NULL,
    file TEXT NOT NULL,
    file_size INTEGER NOT NULL,
    file_mtime INTEGER NOT NULL,
    mode INTEGER NOT NULL DEFAULT 0,
    title TEXT, title_unicode TEXT, artist TEXT, artist_unicode TEXT,
    creator TEXT, version TEXT, source TEXT, tags TEXT,
    ar REAL, cs REAL, od REAL, hp REAL,
    bpm_min REAL, bpm_max REAL, bpm_main REAL,
    length_drain INTEGER, length_total INTEGER,
    n_circles INTEGER, n_sliders INTEGER, n_spinners INTEGER,
    max_combo INTEGER,
    stars_nm REAL, stars_hr REAL, stars_dt REAL, stars_ez REAL, stars_ht REAL,
    aim_nm REAL, speed_nm REAL,
    pp_nm_95 REAL, pp_nm_98 REAL, pp_nm_100 REAL,
    calc_error TEXT,
    status TEXT,            -- ranked/loved/... (из osu! API, если подключён)
    status_checked_at TEXT,
    indexed_at TEXT NOT NULL,
    missing INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX beatmaps_bid ON beatmaps(beatmap_id);
  CREATE INDEX beatmaps_sid ON beatmaps(beatmapset_id);
  CREATE INDEX beatmaps_stars ON beatmaps(stars_nm);
  CREATE INDEX beatmaps_path ON beatmaps(folder, file);

  CREATE VIRTUAL TABLE beatmaps_fts USING fts5(
    md5 UNINDEXED, title, artist, creator, version, source, tags,
    tokenize = 'unicode61 remove_diacritics 2'
  );

  -- Результаты. dedup_key гарантирует, что один и тот же score
  -- (из Tosu, из osu! API, повторно) хранится ровно один раз.
  CREATE TABLE scores (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    dedup_key TEXT NOT NULL UNIQUE,
    sources TEXT NOT NULL,              -- 'tosu', 'api', 'tosu,api'
    api_score_id INTEGER,
    beatmap_md5 TEXT,
    beatmap_id INTEGER,
    beatmapset_id INTEGER,
    mode INTEGER NOT NULL DEFAULT 0,
    user_id INTEGER,
    player_name TEXT,
    score INTEGER NOT NULL,
    accuracy REAL NOT NULL,             -- 0..100
    max_combo INTEGER NOT NULL,
    n300 INTEGER NOT NULL DEFAULT 0, n100 INTEGER NOT NULL DEFAULT 0,
    n50 INTEGER NOT NULL DEFAULT 0, nmiss INTEGER NOT NULL DEFAULT 0,
    ngeki INTEGER NOT NULL DEFAULT 0, nkatu INTEGER NOT NULL DEFAULT 0,
    slider_end_hits INTEGER, small_tick_hits INTEGER, large_tick_hits INTEGER,
    mods TEXT NOT NULL DEFAULT '',      -- 'HDDT' (без CL), канонический порядок
    mods_json TEXT,
    rate REAL NOT NULL DEFAULT 1,
    rank TEXT,
    passed INTEGER NOT NULL DEFAULT 1,
    pp REAL,                            -- pp от osu! (API) или Tosu
    pp_calc REAL,                       -- наш пересчёт rosu-pp
    pp_fc REAL,
    stars REAL,
    lazer INTEGER NOT NULL DEFAULT 0,
    played_at TEXT,
    saved_at TEXT NOT NULL,
    beatmap_title TEXT,                 -- снимок для карт, которых нет локально
    raw_json TEXT
  );
  CREATE INDEX scores_md5 ON scores(beatmap_md5);
  CREATE INDEX scores_bid ON scores(beatmap_id);
  CREATE INDEX scores_played ON scores(played_at);
  CREATE UNIQUE INDEX scores_api_id ON scores(api_score_id) WHERE api_score_id IS NOT NULL;

  -- Каждая попытка (включая фейлы, рестарты и выходы), видимая через Tosu.
  CREATE TABLE attempts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    beatmap_md5 TEXT,
    beatmap_id INTEGER,
    mode INTEGER NOT NULL DEFAULT 0,
    mods TEXT NOT NULL DEFAULT '',
    started_at TEXT NOT NULL,
    ended_at TEXT,
    outcome TEXT,                       -- pass / fail / quit / retry
    progress REAL,                      -- 0..1 по времени карты
    accuracy REAL, max_combo INTEGER, nmiss INTEGER,
    score INTEGER,
    pp_current REAL,
    score_id INTEGER REFERENCES scores(id) ON DELETE SET NULL,
    player_name TEXT
  );
  CREATE INDEX attempts_md5 ON attempts(beatmap_md5);
  CREATE INDEX attempts_started ON attempts(started_at);

  -- Снимки профиля из osu! API: основа корректного lifetime pp.
  CREATE TABLE profile_snapshots (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    mode INTEGER NOT NULL,
    taken_at TEXT NOT NULL,
    pp REAL, global_rank INTEGER, country_rank INTEGER,
    accuracy REAL, play_count INTEGER, ranked_score INTEGER,
    raw_json TEXT
  );
  CREATE INDEX profile_snapshots_user ON profile_snapshots(user_id, mode, taken_at);

  -- Текущий список лучших результатов (top plays) из API.
  CREATE TABLE top_plays (
    user_id INTEGER NOT NULL,
    mode INTEGER NOT NULL,
    position INTEGER NOT NULL,
    score_id INTEGER NOT NULL REFERENCES scores(id) ON DELETE CASCADE,
    weighted_pp REAL,
    fetched_at TEXT NOT NULL,
    PRIMARY KEY (user_id, mode, position)
  );

  -- Кэш метаданных карт из API (для карт, которых нет локально).
  CREATE TABLE api_beatmaps (
    beatmap_id INTEGER PRIMARY KEY,
    beatmapset_id INTEGER,
    checksum TEXT,
    mode INTEGER,
    status TEXT,
    title TEXT, artist TEXT, creator TEXT, version TEXT,
    stars REAL, ar REAL, cs REAL, od REAL, hp REAL, bpm REAL,
    length_drain INTEGER, max_combo INTEGER,
    fetched_at TEXT NOT NULL,
    raw_json TEXT
  );
  CREATE INDEX api_beatmaps_checksum ON api_beatmaps(checksum);

  -- Что Farm рекомендовал, чтобы потом сравнить с реальным результатом.
  CREATE TABLE farm_recommendations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at TEXT NOT NULL,
    beatmap_md5 TEXT,
    beatmap_id INTEGER,
    mods TEXT NOT NULL,
    predicted_acc REAL,
    predicted_pp REAL,
    predicted_gain REAL,
    farm_score REAL,
    UNIQUE (beatmap_md5, beatmap_id, mods)
  );
  `,
];
