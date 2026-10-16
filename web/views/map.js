import { api, html, fmt, scoreRow, scoreHead, bindRowLinks } from '../lib.js';
import { outcome } from './dashboard.js';

const MOD_CHIPS = ['HD', 'HR', 'DT', 'EZ', 'HT', 'FL'];

export async function mapView(el, { md5, beatmapId, query }, ctx) {
  if (!md5 && beatmapId) {
    const r = await api(`/api/beatmaps/by-id/${beatmapId}`);
    if (r.md5) return ctx.navigate(`/map/${r.md5}`, true);
    el.innerHTML = html`<div class="notice">Карта #${beatmapId} не найдена ни в Songs, ни в кэше osu! API. <a href="/pp?beatmapId=${beatmapId}">Посчитать pp по ID →</a></div>`;
    return;
  }
  let mods = query.mods || '';
  const load = async () => {
    const d = await api(`/api/beatmaps/${md5}?mods=${encodeURIComponent(mods)}`);
    paint(d);
  };

  function paint(d) {
    const m = d.local;
    const a = d.api;
    const title = m ? `${m.artist} — ${m.title}` : a ? `${a.artist} — ${a.title}` : md5;
    const version = m?.version || a?.version;
    const bid = m?.beatmap_id || a?.beatmap_id;
    const sid = m?.beatmapset_id || a?.beatmapset_id;
    const e = m?.eff;
    const st = d.attemptStats;
    el.innerHTML = html`
      ${m ? html`<div class="bg-banner" style="background-image:url('/api/beatmaps/${md5}/background')"></div>` : ''}
      <h1>${title} <span class="muted">[${version}]</span></h1>
      <div class="row mb small">
        ${m?.creator || a?.creator ? html`<span class="muted">map by ${m?.creator || a?.creator}</span>` : ''}
        ${(m?.status || a?.status) ? html`<span class="pill">${m?.status || a?.status}</span>` : ''}
        ${m ? html`<span class="pill good">есть в Songs</span>` : html`<span class="pill warn">нет в Songs</span>`}
        ${bid ? html`<a href="https://osu.ppy.sh/b/${bid}" target="_blank" rel="noopener">osu.ppy.sh</a>` : ''}
        ${sid && !m ? html`<a href="https://osu.ppy.sh/beatmapsets/${sid}/download" target="_blank" rel="noopener">Скачать</a> <a href="osu://s/${sid}">osu!direct</a>` : ''}
        <a href="/pp?${md5 ? `md5=${md5}` : `beatmapId=${bid}`}${mods ? `&mods=${mods}` : ''}">PP-калькулятор →</a>
      </div>
      <div class="chips mb">${MOD_CHIPS.map((x) => html`<span class="chip ${mods.includes(x) ? 'on' : ''}" data-mod="${x}">${x}</span>`)}</div>
      <div class="grid cols-2">
        <div class="card"><h3>Параметры ${mods ? `(${mods})` : ''}</h3>
          ${m ? html`<div class="grid cols-4">
            <div class="stat"><div class="v">${fmt.num(d.ppTable?.stars ?? e.stars, 2)}★</div><div class="l">звёзды</div></div>
            <div class="stat"><div class="v">${fmt.num(e.ar, 1)}</div><div class="l">AR</div></div>
            <div class="stat"><div class="v">${fmt.num(e.od, 1)}</div><div class="l">OD</div></div>
            <div class="stat"><div class="v">${fmt.num(e.cs, 1)}</div><div class="l">CS</div></div>
            <div class="stat"><div class="v">${fmt.num(e.hp, 1)}</div><div class="l">HP</div></div>
            <div class="stat"><div class="v">${fmt.num(e.bpm)}</div><div class="l">BPM${m.bpm_min !== m.bpm_max ? ` (${fmt.num(m.bpm_min * e.rate)}–${fmt.num(m.bpm_max * e.rate)})` : ''}</div></div>
            <div class="stat"><div class="v">${fmt.len(e.length)}</div><div class="l">длина (drain)</div></div>
            <div class="stat"><div class="v">${fmt.num(m.max_combo)}x</div><div class="l">макс. комбо</div></div>
          </div>
          <div class="small muted mt">${m.n_circles} кругов · ${m.n_sliders} слайдеров · ${m.n_spinners} спиннеров · aim ${fmt.num(m.aim_nm, 2)} · speed ${fmt.num(m.speed_nm, 2)} (NM)</div>
          <div class="small muted mono mt" style="word-break:break-all">${m.path}</div>`
          : html`<div class="kv"><div>Звёзды (NM)</div><div>${fmt.stars(a?.stars)}</div><div>AR / OD / CS</div><div>${a?.ar} / ${a?.od} / ${a?.cs}</div><div>BPM</div><div>${fmt.num(a?.bpm)}</div><div>Длина</div><div>${fmt.len(a?.length_drain)}</div></div>`}
        </div>
        <div class="card"><h3>pp по точности ${mods ? `(${mods})` : '(NM)'}</h3>
          ${d.ppTable ? html`<table>${d.ppTable.rows.map((r) => html`<tr><td>${r.accuracy}%</td><td class="num"><b>${fmt.pp(r.pp)}</b></td></tr>`)}</table>
            <div class="small muted mt">rosu-pp, без промахов, полное комбо. Точный расчёт с промахами и комбо — в <a href="/pp?md5=${md5}${mods ? `&mods=${mods}` : ''}">калькуляторе</a>.</div>`
          : html`<div class="muted">Нет локального .osu-файла — откройте калькулятор, он скачает карту.</div>`}
        </div>
      </div>
      <div class="card mt"><h2>Мои результаты на карте (${d.scores.length})</h2>
        ${d.scores.length ? html`<div class="table-wrap"><table>${scoreHead(false)}${d.scores.map((s) => scoreRow(s, { showTitle: false }))}</table></div>` : html`<div class="empty">Сохранённых результатов нет.</div>`}
      </div>
      <div class="card mt"><h2>Попытки (${st.total})</h2>
        ${st.total ? html`<div class="row small muted mb">Пассов: ${st.pass} · Фейлов: ${st.fail} · Выходов: ${st.quit} · Рестартов: ${st.retry} · Лучший прогресс: ${Math.round(st.bestProgress * 100)}%</div>
          <div class="table-wrap"><table><tr><th>Итог</th><th class="num">Прогресс</th><th class="num">Точность</th><th class="num">Комбо</th><th class="num">Промахи</th><th>Моды</th><th>Когда</th></tr>
          ${d.attempts.map((x) => html`<tr><td>${outcome(x.outcome)}</td><td class="num">${x.progress != null ? Math.round(x.progress * 100) + '%' : '—'}</td><td class="num">${fmt.acc(x.accuracy)}</td><td class="num">${fmt.num(x.max_combo)}</td><td class="num">${x.nmiss ?? '—'}</td><td>${fmt.mods(x.mods)}</td><td class="muted small">${fmt.date(x.started_at)}</td></tr>`)}
          </table></div>` : html`<div class="empty">Попыток не записано (они пишутся через Tosu).</div>`}
      </div>`;
    el.querySelectorAll('[data-mod]').forEach((c) => c.addEventListener('click', () => {
      const x = c.dataset.mod;
      let list = mods.match(/.{2}/g) || [];
      if (list.includes(x)) list = list.filter((y) => y !== x);
      else {
        list.push(x);
        const conflicts = { DT: 'HT', HT: 'DT', HR: 'EZ', EZ: 'HR' };
        list = list.filter((y) => y !== conflicts[x]);
      }
      mods = list.join('');
      history.replaceState({}, '', `/map/${md5}${mods ? `?mods=${mods}` : ''}`);
      load();
    }));
    bindRowLinks(el, ctx.navigate);
  }

  await load();
  ctx.on('score', load);
}
