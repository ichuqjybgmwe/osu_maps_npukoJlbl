// Клиент osu! API v2.
// Поддерживаются два способа авторизации:
//  1) client_credentials — только публичные данные (профиль по нику, top/recent, поиск карт);
//  2) authorization_code — вход своей учётной записью (scope identify public), даёт /me.
// Ограничения API: ppy просит не больше ~60 запросов в минуту; токены живут сутки.
import { log } from '../logger.js';

const L = log('osu-api');

const BASE = 'https://osu.ppy.sh';
export const MODES = ['osu', 'taiko', 'fruits', 'mania'];

export class OsuApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// Токен-бакет: в среднем 1 запрос в секунду, короткие всплески до 10.
class RateLimiter {
  constructor({ perMinute = 60, burst = 10 } = {}) {
    this.capacity = burst;
    this.tokens = burst;
    this.refillMs = 60000 / perMinute;
    this.last = Date.now();
    this.queue = Promise.resolve();
  }

  take() {
    const run = async () => {
      for (;;) {
        const now = Date.now();
        this.tokens = Math.min(this.capacity, this.tokens + (now - this.last) / this.refillMs);
        this.last = now;
        if (this.tokens >= 1) {
          this.tokens -= 1;
          return;
        }
        await new Promise((r) => setTimeout(r, Math.ceil((1 - this.tokens) * this.refillMs)));
      }
    };
    this.queue = this.queue.then(run, run);
    return this.queue;
  }
}

export class OsuApi {
  /**
   * @param {{ getConfig: () => any, saveTokens: (t:any) => void, fetchImpl?: typeof fetch }} opts
   */
  constructor({ getConfig, saveTokens, fetchImpl = globalThis.fetch }) {
    this.getConfig = getConfig;
    this.saveTokens = saveTokens;
    this.fetch = fetchImpl;
    this.limiter = new RateLimiter();
    this.appToken = null; // client_credentials, в памяти
    this.lastError = null;
  }

  configured() {
    const c = this.getConfig();
    return !!(c.clientId && c.clientSecret);
  }

  hasUser() {
    const t = this.getConfig().userToken;
    return !!(t && t.refresh_token);
  }

  authorizeUrl(redirectUri, state) {
    const c = this.getConfig();
    const p = new URLSearchParams({ client_id: String(c.clientId), redirect_uri: redirectUri, response_type: 'code', scope: 'identify public', state });
    return `${BASE}/oauth/authorize?${p}`;
  }

  async tokenRequest(body) {
    const c = this.getConfig();
    const res = await this.fetch(`${BASE}/oauth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ client_id: Number(c.clientId), client_secret: c.clientSecret, ...body }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new OsuApiError(res.status, data.error_description || data.message || data.error || `OAuth ошибка ${res.status}`);
    }
    return { ...data, expires_at: Date.now() + (data.expires_in || 86400) * 1000 - 60000 };
  }

  async exchangeCode(code, redirectUri) {
    const t = await this.tokenRequest({ grant_type: 'authorization_code', code, redirect_uri: redirectUri });
    this.saveTokens(t);
    return t;
  }

  async getAccessToken({ preferUser = true } = {}) {
    if (!this.configured()) throw new OsuApiError(0, 'osu! API не настроен: укажите Client ID и Client Secret в настройках');
    const c = this.getConfig();
    if (preferUser && c.userToken?.refresh_token) {
      if (c.userToken.access_token && c.userToken.expires_at > Date.now()) return c.userToken.access_token;
      try {
        const t = await this.tokenRequest({ grant_type: 'refresh_token', refresh_token: c.userToken.refresh_token, scope: 'identify public' });
        this.saveTokens(t);
        return t.access_token;
      } catch (e) {
        L.warn(`Не удалось обновить пользовательский токен: ${e.message}. Использую токен приложения.`);
        if (e.status === 400 || e.status === 401) this.saveTokens(null);
      }
    }
    if (this.appToken && this.appToken.expires_at > Date.now()) return this.appToken.access_token;
    this.appToken = await this.tokenRequest({ grant_type: 'client_credentials', scope: 'public' });
    return this.appToken.access_token;
  }

  async request(path, { query, preferUser = true, retry = true } = {}) {
    const token = await this.getAccessToken({ preferUser });
    await this.limiter.take();
    const url = new URL(`${BASE}/api/v2${path}`);
    if (query) {
      for (const [k, v] of Object.entries(query)) {
        if (v == null || v === '') continue;
        if (Array.isArray(v)) v.forEach((x) => url.searchParams.append(`${k}[]`, String(x)));
        else url.searchParams.set(k, String(v));
      }
    }
    let res;
    try {
      res = await this.fetch(url, {
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/json', 'x-api-version': '20240529' },
        signal: AbortSignal.timeout(20000),
      });
    } catch (e) {
      this.lastError = `Сеть недоступна: ${e.message}`;
      throw new OsuApiError(0, this.lastError);
    }
    if (res.status === 401 && retry) {
      this.appToken = null;
      const c = this.getConfig();
      if (c.userToken) this.saveTokens({ ...c.userToken, expires_at: 0 });
      return this.request(path, { query, preferUser, retry: false });
    }
    if (res.status === 429 && retry) {
      await new Promise((r) => setTimeout(r, 5000));
      return this.request(path, { query, preferUser, retry: false });
    }
    if (res.status === 404) return null;
    const data = await res.json().catch(() => null);
    if (!res.ok) {
      this.lastError = data?.error || `HTTP ${res.status}`;
      throw new OsuApiError(res.status, `osu! API: ${this.lastError}`);
    }
    this.lastError = null;
    return data;
  }

  me(mode) { return this.request(`/me/${mode || ''}`.replace(/\/$/, ''), { preferUser: true }); }
  user(user, mode) {
    const key = typeof user === 'number' || /^\d+$/.test(String(user)) ? 'id' : 'username';
    const u = key === 'username' ? `@${encodeURIComponent(user)}` : user;
    return this.request(`/users/${u}/${mode || 'osu'}`);
  }
  userScores(userId, type, { mode = 'osu', limit = 100, offset = 0, includeFails = false } = {}) {
    return this.request(`/users/${userId}/scores/${type}`, { query: { mode, limit, offset, include_fails: includeFails ? 1 : 0, legacy_only: 0 } });
  }
  userBeatmapScores(beatmapId, userId, mode = 'osu') {
    return this.request(`/beatmaps/${beatmapId}/scores/users/${userId}/all`, { query: { mode, legacy_only: 0 } });
  }
  beatmap(id) { return this.request(`/beatmaps/${id}`); }
  lookupBeatmap({ checksum, id }) { return this.request('/beatmaps/lookup', { query: { checksum, id } }); }
  beatmaps(ids) { return this.request('/beatmaps', { query: { ids } }); }
  searchBeatmapsets(params) { return this.request('/beatmapsets/search', { query: params }); }

  /** Скачать .osu-файл (без авторизации). */
  async downloadOsuFile(beatmapId) {
    await this.limiter.take();
    const res = await this.fetch(`${BASE}/osu/${beatmapId}`, { signal: AbortSignal.timeout(20000) });
    if (!res.ok) throw new OsuApiError(res.status, `Не удалось скачать .osu для карты ${beatmapId}: HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    if (!buf.length) throw new OsuApiError(404, `Карта ${beatmapId} не найдена на osu.ppy.sh`);
    return buf;
  }
}
