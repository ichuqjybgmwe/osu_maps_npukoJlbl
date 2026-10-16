// Маршрутизация и живые обновления (SSE).
import { api, toast, fmt, setAmbient } from './lib.js';
import { dashboardView } from './views/dashboard.js';
import { profileView } from './views/profile.js';
import { mapsView } from './views/maps.js';
import { mapView } from './views/map.js';
import { ppView } from './views/pp.js';
import { farmView } from './views/farm.js';
import { settingsView } from './views/settings.js';

const routes = [
  [/^\/$/, dashboardView],
  [/^\/profile$/, profileView],
  [/^\/maps$/, mapsView],
  [/^\/map\/id\/(\d+)$/, mapView, (m) => ({ beatmapId: m[1] })],
  [/^\/map\/([0-9a-f]{32})$/, mapView, (m) => ({ md5: m[1] })],
  [/^\/pp$/, ppView],
  [/^\/farm$/, farmView],
  [/^\/settings$/, settingsView],
];

const view = document.getElementById('view');
const listeners = new Map(); // тип события -> Set(fn) текущей страницы
let cleanup = null;

export const ctx = {
  navigate,
  on(type, fn) {
    if (!listeners.has(type)) listeners.set(type, new Set());
    listeners.get(type).add(fn);
  },
  status: null,
};

function navigate(path, replace = false) {
  if (replace) history.replaceState({}, '', path);
  else history.pushState({}, '', path);
  renderRoute();
}

async function renderRoute() {
  const url = new URL(location.href);
  if (cleanup) { try { cleanup(); } catch { /* ignore */ } cleanup = null; }
  listeners.clear();
  document.querySelectorAll('[data-nav]').forEach((a) => {
    const href = a.getAttribute('href');
    a.classList.toggle('active', href === '/' ? url.pathname === '/' : url.pathname.startsWith(href) || (href === '/maps' && url.pathname.startsWith('/map/')));
  });
  for (const [re, fn, paramsOf] of routes) {
    const m = re.exec(url.pathname);
    if (!m) continue;
    view.innerHTML = '<div class="empty">Загрузка…</div>';
    try {
      cleanup = (await fn(view, { ...(paramsOf ? paramsOf(m) : {}), query: Object.fromEntries(url.searchParams) }, ctx)) || null;
    } catch (e) {
      view.innerHTML = `<div class="notice bad">Ошибка: ${e.message}</div>`;
    }
    window.scrollTo(0, 0);
    return;
  }
  view.innerHTML = '<div class="empty">Страница не найдена</div>';
}

document.addEventListener('click', (e) => {
  const a = e.target.closest('a');
  if (!a || a.target === '_blank' || e.ctrlKey || e.metaKey || e.button !== 0) return;
  const href = a.getAttribute('href');
  if (!href || !href.startsWith('/') || href.startsWith('/api/')) return;
  e.preventDefault();
  navigate(href);
});
window.addEventListener('popstate', renderRoute);

// --- статус подключения в боковой панели ---
function setDot(id, cls, text) {
  document.getElementById(`dot-${id}`).className = `dot ${cls}`;
  document.getElementById(`st-${id}`).textContent = text;
}

function paintTosu(t) {
  if (!t) return;
  if (!t.enabled && t.enabled !== undefined) return setDot('tosu', '', 'выключен');
  if (t.state === 'connected') setDot('tosu', 'ok', t.client || 'подключён');
  else if (t.state === 'connecting' || t.state === 'waiting') setDot('tosu', 'warn', 'ожидание');
  else setDot('tosu', 'bad', 'нет связи');
}

function paintStatus(s) {
  ctx.status = s;
  paintTosu(s.tosu);
  if (!s.osuApi.configured) setDot('api', '', 'не настроен');
  else if (s.osuApi.lastError) setDot('api', 'warn', 'ошибка');
  else setDot('api', 'ok', s.osuApi.loggedIn ? s.osuApi.user?.username || 'вход выполнен' : 'публичный');
  const ix = s.indexer;
  if (!s.osu.songsDir) setDot('songs', 'bad', 'не найдена');
  else if (ix.running) setDot('songs', 'warn', `${Math.round((ix.done / (ix.total || 1)) * 100)}%`);
  else setDot('songs', s.osu.songsExists ? 'ok' : 'bad', s.osu.songsExists ? `${fmt.num(ix.indexed)} карт` : 'нет папки');
}

async function refreshStatus() {
  try {
    paintStatus(await api('/api/status'));
  } catch {
    setDot('tosu', 'bad', 'сервер?');
  }
}

function connectEvents() {
  const es = new EventSource('/api/events');
  const dispatch = (type) => (ev) => {
    let data = null;
    try { data = JSON.parse(ev.data); } catch { /* ignore */ }
    if (type === 'tosu') paintTosu({ ...data, enabled: ctx.status?.tosu?.enabled });
    if (type === 'indexer' && data && ctx.status) {
      ctx.status.indexer = data;
      paintStatus(ctx.status);
    }
    if (type === 'result' && data) {
      const gain = data.gain?.gain;
      toast(`Сохранён результат: ${data.title || ''} ${data.mods || 'NM'} ${data.accuracy?.toFixed(2)}% — ${fmt.pp(data.pp)}${gain != null ? (gain > 0.05 ? `, ≈ +${gain.toFixed(1)}pp к профилю` : ', в профиль не идёт') : ''}`);
    }
    if (type === 'nowpp' && data) setAmbient({ md5: data.md5, local: data.local, setId: data.setId });
    if (type === 'now' && !data) setAmbient(null);
    if (type === 'indexer' && !data) return;
    for (const fn of listeners.get(type) || []) {
      try { fn(data); } catch (e) { console.error(e); }
    }
  };
  for (const t of ['tosu', 'now', 'nowpp', 'indexer', 'score', 'result', 'attempt', 'profile']) es.addEventListener(t, dispatch(t));
  es.onerror = () => setDot('tosu', 'bad', 'сервер?');
  es.onopen = () => refreshStatus();
}

document.getElementById('quit-app').addEventListener('click', async () => {
  if (!confirm('Закрыть MapVault? Все данные сохранены. Запущенный им tosu тоже закроется.')) return;
  try { await api('/api/shutdown', { method: 'POST' }); } catch { /* сервер уже закрывается */ }
  document.body.innerHTML = '<div class="empty" style="grid-column:1/-1;margin-top:20vh;font-size:18px">MapVault закрыт. Запустите его снова из меню «Пуск», чтобы продолжить.</div>';
});

refreshStatus().then(() => {
  const n = ctx.status?.nowPp;
  if (n) setAmbient({ md5: n.md5, local: n.local, setId: n.setId });
});
setInterval(refreshStatus, 15000);
connectEvents();
renderRoute();
