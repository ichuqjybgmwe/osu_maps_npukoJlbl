import { api, html, raw, fmt, scoreItem, bindRowLinks, lineChart, toast } from '../lib.js';
import { attemptItem } from './dashboard.js';

export async function profileView(el, _p, ctx) {
  let tab = 'top';
  let shown = 50;
  const [summary, top, recent, attempts] = await Promise.all([
    api('/api/profile'), api('/api/profile/top'), api('/api/profile/recent?limit=100'), api('/api/attempts?limit=200'),
  ]);
  const u = summary.user;
  const snap = summary.snapshot;
  const lt = summary.lifetime;

  const paint = () => {
    el.innerHTML = html`
      <div class="profile-head">
        ${u?.cover_url ? raw(`<img class="cover" src="${u.cover_url}" data-fb="" alt="">`) : ''}
        <div class="profile-inner">
          ${u?.avatar_url ? raw(`<img class="avatar" src="${u.avatar_url}" alt="">`) : raw('<div class="avatar"></div>')}
          <div>
            <div class="profile-name">${u ? u.username : 'Профиль'}</div>
            <div class="muted">${u?.country_code || ''} ${snap?.global_rank ? `· #${fmt.num(snap.global_rank)} в мире` : ''} ${snap?.country_rank ? `· #${fmt.num(snap.country_rank)} в стране` : ''}</div>
            <div class="row mt">
              ${summary.apiConfigured ? html`<button class="primary" id="refresh">Обновить из osu! API</button>` : html`<a href="/settings"><button class="primary">Подключить osu! API</button></a>`}
              <span class="small muted">синхронизация: ${fmt.ago(summary.lastRefresh || snap?.taken_at)}</span>
            </div>
          </div>
          <div class="profile-stats">
            <div class="stat"><div class="v grad-text">${fmt.pp(snap?.pp ?? summary.top.weighted)}</div><div class="l">${snap ? 'pp профиля' : 'pp по локальным scores (≈)'}</div></div>
            <div class="stat"><div class="v">${fmt.acc(snap?.accuracy)}</div><div class="l">точность</div></div>
            <div class="stat"><div class="v">${fmt.num(snap?.play_count)}</div><div class="l">play count</div></div>
          </div>
        </div>
      </div>
      ${summary.lastError ? html`<div class="notice bad mt">Последнее обновление не удалось: ${summary.lastError}</div>` : ''}

      <div class="grid cols-2 mt">
        <div class="card"><h3>Lifetime pp</h3>
          <div class="grid cols-3">
            <div class="stat"><div class="v" style="color:var(--good)">+${fmt.num(lt.gained, 1)}</div><div class="l">набрано за всё время</div></div>
            <div class="stat"><div class="v" style="color:var(--bad)">−${fmt.num(lt.lost, 1)}</div><div class="l">потеряно (реворки)</div></div>
            <div class="stat"><div class="v">${lt.pendingGain > 0.05 ? `+${fmt.num(lt.pendingGain, 1)}` : '0'}</div><div class="l">ожидается после синхр.</div></div>
          </div>
          <canvas class="chart mt" id="ppchart"></canvas>
          <div class="small muted">Считается по реальным изменениям pp аккаунта${lt.firstAt ? ` с ${fmt.date(lt.firstAt)}` : ''}. Первое значение появится после того, как pp профиля изменится (сыграйте что-нибудь в топ).</div>
        </div>
        <div class="card"><h3>Активность</h3>
          <div class="grid cols-3">
            <div class="stat"><div class="v">${fmt.num(summary.counts.scores)}</div><div class="l">scores сохранено</div></div>
            <div class="stat"><div class="v">${fmt.num(summary.attempts.total)}</div><div class="l">попыток</div></div>
            <div class="stat"><div class="v">${summary.top.count}</div><div class="l">в топе</div></div>
          </div>
          <div class="kv mt small">
            <div>Источники</div><div>tosu: ${fmt.num(summary.counts.from_tosu)} · osu! API: ${fmt.num(summary.counts.from_api)}</div>
            <div>Пассы / фейлы / выходы</div><div>${fmt.num(summary.attempts.passes)} / ${fmt.num(summary.attempts.fails)} / ${fmt.num(summary.attempts.quits)}</div>
            <div>Топ (взвешенно)</div><div>${fmt.pp(summary.top.weighted)} · ${summary.top.source === 'api' ? 'из osu! API' : 'локальный'}</div>
          </div>
        </div>
      </div>

      <div class="card mt">
        <div class="chips mb">
          ${[['top', `Top plays (${top.rows.length})`], ['recent', `Recent (${recent.length})`], ['attempts', `История попыток (${attempts.length})`]].map(([k, t]) => html`<span class="chip ${tab === k ? 'on' : ''}" data-tab="${k}">${t}</span>`)}
        </div>
        <div id="tab"></div>
      </div>`;
    paintTab();
    lineChart(el.querySelector('#ppchart'), (lt.history || []).map((h) => ({ x: new Date(h.t).getTime(), y: h.pp })), { label: (v) => Math.round(v) });
    el.querySelectorAll('[data-tab]').forEach((c) => c.addEventListener('click', () => { tab = c.dataset.tab; shown = 50; paint(); }));
    el.querySelector('#refresh')?.addEventListener('click', async (e) => {
      e.target.disabled = true;
      e.target.textContent = 'Обновляю…';
      try {
        const r = await api('/api/profile/refresh', { method: 'POST' });
        toast(`Профиль обновлён: ${r.top} top, ${r.recent} recent, новых scores: ${r.inserted}`);
        profileView(el, _p, ctx);
      } catch (err) {
        toast(err.message, 'bad');
        e.target.disabled = false;
        e.target.textContent = 'Обновить из osu! API';
      }
    });
  };

  function paintTab() {
    const box = el.querySelector('#tab');
    let items = [];
    if (tab === 'top') items = top.rows.map((s, i) => html`<div style="display:grid;grid-template-columns:34px 1fr;align-items:center;gap:6px"><div class="muted" style="text-align:right;font-weight:600">#${i + 1}</div>${scoreItem(s)}</div>`);
    else if (tab === 'recent') items = recent.map((s) => scoreItem(s));
    else items = attempts.map((a) => attemptItem(a));
    box.innerHTML = items.length
      ? html`<div class="list">${items.slice(0, shown)}</div>${items.length > shown ? html`<div class="row mt"><button id="more">Показать ещё (${items.length - shown})</button></div>` : ''}`
      : html`<div class="empty">${tab === 'attempts' ? 'Попытки записываются автоматически, пока запущен tosu.' : 'Пусто. Обновите профиль через osu! API или сыграйте карты с tosu.'}</div>`;
    box.querySelector('#more')?.addEventListener('click', () => { shown += 50; paintTab(); });
    bindRowLinks(box, ctx.navigate);
  }

  paint();
  ctx.on('profile', () => profileView(el, _p, ctx));
  ctx.on('score', () => profileView(el, _p, ctx));
}
