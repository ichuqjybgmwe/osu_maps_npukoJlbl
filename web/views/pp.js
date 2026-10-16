import { api, html, fmt, debounce, toast } from '../lib.js';

const CONF = { high: ['good', 'Высокая'], medium: ['warn', 'Средняя'], low: ['bad', 'Низкая'] };

export async function ppView(el, { query }) {
  const target = { md5: query.md5 || '', beatmapId: query.beatmapId || '', title: '' };
  const baseMods = query.mods || '';
  let scenarios = [
    { name: 'A', mods: baseMods, accuracy: 100, misses: 0, combo: '', n100: '', n50: '' },
    { name: 'B', mods: baseMods, accuracy: 98, misses: 0, combo: '', n100: '', n50: '' },
    { name: 'C', mods: baseMods, accuracy: 96, misses: 2, combo: '', n100: '', n50: '' },
  ];
  const settings = await api('/api/settings');
  let lazer = settings.ppMode === 'lazer';

  el.innerHTML = html`
    <h1>PP-калькулятор</h1>
    <div class="card">
      <div class="row">
        <label class="field" style="flex:1">Карта из Songs (поиск)<input id="find" placeholder="Начните вводить название…"></label>
        <label class="field">или ID карты (osu.ppy.sh/b/…)<input id="bid" placeholder="например 129891" value="${target.beatmapId}"></label>
        <label class="field">Правила pp<select id="lazer"><option value="0">osu!stable</option><option value="1">osu!lazer</option></select></label>
      </div>
      <div id="suggest" class="mt"></div>
      <div class="mt" id="target"></div>
    </div>
    <div class="card mt">
      <div class="row between"><h2 style="margin:0">Сценарии</h2><div class="row"><button id="add">+ Сценарий</button><button class="primary" id="calc">Посчитать</button></div></div>
      <div class="small muted mt">Укажите точность <b>или</b> точное число 100/50 (тогда точность считается по ним). Пустое комбо = максимальное. Комбо меньше максимума без промахов считается слайдербрейками.</div>
      <div class="table-wrap mt" id="scen"></div>
    </div>
    <div id="out" class="mt"></div>`;

  el.querySelector('#lazer').value = lazer ? '1' : '0';
  el.querySelector('#lazer').addEventListener('change', (e) => { lazer = e.target.value === '1'; });

  const paintTarget = () => {
    el.querySelector('#target').innerHTML = target.md5 || target.beatmapId
      ? html`<div class="notice info">Выбрано: <b>${target.title || (target.md5 ? `md5 ${target.md5}` : `карта #${target.beatmapId}`)}</b></div>`
      : html`<div class="muted small">Карта не выбрана.</div>`;
  };
  if (target.md5) {
    try {
      const d = await api(`/api/beatmaps/${target.md5}`);
      if (d.local) target.title = `${d.local.artist} — ${d.local.title} [${d.local.version}]`;
    } catch { /* нет в индексе */ }
  }
  paintTarget();

  const find = debounce(async (q) => {
    const box = el.querySelector('#suggest');
    if (!q.trim()) { box.innerHTML = ''; return; }
    const r = await api(`/api/beatmaps/search?q=${encodeURIComponent(q)}&limit=8`);
    box.innerHTML = html`${r.items.map((m) => html`<div class="row small" style="padding:4px 0"><a href="#" data-md5="${m.md5}" data-title="${m.artist} — ${m.title} [${m.version}]">${m.artist} — ${m.title} [${m.version}]</a><span class="muted">${fmt.stars(m.stars_nm)}</span></div>`)}`;
    box.querySelectorAll('[data-md5]').forEach((a) => a.addEventListener('click', (e) => {
      e.preventDefault();
      target.md5 = a.dataset.md5;
      target.beatmapId = '';
      target.title = a.dataset.title;
      el.querySelector('#bid').value = '';
      el.querySelector('#find').value = '';
      box.innerHTML = '';
      paintTarget();
      calc();
    }));
  }, 200);
  el.querySelector('#find').addEventListener('input', (e) => find(e.target.value));
  el.querySelector('#bid').addEventListener('change', (e) => {
    target.beatmapId = e.target.value.replace(/\D/g, '');
    target.md5 = '';
    target.title = '';
    paintTarget();
  });

  const paintScenarios = () => {
    el.querySelector('#scen').innerHTML = html`<table>
      <tr><th></th><th>Моды</th><th>Точность %</th><th>Промахи</th><th>Комбо</th><th>100</th><th>50</th><th></th></tr>
      ${scenarios.map((s, i) => html`<tr data-i="${i}">
        <td><b>${s.name}</b></td>
        <td><input data-k="mods" value="${s.mods}" placeholder="HDDT" style="width:90px"></td>
        <td><input data-k="accuracy" type="number" step="0.01" min="0" max="100" value="${s.accuracy}" style="width:90px"></td>
        <td><input data-k="misses" type="number" min="0" value="${s.misses}" style="width:70px"></td>
        <td><input data-k="combo" type="number" min="0" value="${s.combo}" placeholder="макс" style="width:80px"></td>
        <td><input data-k="n100" type="number" min="0" value="${s.n100}" style="width:70px"></td>
        <td><input data-k="n50" type="number" min="0" value="${s.n50}" style="width:70px"></td>
        <td>${scenarios.length > 1 ? html`<button data-del="${i}">✕</button>` : ''}</td>
      </tr>`)}
    </table>`;
    el.querySelectorAll('#scen input').forEach((inp) => inp.addEventListener('input', () => {
      const i = Number(inp.closest('tr').dataset.i);
      scenarios[i][inp.dataset.k] = inp.value;
    }));
    el.querySelectorAll('[data-del]').forEach((b) => b.addEventListener('click', () => {
      scenarios.splice(Number(b.dataset.del), 1);
      paintScenarios();
    }));
  };
  paintScenarios();
  el.querySelector('#add').addEventListener('click', () => {
    const last = scenarios[scenarios.length - 1];
    scenarios.push({ ...last, name: String.fromCharCode(65 + scenarios.length) });
    paintScenarios();
  });

  async function calc() {
    const out = el.querySelector('#out');
    if (!target.md5 && !target.beatmapId) {
      toast('Выберите карту', 'bad');
      return;
    }
    out.innerHTML = '<div class="empty">Считаю…</div>';
    try {
      const body = {
        md5: target.md5 || undefined,
        beatmapId: target.beatmapId || undefined,
        scenarios: scenarios.map((s) => ({
          mods: s.mods, accuracy: s.accuracy, misses: s.misses, combo: s.combo || undefined,
          n100: s.n100 === '' ? undefined : s.n100, n50: s.n50 === '' ? undefined : s.n50, lazer,
        })),
      };
      const r = await api('/api/pp/calc', { method: 'POST', body });
      if (r.beatmap.title && !target.title) { target.title = r.beatmap.title; paintTarget(); }
      const [cls, label] = CONF[r.confidence.level];
      const best = Math.max(...r.results.map((x) => x.pp));
      out.innerHTML = html`
        <div class="card">
          <div class="row between"><h2 style="margin:0">Результат</h2><span class="pill ${cls}">Достоверность: ${label}</span></div>
          <div class="table-wrap mt"><table>
            <tr><th></th><th>Моды</th><th class="num">pp</th><th class="num">pp если FC</th><th class="num">pp за SS</th><th class="num">Точность</th><th class="num">300/100/50/✕</th><th class="num">Комбо</th><th class="num">★</th><th class="num">AR/OD/CS</th><th class="num">aim/speed/acc</th></tr>
            ${r.results.map((x, i) => html`<tr>
              <td><b>${scenarios[i]?.name || i + 1}</b></td>
              <td>${x.input.mods || 'NM'}</td>
              <td class="num"><b style="${x.pp === best ? 'color:var(--accent)' : ''}">${fmt.pp(x.pp)}</b></td>
              <td class="num">${fmt.pp(x.ppFc)}</td>
              <td class="num">${fmt.pp(x.ppSs)}</td>
              <td class="num">${fmt.acc(x.accuracy ?? x.input.accuracy)}</td>
              <td class="num mono small">${x.state ? `${x.state.n300}/${x.state.n100}/${x.state.n50}/${x.state.misses}` : '—'}</td>
              <td class="num">${fmt.num(x.state?.maxCombo)}/${fmt.num(x.maxCombo)}</td>
              <td class="num">${fmt.num(x.stars, 2)}</td>
              <td class="num">${fmt.num(x.attributes.ar, 1)}/${fmt.num(x.attributes.od, 1)}/${fmt.num(x.attributes.cs, 1)}</td>
              <td class="num small">${fmt.num(x.breakdown.aim)}/${fmt.num(x.breakdown.speed)}/${fmt.num(x.breakdown.accuracy)}</td>
            </tr>`)}
          </table></div>
          <ul class="reasons mt">
            ${r.confidence.notes.map((n) => html`<li>${n}</li>`)}
            ${[...new Set(r.results.flatMap((x) => x.notes))].map((n) => html`<li>${n}</li>`)}
          </ul>
        </div>
        <div class="card mt small muted"><b>Калькулятор:</b> ${r.calculator.name} ${r.calculator.version}. ${r.calculator.notes.join(' ')}</div>`;
    } catch (e) {
      out.innerHTML = html`<div class="notice bad">${e.message}</div>`;
    }
  }
  el.querySelector('#calc').addEventListener('click', calc);
  if (target.md5 || target.beatmapId) calc();
}
