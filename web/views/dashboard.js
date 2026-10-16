import { api, html, raw, fmt, scoreItem, bindRowLinks, mapImg, starsBadge, modsBadges } from '../lib.js';

const STATE_NAMES = { play: 'Играет', resultScreen: 'Результат', selectPlay: 'Выбор карты', menu: 'Главное меню', selectEdit: 'Редактор', edit: 'Редактор', selectMulti: 'Мультиплеер', lobby: 'Мультиплеер' };

function heroOffline(tosu) {
  return html`<div class="hero"><div class="hero-bg"></div><div class="hero-inner" style="grid-template-columns:1fr">
    <div><div class="hero-state">Сейчас в игре</div>
    <div class="hero-title">Tosu не подключён</div>
    <div class="hero-artist muted">${tosu?.lastError || 'Ждём подключения…'}</div>
    <p class="muted" style="max-width:640px">Запустите <b>tosu</b> вместе с osu! (или укажите путь к tosu.exe в настройках — MapVault будет запускать его сам, без окна).
    Здесь появится выбранная карта, сколько pp она даёт и какая нужна точность. Пока tosu нет, все сохранённые данные доступны.</p>
    <a href="/settings"><button class="primary">Настроить tosu</button></a></div></div></div>`;
}

function hero(now, np, tosu) {
  if (!tosu || tosu.state !== 'connected') return heroOffline(tosu);
  if (!now) return html`<div class="hero"><div class="hero-bg"></div><div class="hero-inner"><div><div class="hero-state">Сейчас в игре</div><div class="hero-title">Ждём данные от osu!…</div></div></div></div>`;
  const b = now.beatmap || {};
  const p = now.play;
  const sameMap = np && np.md5 === b.md5;
  const info = sameMap ? np : null;
  const mods = info?.mods ?? (p?.mods || '');
  const attrs = info?.attrs || { ar: b.ar, od: b.od, cs: b.cs };
  const playing = now.state === 'play' && p;
  return html`<div class="hero">
    <div class="hero-bg">${mapImg({ md5: b.md5, local: info ? info.local : true, setId: b.set }, 'hero')}</div>
    <div class="hero-inner">
      <div>
        <div class="hero-state">${playing ? raw('<span class="live"></span>') : ''}${STATE_NAMES[now.state] || now.state || ''}</div>
        <div class="hero-title">${b.title || ''}</div>
        <div class="hero-artist">${b.artist || ''}</div>
        <div class="hero-diff">${starsBadge(info?.stars ?? b.stars)} <b>${b.version || ''}</b> <span class="muted">· ${b.mapper || ''}</span> ${b.status ? html`<span class="pill">${b.status}</span>` : ''} ${modsBadges(mods)}</div>
        <div class="attr-row">
          <div class="attr"><div class="k">AR</div><div class="v">${fmt.num(attrs.ar, 1)}</div></div>
          <div class="attr"><div class="k">OD</div><div class="v">${fmt.num(attrs.od, 1)}</div></div>
          <div class="attr"><div class="k">CS</div><div class="v">${fmt.num(attrs.cs, 1)}</div></div>
          <div class="attr"><div class="k">BPM</div><div class="v">${fmt.num(info?.bpm ?? b.bpm)}</div></div>
          ${info?.length ? html`<div class="attr"><div class="k">Длина</div><div class="v">${fmt.len(info.length)}</div></div>` : ''}
          ${info?.maxCombo ? html`<div class="attr"><div class="k">Комбо</div><div class="v">${fmt.num(info.maxCombo)}x</div></div>` : ''}
        </div>
        ${playing ? html`
          <div class="live-grid">
            <div class="stat"><div class="v grad-text">${fmt.pp(p.pp)}</div><div class="l">сейчас · FC ${fmt.pp(p.ppFc)}</div></div>
            <div class="stat"><div class="v">${fmt.acc(p.accuracy)}</div><div class="l">точность</div></div>
            <div class="stat"><div class="v">${fmt.num(p.combo)}x</div><div class="l">комбо · макс ${fmt.num(p.maxCombo)}</div></div>
            <div class="stat"><div class="v" style="color:${p.hits?.['0'] ? 'var(--bad)' : 'inherit'}">${p.hits?.['0'] ?? 0}✕</div><div class="l">${p.hits?.['100'] ?? 0}×100 · ${p.hits?.['50'] ?? 0}×50</div></div>
          </div>
          <div class="progress mt"><div style="width:${Math.round((p.progress || 0) * 100)}%"></div></div>` : ''}
        ${b.md5 ? html`<div class="row mt small"><a href="/map/${b.md5}">Страница карты →</a><a href="/pp?md5=${b.md5}${mods ? `&mods=${mods}` : ''}">PP-калькулятор →</a></div>` : ''}
      </div>
      ${ppPanel(info, mods)}
    </div>
  </div>`;
}

function ppPanel(info, mods) {
  if (!info) return html`<div class="pp-panel"><h3>pp</h3><div class="muted">Считаю pp для этой карты…</div></div>`;
  const ss = info.table.find((t) => t.accuracy === 100);
  return html`<div class="pp-panel">
    <div class="row between"><h3 style="margin:0">pp ${mods ? `с ${mods}` : 'NM'}</h3>${info.exact === false ? html`<span class="pill warn" title="Версия карты отличается или расчёт взят из tosu">≈</span>` : ''}</div>
    <div class="row" style="align-items:baseline;gap:8px;margin:6px 0 12px"><span class="pp-big grad-text">${fmt.pp0(ss?.pp)}</span><span class="muted">за SS</span></div>
    <div class="acc-grid">
      ${info.table.filter((t) => t.accuracy !== 100).map((t) => html`<div class="acc-cell"><div class="a">${t.accuracy}%</div><div class="p">${fmt.pp0(t.pp)}</div>${t.gain != null ? html`<div class="g">${t.gain > 0.05 ? `+${t.gain.toFixed(1)}pp профилю` : '—'}</div>` : ''}</div>`)}
      ${ss ? html`<div class="acc-cell ss"><div class="a">100%</div><div class="p">${fmt.pp0(ss.pp)}</div>${ss.gain != null ? html`<div class="g">${ss.gain > 0.05 ? `+${ss.gain.toFixed(1)}pp` : '—'}</div>` : ''}</div>` : ''}
    </div>
    ${info.targets?.length ? html`<div class="targets">${info.targets.map((t) => html`<div class="target"><span>${t.label}${t.targetPp ? html` <span class="muted">(${fmt.pp0(t.targetPp)})</span>` : ''}</span>${t.reachable ? html`<b>${fmt.acc(t.accuracy)}</b>` : html`<span class="muted">недостижимо</span>`}</div>`)}</div>` : ''}
    <details class="more"><summary>Подробнее</summary>
      <div class="kv small mt">
        ${info.myBest ? html`<div>Мой лучший</div><div>${fmt.pp(info.myBest.pp)} · ${fmt.acc(info.myBest.accuracy)}</div>` : html`<div>Мой лучший</div><div>не сыграна</div>`}
        ${info.breakdown ? html`<div>SS: aim / speed / acc</div><div>${fmt.num(info.breakdown.aim)} / ${fmt.num(info.breakdown.speed)} / ${fmt.num(info.breakdown.accuracy)} pp</div>` : ''}
        <div>Правила</div><div>${info.lazer ? 'osu!lazer' : 'osu!stable'}</div>
        <div>Файл карты</div><div>${{ local: 'из Songs', cache: 'из кэша', download: 'скачан с osu.ppy.sh', tosu: 'расчёт tosu' }[info.source] || info.source}</div>
        <div>Цели</div><div>точность без промахов и с полным комбо</div>
      </div>
    </details>
  </div>`;
}

export async function dashboardView(el, _p, ctx) {
  const [status, recent, attempts] = await Promise.all([api('/api/status'), api('/api/scores?limit=8'), api('/api/attempts?limit=8')]);
  let now = status.now;
  let np = status.nowPp;
  let tosu = status.tosu;

  const setup = () => {
    const steps = [];
    if (!status.osu.songsDir) steps.push(html`<li>Папка Songs не найдена — <a href="/settings">Настройки → «Найти osu!»</a>.</li>`);
    if (!status.osuApi.configured) steps.push(html`<li>osu! API не подключён — профиль и каталог недоступны. <a href="/settings">Подключить</a>.</li>`);
    if (tosu.state !== 'connected' && tosu.enabled) steps.push(html`<li>tosu не запущен — результаты не сохраняются автоматически. <a href="/settings">Настроить автозапуск</a>.</li>`);
    return steps.length ? html`<div class="notice info mb"><b>Что осталось настроить</b><ul class="reasons">${steps}</ul></div>` : '';
  };

  el.innerHTML = html`
    ${setup()}
    <div id="hero">${hero(now, np, tosu)}</div>
    <div class="grid cols-4 mt">
      <div class="card stat"><div class="v">${fmt.num(status.counts.scores)}</div><div class="l">сохранённых scores</div></div>
      <div class="card stat"><div class="v">${fmt.num(status.counts.attempts)}</div><div class="l">попыток записано</div></div>
      <div class="card stat"><div class="v">${fmt.num(status.counts.beatmaps)}</div><div class="l">карт в Songs</div></div>
      <div class="card stat"><div class="v">${status.osuApi.user ? status.osuApi.user.username : '—'}</div><div class="l">профиль osu!</div></div>
    </div>
    <div class="grid cols-2 mt">
      <div class="card"><div class="row between"><h2>Последние результаты</h2><a href="/profile">Все →</a></div>
        ${recent.length ? html`<div class="list">${recent.map((s) => scoreItem(s))}</div>` : html`<div class="empty">Пока пусто. Сыграйте карту с запущенным tosu или обновите профиль.</div>`}
      </div>
      <div class="card"><h2>Последние попытки</h2>
        ${attempts.length ? html`<div class="list">${attempts.map((a) => attemptItem(a))}</div>` : html`<div class="empty">Попытки (пассы, фейлы, рестарты) записываются, пока работает tosu.</div>`}
      </div>
    </div>`;
  bindRowLinks(el, ctx.navigate);

  const repaint = () => {
    const box = el.querySelector('#hero');
    if (!box) return;
    // Не перерисовываем картинку на каждом кадре, если карта та же — только содержимое.
    const open = box.querySelector('details.more')?.open;
    const md5 = now?.beatmap?.md5 || '';
    const tmp = document.createElement('div');
    tmp.innerHTML = hero(now, np, tosu);
    const oldInner = box.querySelector('.hero-inner');
    const newInner = tmp.querySelector('.hero-inner');
    if (box.dataset.md5 === md5 && md5 && oldInner && newInner && box.querySelector('.hero-bg img')) {
      oldInner.replaceWith(newInner); // та же карта: фон не трогаем, чтобы не мигал
    } else {
      box.replaceChildren(...tmp.childNodes);
      box.dataset.md5 = md5;
    }
    if (open) box.querySelector('details.more')?.setAttribute('open', '');
  };
  ctx.on('now', (n) => { now = n; repaint(); });
  ctx.on('nowpp', (d) => { np = d; repaint(); });
  ctx.on('tosu', (t) => { tosu = { ...tosu, ...t }; repaint(); });
  ctx.on('score', () => dashboardView(el, _p, ctx));
}

export function attemptItem(a) {
  const [song, diff] = (a.title || '').match(/^(.*)\s\[(.*)\]$/)?.slice(1) || [a.title || a.beatmap_md5, ''];
  return html`<div class="item" data-href="${a.beatmap_md5 ? `/map/${a.beatmap_md5}` : ''}">
    <div class="img-box">${mapImg({ md5: a.local_md5 || a.beatmap_md5, local: !!a.local_md5, setId: a.beatmapset_id }, 'thumb')}</div>
    <div style="min-width:0"><div class="item-title">${song}</div><div class="item-sub">${diff}</div>
      <div class="item-meta">${modsBadges(a.mods)}<span class="small muted">${fmt.acc(a.accuracy)}${a.nmiss ? ` · ${a.nmiss}✕` : ''} · ${fmt.ago(a.started_at)}</span></div></div>
    <div class="item-right">${outcome(a.outcome)}<div class="small muted mt" style="margin-top:6px">${a.progress != null ? Math.round(a.progress * 100) + '%' : ''}</div></div>
  </div>`;
}

export function outcome(o) {
  const map = { pass: ['good', 'пасс'], fail: ['bad', 'фейл'], quit: ['warn', 'выход'], retry: ['warn', 'рестарт'] };
  const [cls, text] = map[o] || ['', o || '—'];
  return raw(`<span class="pill ${cls}">${text}</span>`);
}
