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

export function scoreRow(s, { showTitle = true } = {}) {
  const pp = s.pp ?? s.pp_calc;
  const link = s.beatmap_md5 ? `/map/${s.beatmap_md5}` : s.beatmap_id ? `/map/id/${s.beatmap_id}` : null;
  return html`<tr class="${link ? 'click' : ''}" ${raw(link ? `data-href="${esc(link)}"` : '')}>
    ${showTitle ? html`<td class="title">${s.title || s.beatmap_title || `#${s.beatmap_id || s.beatmap_md5}`}</td>` : ''}
    <td>${rankBadge(s.passed ? s.rank : 'F')}</td>
    <td class="num">${fmt.pp(pp)}${s.pp == null && s.pp_calc != null ? html` <span class="muted small" title="Рассчитано rosu-pp">≈</span>` : ''}</td>
    <td class="num">${fmt.acc(s.accuracy)}</td>
    <td>${fmt.mods(s.mods)}</td>
    <td class="num">${fmt.num(s.max_combo)}x${s.map_max_combo ? html`<span class="muted">/${s.map_max_combo}</span>` : ''}</td>
    <td class="num">${s.nmiss ? html`<span style="color:var(--bad)">${s.nmiss}✕</span>` : html`<span class="muted">0✕</span>`}</td>
    <td class="muted small">${fmt.ago(s.played_at)}</td>
    <td>${(s.sources || '').split(',').map((x) => html`<span class="pill">${x}</span> `)}</td>
  </tr>`;
}

export const scoreHead = (showTitle = true) => html`<tr>${showTitle ? html`<th>Карта</th>` : ''}<th>Ранг</th><th class="num">pp</th><th class="num">Точность</th><th>Моды</th><th class="num">Комбо</th><th class="num">Промахи</th><th>Когда</th><th>Источник</th></tr>`;

/** Делегирование кликов по строкам с data-href. */
export function bindRowLinks(root, navigate) {
  root.querySelectorAll('tr[data-href]').forEach((tr) => {
    tr.addEventListener('click', (e) => {
      if (e.target.closest('a,button,input')) return;
      navigate(tr.dataset.href);
    });
  });
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
