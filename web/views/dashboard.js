import { api, html, raw, fmt, scoreRow, scoreHead, bindRowLinks } from '../lib.js';

function nowCard(now, tosu) {
  if (!tosu || tosu.state !== 'connected') {
    return html`<div class="card"><h3>Сейчас в игре</h3>
      <div class="muted">Tosu не подключён${tosu?.lastError ? html` <span class="small">(${tosu.lastError})</span>` : ''}.</div>
      <div class="small muted mt">Запустите <b>tosu</b> вместе с osu!: MapVault подключится сам, переподключение идёт в фоне. Пока Tosu нет, все сохранённые данные доступны.</div></div>`;
  }
  if (!now) return html`<div class="card"><h3>Сейчас в игре</h3><div class="muted">Tosu подключён, ждём данные от игры…</div></div>`;
  const b = now.beatmap || {};
  const p = now.play;
  return html`<div class="card"><h3>Сейчас в игре · <span class="pill">${now.state || '?'}</span></h3>
    <div class="live-title">${b.artist || ''} — ${b.title || ''} <span class="muted">[${b.version || ''}]</span></div>
    <div class="muted small">${b.mapper ? `map by ${b.mapper} · ` : ''}${fmt.stars(b.stars)} · AR ${fmt.num(b.ar, 1)} · OD ${fmt.num(b.od, 1)} · CS ${fmt.num(b.cs, 1)} · ${fmt.num(b.bpm)} BPM ${b.status ? `· ${b.status}` : ''}</div>
    ${p ? html`<div class="grid cols-4 mt">
      <div class="stat"><div class="v">${fmt.pp(p.pp)}</div><div class="l">pp сейчас (FC ${fmt.pp(p.ppFc)})</div></div>
      <div class="stat"><div class="v">${fmt.acc(p.accuracy)}</div><div class="l">точность</div></div>
      <div class="stat"><div class="v">${fmt.num(p.combo)}x</div><div class="l">комбо (макс ${fmt.num(p.maxCombo)})</div></div>
      <div class="stat"><div class="v">${p.mods || 'NM'}</div><div class="l">моды · ${p.hits?.['0'] ?? 0}✕</div></div>
    </div><div class="progress mt"><div style="width:${Math.round((p.progress || 0) * 100)}%"></div></div>` : ''}
    ${b.md5 ? html`<div class="mt small"><a href="/map/${b.md5}">Открыть страницу карты →</a></div>` : ''}
  </div>`;
}

function setupCard(s) {
  const steps = [];
  if (!s.osu.songsDir) steps.push(html`<li>Папка Songs не найдена. <a href="/settings">Настройки → «Найти osu!»</a> или укажите путь вручную.</li>`);
  else if (!s.indexer.indexed && !s.indexer.running) steps.push(html`<li>Карты ещё не проиндексированы. <a href="/settings">Запустить сканирование</a>.</li>`);
  if (!s.osuApi.configured) steps.push(html`<li>osu! API не подключён — профиль, top plays и каталог недоступны. <a href="/settings">Как подключить</a> (2 минуты).</li>`);
  else if (!s.osuApi.loggedIn && !s.osuApi.user) steps.push(html`<li>Укажите ник или войдите через osu! в <a href="/settings">настройках</a>.</li>`);
  if (s.tosu.state !== 'connected' && s.tosu.enabled) steps.push(html`<li>Tosu не запущен — результаты игры не будут сохраняться автоматически. <a href="https://github.com/tosuapp/tosu/releases" target="_blank" rel="noopener">Скачать tosu</a>.</li>`);
  if (!steps.length) return '';
  return html`<div class="notice info mb"><b>Что осталось настроить</b><ul class="reasons">${steps}</ul></div>`;
}

export async function dashboardView(el, _p, ctx) {
  const [status, recent, attempts] = await Promise.all([api('/api/status'), api('/api/scores?limit=10'), api('/api/attempts?limit=10')]);
  let now = status.now;
  let tosu = status.tosu;

  const paint = () => {
    el.innerHTML = html`
      <h1>Обзор</h1>
      ${setupCard({ ...status, tosu })}
      <div class="grid cols-2">
        <div id="now">${nowCard(now, tosu)}</div>
        <div class="card"><h3>Хранилище</h3>
          <div class="grid cols-3">
            <div class="stat"><div class="v">${fmt.num(status.counts.scores)}</div><div class="l">сохранённых scores</div></div>
            <div class="stat"><div class="v">${fmt.num(status.counts.attempts)}</div><div class="l">попыток</div></div>
            <div class="stat"><div class="v">${fmt.num(status.counts.beatmaps)}</div><div class="l">карт в индексе</div></div>
          </div>
          <div class="small muted mt">База: <span class="mono">${status.dbFile}</span></div>
        </div>
      </div>
      <div class="card mt"><div class="row between"><h2>Последние результаты</h2><a href="/profile">Все →</a></div>
        ${recent.length ? html`<div class="table-wrap"><table>${scoreHead()}${recent.map((s) => scoreRow(s))}</table></div>` : html`<div class="empty">Пока нет сохранённых результатов. Сыграйте карту с запущенным Tosu или обновите профиль через osu! API.</div>`}
      </div>
      <div class="card mt"><h2>Последние попытки</h2>
        ${attempts.length ? html`<div class="table-wrap"><table><tr><th>Карта</th><th>Итог</th><th class="num">Прогресс</th><th class="num">Точность</th><th>Моды</th><th>Когда</th></tr>
          ${attempts.map((a) => html`<tr class="click" data-href="/map/${a.beatmap_md5}"><td class="title">${a.title || a.beatmap_md5}</td><td>${outcome(a.outcome)}</td><td class="num">${a.progress != null ? Math.round(a.progress * 100) + '%' : '—'}</td><td class="num">${fmt.acc(a.accuracy)}</td><td>${fmt.mods(a.mods)}</td><td class="muted small">${fmt.ago(a.started_at)}</td></tr>`)}
        </table></div>` : html`<div class="empty">Попытки записываются, пока работает Tosu: пассы, фейлы, рестарты и выходы.</div>`}
      </div>`;
    bindRowLinks(el, ctx.navigate);
  };
  paint();
  ctx.on('now', (n) => {
    now = n;
    const box = el.querySelector('#now');
    if (box) box.innerHTML = nowCard(now, tosu);
  });
  ctx.on('tosu', (t) => {
    tosu = { ...tosu, ...t };
    const box = el.querySelector('#now');
    if (box) box.innerHTML = nowCard(now, tosu);
  });
  ctx.on('score', () => dashboardView(el, _p, ctx));
}

export function outcome(o) {
  const map = { pass: ['good', 'пасс'], fail: ['bad', 'фейл'], quit: ['warn', 'выход'], retry: ['warn', 'рестарт'] };
  const [cls, text] = map[o] || ['', o || '—'];
  return raw(`<span class="pill ${cls}">${text}</span>`);
}
