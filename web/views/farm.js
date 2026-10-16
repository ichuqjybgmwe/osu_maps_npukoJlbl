import { api, html, fmt, toast, mapImg, starsBadge, modsBadges } from '../lib.js';

const COMBOS = ['NM', 'HD', 'HR', 'DT', 'HDHR', 'HDDT'];

export async function farmView(el, _p, ctx) {
  const profile = await api('/api/farm/profile');
  let selected = new Set();
  let maxLen = '';

  const comboChips = () => html`${COMBOS.map((c) => html`<span class="chip ${selected.has(c) ? 'on' : ''}" data-combo="${c}">${c}${profile.comboShare[c] ? html` <span class="muted">${Math.round(profile.comboShare[c] * 100)}%</span>` : ''}</span>`)}`;

  el.innerHTML = html`
    <h1>Farm</h1>
    ${profileCard(profile)}
    <div class="card mt">
      <div class="row between"><h2 style="margin:0">Подбор карт</h2>
        <div class="row"><button class="primary" id="local">Мои карты (Songs)</button><button id="online">Новые карты (osu! API)</button></div></div>
      <div class="row mt"><span class="small muted">Моды:</span><div class="chips" id="combos">${comboChips()}</div>
        <label class="field" style="flex-direction:row;align-items:center;gap:6px">макс. длина, сек <input id="maxlen" type="number" min="30" style="width:80px" placeholder="—"></label></div>
      <div class="small muted mt">Без выбора модов Farm проверяет NM и все наборы, которые встречаются хотя бы в 5% вашего топа. Для «новых карт» используется первый выбранный набор.</div>
    </div>
    <div id="advice"></div>
    <div id="out" class="mt"></div>
    <div id="fb" class="mt"></div>`;

  el.querySelector('#combos').addEventListener('click', (e) => {
    const c = e.target.closest('[data-combo]');
    if (!c) return;
    const k = c.dataset.combo;
    if (selected.has(k)) selected.delete(k);
    else selected.add(k);
    el.querySelector('#combos').innerHTML = comboChips();
  });
  el.querySelector('#maxlen').addEventListener('input', (e) => { maxLen = e.target.value; });

  const run = async (kind) => {
    const out = el.querySelector('#out');
    out.innerHTML = '<div class="empty">Считаю прогнозы через rosu-pp…</div>';
    const buttons = el.querySelectorAll('#local, #online');
    buttons.forEach((b) => { b.disabled = true; });
    try {
      const body = kind === 'local'
        ? { combos: [...selected], maxLength: maxLen ? Number(maxLen) : undefined, limit: 50 }
        : { combo: [...selected][0] || 'NM', limit: 20 };
      const r = await api(`/api/farm/${kind}`, { method: 'POST', body });
      if (!r.ok) {
        out.innerHTML = html`<div class="notice">${r.error}</div>`;
        return;
      }
      el.querySelector('#advice').innerHTML = r.modsAdvice?.length
        ? html`<div class="card mt"><h3>Рекомендации по модам</h3><ul class="reasons">${r.modsAdvice.map((a) => html`<li>${a.text}</li>`)}</ul></div>` : '';
      out.innerHTML = r.items.length
        ? html`<div class="small muted mb">${kind === 'local' ? `Проверено ${fmt.num(r.stats.calculated)} вариантов из ${fmt.num(r.stats.candidates)} подходящих (${fmt.num(r.stats.maps)} карт) за ${(r.stats.ms / 1000).toFixed(1)} с.` : `Найдено ${r.stats.sets} мапсетов, скачано для расчёта ${r.stats.downloads}.`}</div>
          ${r.items.map((o) => item(o))}`
        : html`<div class="empty">Подходящих карт не найдено: всё, что в рабочем диапазоне, уже сыграно не хуже прогноза. Попробуйте другие моды или поиск новых карт.</div>`;
    } catch (e) {
      out.innerHTML = html`<div class="notice bad">${e.message}</div>`;
      toast(e.message, 'bad');
    } finally {
      buttons.forEach((b) => { b.disabled = false; });
    }
  };
  el.querySelector('#local').addEventListener('click', () => run('local'));
  el.querySelector('#online').addEventListener('click', () => run('online'));

  const fb = await api('/api/farm/feedback');
  el.querySelector('#fb').innerHTML = feedbackCard(fb);
  ctx.on('score', async () => {
    el.querySelector('#fb').innerHTML = feedbackCard(await api('/api/farm/feedback'));
  });
}

function profileCard(p) {
  if (p.withStars < 5) {
    return html`<div class="notice">Для Farm нужен профиль: минимум 5 лучших результатов со звёздами (сейчас ${p.withStars}). Обновите профиль через osu! API на странице <a href="/profile">Профиль</a> или сыграйте несколько карт с запущенным Tosu.</div>`;
  }
  const s = p.stars;
  return html`<div class="card"><h3>Анализ профиля (${p.source === 'api' ? 'osu! API' : 'локальные scores'}, ${p.plays} scores)</h3>
    <div class="grid cols-4">
      <div class="stat"><div class="v">${fmt.num(s.p25, 2)}–${fmt.num(s.p90, 2)}★</div><div class="l">рабочий диапазон (медиана ${fmt.num(s.median, 2)}★)</div></div>
      <div class="stat"><div class="v">${fmt.pp0(p.entryPp)}</div><div class="l">порог входа в топ-100</div></div>
      <div class="stat"><div class="v">${fmt.acc(p.accuracy.median)}</div><div class="l">медианная точность топ-50</div></div>
      <div class="stat"><div class="v">${fmt.len(p.length.median)}</div><div class="l">типичная длина · ${fmt.num(p.bpm.median)} BPM</div></div>
    </div>
    <div class="small muted mt">Модель точности: ${fmt.num(p.model.b, 2)}% за каждую звезду (по ${p.model.n} scores)${p.model.biasSamples ? `, поправка по реальным результатам ${p.model.bias >= 0 ? '+' : ''}${fmt.num(p.model.bias, 2)}% (${p.model.biasSamples} сыгранных рекомендаций)` : ''}.
    Моды в топе: ${Object.entries(p.comboShare).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${Math.round(v * 100)}%`).join(', ')}.</div>
  </div>`;
}

function item(o) {
  const link = o.md5 && o.kind === 'local' ? `/map/${o.md5}?mods=${o.mods === 'NM' ? '' : o.mods}` : `/map/id/${o.beatmap_id}`;
  return html`<div class="farm-card">${mapImg({ md5: o.md5, local: o.kind === 'local', setId: o.beatmapset_id }, 'tile')}<div class="farm-item">
    <div class="farm-score" title="Farm Score: насколько выгодна карта (100 — лучшая в подборке)">${o.farmScore}</div>
    <div>
      <div><a href="${link}"><b>${o.title}</b></a> ${modsBadges(o.mods === 'NM' ? '' : o.mods)} ${o.status ? html`<span class="pill">${o.status}</span>` : ''} ${o.kind === 'online' ? html`<span class="pill warn">нет в Songs</span>` : ''}</div>
      <div class="small muted" style="margin-top:4px">${starsBadge(o.stars, o.approxStars)} AR ${fmt.num(o.ar, 1)} · OD ${fmt.num(o.od, 1)} · ${fmt.num(o.bpm)} BPM · ${fmt.len(o.length)} · map by ${o.creator}</div>
      <ul class="reasons">${o.reasons.map((r) => html`<li>${r}</li>`)}</ul>
      ${o.alternatives?.length ? html`<div class="small muted">Также: ${o.alternatives.map((a) => `${a.mods} ${Math.round(a.predictedPp)}pp (+${a.gain.toFixed(1)})`).join(' · ')}</div>` : ''}
      ${o.links ? html`<div class="row small mt"><a href="${o.links.page}" target="_blank" rel="noopener">osu.ppy.sh</a><a href="${o.links.download}" target="_blank" rel="noopener">Скачать</a><a href="${o.links.direct}">osu!direct</a><a href="${o.links.mirror}" target="_blank" rel="noopener">Зеркало</a></div>` : ''}
    </div>
    <div class="num"><div style="font-size:18px;font-weight:600;color:var(--good)">+${o.gain.toFixed(1)}pp</div><div class="small muted">${fmt.pp0(o.predictedPp)} при ${fmt.acc(o.predictedAcc)}</div>${o.existingPp ? html`<div class="small muted">сейчас ${fmt.pp0(o.existingPp)}</div>` : ''}<div class="small muted">шанс ${Math.round(o.probability * 100)}%</div></div>
  </div></div>`;
}

function feedbackCard(fb) {
  return html`<div class="card"><h2>Обратная связь: прогноз vs реальность</h2>
    ${fb.items.length ? html`<div class="small muted mb">По ${fb.samples} сыгранным рекомендациям прогноз точности смещается на ${fb.bias >= 0 ? '+' : ''}${fmt.num(fb.bias, 2)}% — это учитывается в следующих подборках.</div>
      <div class="table-wrap"><table><tr><th>Карта</th><th>Моды</th><th class="num">Прогноз</th><th class="num">Факт</th><th class="num">pp прогноз</th><th class="num">pp факт</th><th>Когда</th></tr>
      ${fb.items.map((i) => html`<tr><td class="title">${i.title}</td><td>${i.mods}</td><td class="num">${fmt.acc(i.predicted_acc)}</td><td class="num" style="color:${i.actual_acc >= i.predicted_acc ? 'var(--good)' : 'var(--bad)'}">${i.passed ? fmt.acc(i.actual_acc) : 'фейл'}</td><td class="num">${fmt.pp0(i.predicted_pp)}</td><td class="num">${fmt.pp0(i.actual_pp)}</td><td class="muted small">${fmt.ago(i.played_at)}</td></tr>`)}
      </table></div>`
      : html`<div class="empty">Сыграйте рекомендованные карты — здесь появится сравнение прогноза с реальным результатом, и Farm подстроит модель под вас.</div>`}
  </div>`;
}
