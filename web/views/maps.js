import { api, html, raw, fmt, debounce, bindRowLinks, rankBadge, mapImg, starsBadge } from '../lib.js';

const MOD_CHIPS = ['HD', 'HR', 'DT', 'EZ', 'HT', 'FL'];
const SORTS = [
  ['relevance', 'Релевантность'], ['stars', 'Звёзды'], ['pp', 'pp (98%)'], ['bpm', 'BPM'], ['length', 'Длина'],
  ['ar', 'AR'], ['od', 'OD'], ['cs', 'CS'], ['title', 'Название'], ['artist', 'Артист'], ['creator', 'Маппер'],
  ['added', 'Дата добавления'], ['plays', 'Мои scores'], ['mypp', 'Мой лучший pp'], ['myacc', 'Моя точность'], ['lastplayed', 'Последняя игра'],
];
const PAGE = 50;

export async function mapsView(el, { query }, ctx) {
  const state = {
    tab: query.tab || 'local',
    q: query.q || '',
    mods: query.mods || '',
    sort: query.sort || 'relevance',
    order: query.order || '',
    mode: query.mode ?? '',
    offset: 0,
  };

  el.innerHTML = html`
    <div class="row between mb"><h1 style="margin:0">Карты</h1>
      <div class="chips"><span class="chip" data-tab="local">Мои карты (Songs)</span><span class="chip" data-tab="catalog">Каталог osu!</span></div>
    </div>
    <div id="body"></div>`;

  const setTab = (t) => {
    state.tab = t;
    el.querySelectorAll('[data-tab]').forEach((c) => c.classList.toggle('on', c.dataset.tab === t));
    if (t === 'local') localTab();
    else catalogTab();
  };
  el.querySelectorAll('[data-tab]').forEach((c) => c.addEventListener('click', () => setTab(c.dataset.tab)));

  function syncUrl() {
    const p = new URLSearchParams();
    if (state.tab !== 'local') p.set('tab', state.tab);
    if (state.q) p.set('q', state.q);
    if (state.mods) p.set('mods', state.mods);
    if (state.sort !== 'relevance') p.set('sort', state.sort);
    if (state.order) p.set('order', state.order);
    if (state.mode !== '') p.set('mode', state.mode);
    history.replaceState({}, '', `/maps${p.toString() ? '?' + p : ''}`);
  }

  function localTab() {
    const body = el.querySelector('#body');
    body.innerHTML = html`
      <div class="card">
        <input class="search" id="q" placeholder='Поиск: название, артист, маппер, теги… Фильтры: stars>=6 ar>9.3 bpm<200 length<3:00 od>=9 played=no status=ranked' value="${state.q}">
        <div class="row mt">
          <div class="chips">${MOD_CHIPS.map((m) => html`<span class="chip ${state.mods.includes(m) ? 'on' : ''}" data-mod="${m}">${m}</span>`)}</div>
          <select id="mode"><option value="">Все режимы</option><option value="0">osu!</option><option value="1">taiko</option><option value="2">catch</option><option value="3">mania</option></select>
          <select id="sort">${SORTS.map(([k, t]) => html`<option value="${k}">${t}</option>`)}</select>
          <select id="order"><option value="">По умолчанию</option><option value="desc">По убыванию</option><option value="asc">По возрастанию</option></select>
          <span class="spacer"></span><span class="muted small" id="count"></span><div class="chips"><span class="chip" data-view="tiles">▦ Плитки</span><span class="chip" data-view="list">☰ Список</span></div>
        </div>
        <details class="small muted mt"><summary>Синтаксис фильтров</summary>
          <div class="mt">Ключи: <span class="mono">stars sr ar od cs hp bpm length combo objects pp pp95 pp100 mode status played attempts creator artist title diff acc mypp rank id set</span>.
          Операторы: <span class="mono">= != &lt; &lt;= &gt; &gt;=</span> (и <span class="mono">:</span> как =). Длина в секундах или <span class="mono">м:сс</span>.
          С включёнными модами stars/ar/od/cs/bpm/length — эффективные значения (например, DT ускоряет BPM в 1.5 раза). Примеры:
          <span class="mono">stars>=5.5 stars<6.2 length<150 played=no</span>, <span class="mono">artist=camellia bpm>200</span>, <span class="mono">mypp>200 acc<97</span>.</div>
        </details>
      </div>
      <div class="card mt"><div class="table-wrap" id="results"></div><div class="row mt" id="pager"></div></div>`;
    body.querySelector('#mode').value = state.mode;
    body.querySelector('#sort').value = state.sort;
    body.querySelector('#order').value = state.order;
    const run = async () => {
      syncUrl();
      const p = new URLSearchParams({ q: state.q, mods: state.mods, sort: state.sort, limit: PAGE, offset: state.offset });
      if (state.order) p.set('order', state.order);
      if (state.mode !== '') p.set('mode', state.mode);
      const box = body.querySelector('#results');
      try {
        const r = await api(`/api/beatmaps/search?${p}`);
        body.querySelector('#count').textContent = `Найдено: ${fmt.num(r.total)}`;
        const href = (m) => `/map/${m.md5}${state.mods ? '?mods=' + state.mods : ''}`;
        const statusPill = (m) => (m.status ? html`<span class="pill ${['ranked', 'approved'].includes(m.status) ? 'good' : m.status === 'loved' ? 'accent' : ''}">${m.status}</span>` : '');
        const view = localStorage.getItem('mv.mapsView') || 'tiles';
        box.innerHTML = !r.items.length
          ? html`<div class="empty">${r.total === 0 && !state.q ? 'Индекс пуст. Укажите папку Songs в настройках и запустите сканирование.' : 'Ничего не найдено.'}</div>`
          : view === 'tiles'
            ? html`<div class="tiles">${r.items.map((m) => html`<div class="tile" data-href="${href(m)}">
                ${mapImg({ md5: m.md5, local: true, setId: m.beatmapset_id }, 'tile')}
                <div class="tile-top"><span>${starsBadge(m.eff.stars, m.eff.approxStars)}</span><span>${m.my ? html`${rankBadge(m.my.best_rank)}` : ''} ${statusPill(m)}</span></div>
                <div class="tile-body">
                  <div class="tile-title">${m.title}</div>
                  <div class="small" style="color:#d5d8e4">${m.artist} · <b>${m.version}</b></div>
                  <div class="tile-stats"><span>AR ${fmt.num(m.eff.ar, 1)}</span><span>OD ${fmt.num(m.eff.od, 1)}</span><span>CS ${fmt.num(m.eff.cs, 1)}</span><span>${fmt.num(m.eff.bpm)} BPM</span><span>${fmt.len(m.eff.length)}</span></div>
                  <div class="row between" style="margin-top:8px"><span class="small muted">${m.creator}</span><span><b class="grad-text">${fmt.pp0(m.pp_nm_98)}</b> <span class="small muted">98% NM</span>${m.my ? html` · <span class="small">мой ${fmt.pp0(m.my.best_pp)}</span>` : ''}</span></div>
                </div></div>`)}</div>`
            : html`<div class="list">${r.items.map((m) => html`<div class="item" data-href="${href(m)}">
                <div class="img-box">${mapImg({ md5: m.md5, local: true, setId: m.beatmapset_id }, 'thumb')}</div>
                <div style="min-width:0"><div class="item-title">${m.artist} — ${m.title}</div><div class="item-sub">${m.version} · ${m.creator}</div>
                  <div class="item-meta">${starsBadge(m.eff.stars, m.eff.approxStars)}<span class="small muted">AR ${fmt.num(m.eff.ar, 1)} · OD ${fmt.num(m.eff.od, 1)} · CS ${fmt.num(m.eff.cs, 1)} · ${fmt.num(m.eff.bpm)} BPM · ${fmt.len(m.eff.length)}${m.attempts ? ` · попыток ${m.attempts}` : ''}</span>${statusPill(m)}</div></div>
                <div class="item-right">${m.my ? html`${rankBadge(m.my.best_rank)} <span class="small muted">${fmt.acc(m.my.best_acc)}</span>` : ''}<div class="big">${fmt.pp0(m.pp_nm_98)}</div><div class="small muted">98% NM${m.my ? ` · мой ${fmt.pp0(m.my.best_pp)}` : ''}</div></div>
              </div>`)}</div>`;
        bindRowLinks(box, ctx.navigate);
        const pager = body.querySelector('#pager');
        const pages = Math.ceil(r.total / PAGE);
        const cur = Math.floor(state.offset / PAGE);
        pager.innerHTML = pages > 1 ? html`<button id="prev" ${raw(cur === 0 ? 'disabled' : '')}>← Назад</button><span class="muted">стр. ${cur + 1} из ${pages}</span><button id="next" ${raw(cur >= pages - 1 ? 'disabled' : '')}>Вперёд →</button>` : '';
        pager.querySelector('#prev')?.addEventListener('click', () => { state.offset -= PAGE; run(); });
        pager.querySelector('#next')?.addEventListener('click', () => { state.offset += PAGE; run(); });
      } catch (e) {
        box.innerHTML = html`<div class="notice bad">${e.message}</div>`;
      }
    };
    const runDebounced = debounce(() => { state.offset = 0; run(); }, 200);
    body.querySelector('#q').addEventListener('input', (e) => { state.q = e.target.value; runDebounced(); });
    body.querySelector('#q').focus();
    body.querySelectorAll('[data-mod]').forEach((c) => c.addEventListener('click', () => {
      const m = c.dataset.mod;
      let mods = state.mods.match(/.{2}/g) || [];
      if (mods.includes(m)) mods = mods.filter((x) => x !== m);
      else {
        mods.push(m);
        if (m === 'DT') mods = mods.filter((x) => x !== 'HT');
        if (m === 'HT') mods = mods.filter((x) => x !== 'DT');
        if (m === 'HR') mods = mods.filter((x) => x !== 'EZ');
        if (m === 'EZ') mods = mods.filter((x) => x !== 'HR');
      }
      state.mods = mods.join('');
      body.querySelectorAll('[data-mod]').forEach((x) => x.classList.toggle('on', mods.includes(x.dataset.mod)));
      state.offset = 0;
      run();
    }));
    const paintView = () => body.querySelectorAll('[data-view]').forEach((c) => c.classList.toggle('on', c.dataset.view === (localStorage.getItem('mv.mapsView') || 'tiles')));
    paintView();
    body.querySelectorAll('[data-view]').forEach((c) => c.addEventListener('click', () => { localStorage.setItem('mv.mapsView', c.dataset.view); paintView(); run(); }));
    for (const id of ['mode', 'sort', 'order']) body.querySelector(`#${id}`).addEventListener('change', (e) => { state[id] = e.target.value; state.offset = 0; run(); });
    run();
  }

  function catalogTab() {
    syncUrl();
    const body = el.querySelector('#body');
    body.innerHTML = html`
      <div class="card">
        <div class="row">
          <input class="search" style="flex:1" id="cq" placeholder="Поиск по каталогу osu!: название, артист… (поддерживает stars>5 ar>9 и т.п.)" value="${state.q}">
          <select id="cs"><option value="ranked">Ranked</option><option value="loved">Loved</option><option value="qualified">Qualified</option><option value="any">Любой статус</option></select>
          <select id="csort"><option value="">Релевантность</option><option value="plays_desc">Популярные</option><option value="ranked_desc">Новые ранки</option><option value="difficulty_desc">Сложные</option><option value="difficulty_asc">Лёгкие</option></select>
          <button class="primary" id="cgo">Искать</button>
        </div>
        <div class="small muted mt">Данные из osu! API (нужен интернет и настроенный API). Карты, которые уже есть в Songs, отмечены.</div>
      </div>
      <div id="cres" class="mt"></div>`;
    let cursor = null;
    const run = async (more = false) => {
      const box = body.querySelector('#cres');
      if (!more) { cursor = null; box.innerHTML = '<div class="empty">Ищу…</div>'; }
      const p = new URLSearchParams({ q: body.querySelector('#cq').value, s: body.querySelector('#cs').value });
      const sort = body.querySelector('#csort').value;
      if (sort) p.set('sort', sort);
      if (state.mode !== '') p.set('m', state.mode);
      if (more && cursor) p.set('cursor', cursor);
      try {
        const r = await api(`/api/catalog/search?${p}`);
        cursor = r.cursor;
        const items = r.sets.map((s) => html`<div class="farm-card"><img src="https://assets.ppy.sh/beatmaps/${s.id}/covers/cover@2x.jpg" data-fb="" loading="lazy" alt=""><div style="padding:16px">
          <div class="row between"><div><div class="tile-title" style="font-size:18px">${s.title}</div><div class="small" style="color:#d5d8e4">${s.artist} · by ${s.creator}</div><div class="row" style="margin-top:6px"><span class="pill">${s.status}</span> ${s.local ? html`<span class="pill good">есть в Songs</span>` : ''}</div></div>
          <div class="row small"><a href="${s.links.page}" target="_blank" rel="noopener">osu.ppy.sh</a><a href="${s.links.download}" target="_blank" rel="noopener">Скачать</a><a href="${s.links.direct}">osu!direct</a><a href="${s.links.mirror}" target="_blank" rel="noopener">Зеркало</a></div></div>
          <div class="table-wrap mt"><table>${s.beatmaps.map((b) => html`<tr class="click" data-href="/map/id/${b.id}"><td class="title">${b.version}</td><td>${starsBadge(b.stars)}</td><td class="num">AR ${b.ar}</td><td class="num">OD ${b.od}</td><td class="num">CS ${b.cs}</td><td class="num">${fmt.num(b.bpm)} BPM</td><td class="num">${fmt.len(b.length)}</td><td><a href="/pp?beatmapId=${b.id}">pp →</a></td></tr>`)}</table></div>
        </div></div>`);
        if (more) box.insertAdjacentHTML('beforeend', html`${items}`.toString());
        else box.innerHTML = r.sets.length ? html`${items}` : html`<div class="empty">Ничего не найдено.</div>`;
        box.querySelector('#more')?.remove();
        if (cursor) {
          box.insertAdjacentHTML('beforeend', '<div class="row"><button id="more">Ещё</button></div>');
          box.querySelector('#more').addEventListener('click', () => run(true));
        }
        bindRowLinks(box, ctx.navigate);
      } catch (e) {
        box.innerHTML = html`<div class="notice bad">${e.message}</div>`;
      }
    };
    body.querySelector('#cgo').addEventListener('click', () => run());
    body.querySelector('#cq').addEventListener('keydown', (e) => { if (e.key === 'Enter') run(); });
  }

  setTab(state.tab);
}
