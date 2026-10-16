// Общие помощники интерфейса.
export async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(path, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = null;
  try { data = await res.json(); } catch { /* пустой ответ */ }
  if (!res.ok) throw new Error(data?.error || `Ошибка ${res.status}`);
  return data;
}

export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/** Шаблонная строка с автоматическим экранированием. raw(...) — вставка без экранирования. */
export function html(strings, ...vals) {
  let out = '';
  strings.forEach((s, i) => {
    out += s;
    if (i < vals.length) out += render(vals[i]);
  });
  return new Raw(out);
}
class Raw { constructor(s) { this.s = s; } toString() { return this.s; } }
export const raw = (s) => new Raw(String(s ?? ''));
function render(v) {
  if (v == null || v === false) return '';
  if (v instanceof Raw) return v.s;
  if (Array.isArray(v)) return v.map(render).join('');
  return esc(v);
}

export const fmt = {
  pp: (v) => (v == null ? '—' : `${Math.round(v * 10) / 10 >= 1000 ? Math.round(v).toLocaleString('ru-RU') : (Math.round(v * 10) / 10).toLocaleString('ru-RU')}pp`),
  pp0: (v) => (v == null ? '—' : `${Math.round(v).toLocaleString('ru-RU')}pp`),
  acc: (v) => (v == null ? '—' : `${Number(v).toFixed(2)}%`),
  stars: (v) => (v == null ? '—' : `${Number(v).toFixed(2)}★`),
  num: (v, d = 0) => (v == null ? '—' : Number(v).toLocaleString('ru-RU', { maximumFractionDigits: d, minimumFractionDigits: d })),
  len: (s) => (s == null ? '—' : `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')}`),
  date: (s) => (s ? new Date(s).toLocaleString('ru-RU', { dateStyle: 'short', timeStyle: 'short' }) : '—'),
  ago(s) {
    if (!s) return '—';
    const d = (Date.now() - new Date(s).getTime()) / 1000;
    if (d < 60) return 'только что';
    if (d < 3600) return `${Math.floor(d / 60)} мин назад`;
    if (d < 86400) return `${Math.floor(d / 3600)} ч назад`;
    if (d < 86400 * 30) return `${Math.floor(d / 86400)} дн назад`;
    return fmt.date(s);
  },
  mods: (m) => (m ? m : 'NM'),
};

export const rankBadge = (r) => (r ? html`<span class="rank rank-${r}">${r.replace('XH', 'SS').replace('X', 'SS').replace('SH', 'S')}</span>` : '');

export function toast(text, kind = '') {
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.textContent = text;
  document.getElementById('toasts').appendChild(el);
  setTimeout(() => el.remove(), 6000);
}

export function debounce(fn, ms) {
  let t;
  return (...a) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...a), ms);
  };
}

export const MODES = ['osu!', 'taiko', 'catch', 'mania'];

// ---------- картинки карт ----------
// Источники: фон из вашей папки Songs (точный, работает без интернета) и обложки
// с сервера osu! (лёгкие, нужны ID мапсета и интернет). Если картинка не загрузилась,
// пробуем следующую из data-fb, а если кончились — прячем, остаётся градиент.
const COVER = (setId, kind) => `https://assets.ppy.sh/beatmaps/${setId}/covers/${kind}.jpg`;

export function imgSources({ md5, local = true, setId }, kind = 'card') {
  const localUrl = md5 && local ? `/api/beatmaps/${md5}/background` : null;
  const cdn = setId ? COVER(setId, kind === 'hero' ? 'cover@2x' : kind === 'thumb' ? 'list@2x' : 'card@2x') : null;
  // Для крупных картинок — сначала свой фон (полное разрешение), для мелких — лёгкая обложка.
  const order = kind === 'hero' || kind === 'tile' ? [localUrl, cdn, setId && COVER(setId, 'card@2x')] : [cdn, localUrl];
  return [...new Set(order.filter(Boolean))];
}

export function mapImg(opts, kind = 'card', cls = '') {
  const [first, ...rest] = imgSources(opts, kind);
  if (!first) return raw(`<img class="${cls} img-missing" alt="">`);
  return raw(`<img class="${cls}" src="${esc(first)}" data-fb="${esc(rest.join('|'))}" loading="lazy" decoding="async" alt="">`);
}

document.addEventListener('error', (e) => {
  const img = e.target;
  if (!(img instanceof HTMLImageElement) || !img.dataset) return;
  const list = (img.dataset.fb || '').split('|').filter(Boolean);
  if (list.length) {
    img.dataset.fb = list.slice(1).join('|');
    img.src = list[0];
  } else {
    img.classList.add('img-missing');
  }
}, true);

// Цвет звёзд как в osu!: от голубого через зелёный и жёлтый к красному и фиолетовому.
const STAR_STOPS = [[0.1, '#4290fb'], [1.25, '#4fc0ff'], [2, '#4fffd5'], [2.5, '#7cff4f'], [3.3, '#f6f05c'], [4.2, '#ff8068'], [4.9, '#ff4e6f'], [5.8, '#c645b8'], [6.7, '#6563de'], [7.7, '#18158e'], [9, '#000000']];
function hex(h) { return [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16)); }
export function starColor(v) {
  if (v == null) return '#555';
  if (v <= STAR_STOPS[0][0]) return STAR_STOPS[0][1];
  for (let i = 1; i < STAR_STOPS.length; i++) {
    const [b, cb] = STAR_STOPS[i];
    const [a, ca] = STAR_STOPS[i - 1];
    if (v <= b) {
      const t = (v - a) / (b - a);
      const x = hex(ca);
      const y = hex(cb);
      return `rgb(${x.map((c, k) => Math.round(c + (y[k] - c) * t)).join(',')})`;
    }
  }
  return '#000';
}
export const starsBadge = (v, approx = false) => (v == null ? '' : raw(`<span class="stars" style="background:${starColor(v)};color:${v >= 6.5 ? '#ffd966' : '#111'}">★ ${Number(v).toFixed(2)}${approx ? '≈' : ''}</span>`));
export const modsBadges = (m) => {
  const list = (m || '').match(/.{2}/g) || ['NM'];
  return raw(list.map((x) => `<span class="mod mod-${esc(x)}">${esc(x)}</span>`).join(''));
};

/** Элемент списка результата: обложка, карта, ранг, pp. */
export function scoreItem(s, { showTitle = true } = {}) {
  const pp = s.pp ?? s.pp_calc;
  const md5 = s.local_md5 || s.beatmap_md5;
  const link = s.beatmap_md5 ? `/map/${s.beatmap_md5}` : s.beatmap_id ? `/map/id/${s.beatmap_id}` : '';
  const title = s.title || s.beatmap_title || `#${s.beatmap_id || s.beatmap_md5}`;
  const [song, diff] = splitTitle(title);
  return html`<div class="item" data-href="${link}">
    <div class="img-box">${mapImg({ md5, local: !!s.local_md5, setId: s.beatmapset_id }, 'thumb')}</div>
    <div style="min-width:0">
      ${showTitle ? html`<div class="item-title">${song}</div><div class="item-sub">${diff}</div>` : html`<div class="item-title">${fmt.acc(s.accuracy)} · ${fmt.num(s.max_combo)}x${s.map_max_combo ? `/${s.map_max_combo}` : ''}</div>`}
      <div class="item-meta">${modsBadges(s.mods)}
        <span class="small muted">${showTitle ? `${fmt.acc(s.accuracy)} · ${fmt.num(s.max_combo)}x` : ''}${s.nmiss ? ` · ${s.nmiss}✕` : ''} · ${fmt.ago(s.played_at)}</span>
        ${(s.sources || '').split(',').filter(Boolean).map((x) => html`<span class="pill">${x}</span>`)}</div>
    </div>
    <div class="item-right">${rankBadge(s.passed ? s.rank : 'F')}<div class="big">${fmt.pp(pp)}${s.pp == null && pp != null ? html`<span class="muted small" title="Рассчитано rosu-pp"> ≈</span>` : ''}</div></div>
  </div>`;
}

export function splitTitle(t) {
  const m = /^(.*)\s\[(.*)\]$/.exec(t || '');
  return m ? [m[1], m[2]] : [t || '', ''];
}

// Совместимость: табличная строка результата (используется на старых экранах).
export const scoreRow = (s, o) => scoreItem(s, o);
export const scoreHead = () => '';

/** Клики по любым элементам с data-href (строки, плитки, карточки). */
export function bindRowLinks(root, navigate) {
  root.querySelectorAll('[data-href]').forEach((el) => {
    if (!el.dataset.href) return;
    el.addEventListener('click', (e) => {
      if (e.target.closest('a,button,input,select')) return;
      navigate(el.dataset.href);
    });
  });
}

/** Фон всего приложения — размытый bg текущей карты. */
export function setAmbient(opts) {
  const el = document.getElementById('ambient-img');
  if (!el) return;
  if (!opts) { el.classList.remove('on'); return; }
  const srcs = imgSources(opts, 'hero');
  if (!srcs.length) return;
  const img = new Image();
  let i = 0;
  img.onload = () => { el.style.backgroundImage = `url("${img.src}")`; el.classList.add('on'); };
  img.onerror = () => { if (++i < srcs.length) img.src = srcs[i]; };
  img.src = srcs[0];
}

/** Простой линейный график на canvas. */
export function lineChart(canvas, points, { color = '#ff66aa', label = (v) => v } = {}) {
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  canvas.width = w * dpr;
  canvas.height = h * dpr;
  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, w, h);
  if (points.length < 2) {
    ctx.fillStyle = '#8b8fa0';
    ctx.font = '12px system-ui';
    ctx.fillText('Недостаточно точек для графика — данные накопятся со временем', 8, h / 2);
    return;
  }
  const ys = points.map((p) => p.y);
  const min = Math.min(...ys);
  const max = Math.max(...ys);
  const pad = (max - min) * 0.1 || 1;
  const x0 = points[0].x;
  const x1 = points[points.length - 1].x;
  const X = (x) => 40 + ((x - x0) / (x1 - x0 || 1)) * (w - 50);
  const Y = (y) => h - 18 - ((y - (min - pad)) / (max - min + 2 * pad)) * (h - 30);
  ctx.strokeStyle = '#2a2d36';
  ctx.fillStyle = '#8b8fa0';
  ctx.font = '11px system-ui';
  for (const v of [min, max]) {
    ctx.beginPath();
    ctx.moveTo(40, Y(v));
    ctx.lineTo(w - 10, Y(v));
    ctx.stroke();
    ctx.fillText(label(v), 0, Y(v) + 4);
  }
  ctx.strokeStyle = color;
  ctx.lineWidth = 2;
  ctx.beginPath();
  points.forEach((p, i) => (i ? ctx.lineTo(X(p.x), Y(p.y)) : ctx.moveTo(X(p.x), Y(p.y))));
  ctx.stroke();
}
