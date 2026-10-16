// Настройки хранятся в той же SQLite-базе (таблица settings).
export const DEFAULT_SETTINGS = {
  port: 47420,
  openBrowser: true,
  gameDir: null,
  songsDir: null,
  tosuUrl: 'ws://127.0.0.1:24050/websocket/v2',
  tosuEnabled: true,
  tosuPath: '',         // путь к tosu.exe — MapVault запустит его сам, без окна
  tosuAutostart: true,
  mode: 0,              // 0 osu!, 1 taiko, 2 catch, 3 mania
  ppMode: 'stable',     // stable | lazer — какие правила pp использовать в калькуляторе
  username: '',         // ник для публичного профиля (если вход через osu! не выполнен)
  clientId: '',
  clientSecret: '',
  autoScanOnStart: true,
  profileRefreshMinutes: 15,
};

const PUBLIC_EXCLUDE = new Set(['clientSecret']);

export function createSettings(db) {
  const get = () => ({ ...DEFAULT_SETTINGS, ...(db.getSetting('app.settings', {}) || {}) });
  return {
    get,
    update(patch) {
      const cur = get();
      const next = { ...cur };
      for (const [k, v] of Object.entries(patch || {})) {
        if (!(k in DEFAULT_SETTINGS)) continue;
        if (k === 'clientSecret' && (v === '' || v === '********')) continue; // не затираем секрет пустым полем
        next[k] = coerce(k, v);
      }
      db.setSetting('app.settings', next);
      return next;
    },
    public() {
      const s = get();
      const out = {};
      for (const [k, v] of Object.entries(s)) out[k] = PUBLIC_EXCLUDE.has(k) ? (v ? '********' : '') : v;
      return out;
    },
    userToken: () => db.getSetting('osu.userToken', null),
    setUserToken: (t) => db.setSetting('osu.userToken', t),
  };
}

function coerce(key, v) {
  const def = DEFAULT_SETTINGS[key];
  if (typeof def === 'number') {
    const n = Number(v);
    return Number.isFinite(n) ? n : def;
  }
  if (typeof def === 'boolean') return v === true || v === 'true' || v === 1;
  if (key === 'ppMode') return v === 'lazer' ? 'lazer' : 'stable';
  if (v == null) return null;
  return String(v).trim();
}
