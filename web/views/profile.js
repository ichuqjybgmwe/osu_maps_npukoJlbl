import { api, html, fmt, scoreRow, scoreHead, bindRowLinks, lineChart, toast } from '../lib.js';
import { outcome } from './dashboard.js';

export async function profileView(el, _p, ctx) {
  let tab = 'top';
  const [summary, top, recent, attempts] = await Promise.all([
    api('/api/profile'), api('/api/profile/top'), api('/api/profile/recent?limit=100'), api('/api/attempts?limit=200'),
  ]);
  const u = summary.user;
  const snap = summary.snapshot;
  const lt = summary.lifetime;

  const paint = () => {
    el.innerHTML = html`
      <div class="row between mb"><h1 style="margin:0">Профиль</h1>
        <div class="row">
          ${summary.apiConfigured ? html`<button class="primary" id="refresh">Обновить из osu! API</button>` : html`<a href="/settings">Подключить osu! API →</a>`}
        </div>
      </div>
      ${summary.lastError ? html`<div class="notice bad mb">Последнее обновление не удалось: ${summary.lastError}</div>` : ''}
      ${!u ? html`<div class="notice info mb">Данные osu! API ещё не загружены. ${summary.apiConfigured ? 'Нажмите «Обновить из osu! API».' : 'Подключите API в настройках.'} Ниже — локальная статистика по сохранённым scores.</div>` : ''}
      <div class="grid cols-4">
        <div class="card stat"><div class="v">${u ? u.username : '—'}</div><div class="l">${u?.country_code || ''} ${snap?.global_rank ? `#${fmt.num(snap.global_rank)} в мире` : ''}</div></div>
        <div class="card stat"><div class="v">${fmt.pp(snap?.pp ?? summary.top.weighted)}</div><div class="l">${snap ? 'pp профиля (osu! API)' : 'pp по локальным scores (≈, без бонуса)'}</div></div>
        <div class="card stat"><div class="v">${fmt.acc(snap?.accuracy)}</div><div class="l">точность профиля</div></div>
        <div class="card stat"><div class="v">${fmt.num(snap?.play_count)}</div><div class="l">play count</div></div>
      </div>

      <div class="grid cols-2 mt">
        <div class="card"><h3>Lifetime pp</h3>
          <div class="grid cols-3">
            <div class="stat"><div class="v" style="color:var(--good)">+${fmt.num(lt.gained, 1)}</div><div class="l">набрано pp за всё время</div></div>
            <div class="stat"><div class="v" style="color:var(--bad)">−${fmt.num(lt.lost, 1)}</div><div class="l">потеряно (реворки, анранк)</div></div>
            <div class="stat"><div class="v">${lt.pendingGain > 0.05 ? `+${fmt.num(lt.pendingGain, 1)}` : '0'}</div><div class="l">ожидается после синхронизации</div></div>
          </div>
          <canvas class="chart mt" id="ppchart"></canvas>
          <div class="small muted">Считается по изменениям общего pp аккаунта между снимками профиля${lt.firstAt ? ` (с ${fmt.date(lt.firstAt)})` : ''}, а не суммой pp каждого score: score, который не попадает в топ или хуже прежнего на той же карте, профиль не увеличивает. Между синхронизациями прирост оценивается пересчётом взвешенной суммы топа.</div>
        </div>
        <div class="card"><h3>Активность</h3>
          <div class="kv">
            <div>Сохранено scores</div><div>${fmt.num(summary.counts.scores)} (Tosu: ${fmt.num(summary.counts.from_tosu)}, API: ${fmt.num(summary.counts.from_api)})</div>
            <div>Попыток записано</div><div>${fmt.num(summary.attempts.total)}</div>
            <div>Пассов / фейлов / выходов</div><div>${fmt.num(summary.attempts.passes)} / ${fmt.num(summary.attempts.fails)} / ${fmt.num(summary.attempts.quits)}</div>
            <div>Топ</div><div>${summary.top.count} scores (${summary.top.source === 'api' ? 'из osu! API' : 'локальный'}), взвешенно ${fmt.pp(summary.top.weighted)}</div>
            <div>Синхронизация</div><div>${fmt.ago(summary.lastRefresh || snap?.taken_at)}</div>
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
    const canvas = el.querySelector('#ppchart');
    lineChart(canvas, (lt.history || []).map((h) => ({ x: new Date(h.t).getTime(), y: h.pp })), { label: (v) => Math.round(v) });
    el.querySelectorAll('[data-tab]').forEach((c) => c.addEventListener('click', () => { tab = c.dataset.tab; paint(); }));
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
    if (tab === 'top') {
      box.innerHTML = top.rows.length
        ? html`<div class="table-wrap"><table><tr><th>#</th><th>Карта</th><th>Ранг</th><th class="num">pp</th><th class="num">Взвеш.</th><th class="num">Точность</th><th>Моды</th><th class="num">Комбо</th><th class="num">Промахи</th><th>Когда</th></tr>
          ${top.rows.map((s, i) => html`<tr class="click" data-href="${s.beatmap_md5 ? `/map/${s.beatmap_md5}` : `/map/id/${s.beatmap_id}`}"><td class="muted">${i + 1}</td><td class="title">${s.title}</td><td>${s.rank || ''}</td><td class="num">${fmt.pp(s.pp ?? s.pp_calc)}</td><td class="num muted">${fmt.pp((s.pp ?? s.pp_calc) * 0.95 ** i)}</td><td class="num">${fmt.acc(s.accuracy)}</td><td>${fmt.mods(s.mods)}</td><td class="num">${fmt.num(s.max_combo)}x</td><td class="num">${s.nmiss}</td><td class="muted small">${fmt.ago(s.played_at)}</td></tr>`)}
          </table></div>`
        : html`<div class="empty">Топ пуст. Обновите профиль через osu! API или сыграйте карты с Tosu.</div>`;
    } else if (tab === 'recent') {
      box.innerHTML = recent.length ? html`<div class="table-wrap"><table>${scoreHead()}${recent.map((s) => scoreRow(s))}</table></div>` : html`<div class="empty">Нет результатов.</div>`;
    } else {
      box.innerHTML = attempts.length
        ? html`<div class="table-wrap"><table><tr><th>Карта</th><th>Итог</th><th class="num">Прогресс</th><th class="num">Точность</th><th class="num">Комбо</th><th class="num">Промахи</th><th>Моды</th><th>Начало</th></tr>
          ${attempts.map((a) => html`<tr class="click" data-href="/map/${a.beatmap_md5}"><td class="title">${a.title || a.beatmap_md5}</td><td>${outcome(a.outcome)}</td><td class="num">${a.progress != null ? Math.round(a.progress * 100) + '%' : '—'}</td><td class="num">${fmt.acc(a.accuracy)}</td><td class="num">${fmt.num(a.max_combo)}</td><td class="num">${a.nmiss ?? '—'}</td><td>${fmt.mods(a.mods)}</td><td class="muted small">${fmt.date(a.started_at)}</td></tr>`)}
          </table></div>`
        : html`<div class="empty">Попытки записываются автоматически, пока запущен Tosu.</div>`;
    }
    bindRowLinks(box, ctx.navigate);
  }

  paint();
  ctx.on('profile', () => profileView(el, _p, ctx));
  ctx.on('score', () => profileView(el, _p, ctx));
}
