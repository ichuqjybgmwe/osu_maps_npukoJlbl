import { api, html, fmt, toast } from '../lib.js';

export async function settingsView(el, _p, ctx) {
  const [s, status, redirect] = await Promise.all([api('/api/settings'), api('/api/status'), api('/api/osu/redirect-uri')]);
  const ix = status.indexer;

  el.innerHTML = html`
    <h1>Настройки</h1>
    <div class="grid cols-2">
      <div class="card"><h2>osu! и папка Songs</h2>
        <div class="row"><button id="detect">Найти osu! автоматически</button><span class="muted small" id="detect-res"></span></div>
        <label class="field mt">Папка osu!<input id="gameDir" value="${s.gameDir || ''}" placeholder="C:\\Users\\…\\AppData\\Local\\osu!"></label>
        <label class="field mt">Папка Songs<input id="songsDir" value="${s.songsDir || ''}" placeholder="C:\\Users\\…\\AppData\\Local\\osu!\\Songs"></label>
        <label class="row mt small"><input type="checkbox" id="autoScanOnStart" ${s.autoScanOnStart ? 'checked' : ''}> Сканировать новые карты при запуске</label>
        <div class="row mt"><button id="scan">Сканировать</button><button id="rescan">Полный пересчёт</button><button id="cancel">Остановить</button><button id="statuses" title="Узнать ranked/loved/graveyard через osu! API">Статусы карт</button></div>
        <div class="mt" id="ix"></div>
        <div class="small muted mt">Поддерживается osu!stable (папка Songs с .osu-файлами). osu!lazer хранит карты в своей базе — его Songs не индексируются, но scores из lazer через Tosu и API сохраняются.</div>
      </div>

      <div class="card"><h2>Tosu</h2>
        <label class="row small"><input type="checkbox" id="tosuEnabled" ${s.tosuEnabled ? 'checked' : ''}> Подключаться к Tosu</label>
        <label class="field mt">Адрес WebSocket<input id="tosuUrl" value="${s.tosuUrl}"></label>
        <div class="kv mt small"><div>Состояние</div><div id="tosu-state">${status.tosu.state}</div><div>Клиент</div><div>${status.tosu.client || '—'}</div><div>Кадров получено</div><div>${fmt.num(status.tosu.frames)}</div><div>Ошибка</div><div>${status.tosu.lastError || '—'}</div></div>
        <div class="small muted mt">Tosu — программа, которая читает память osu! и отдаёт данные игры. Скачать: <a href="https://github.com/tosuapp/tosu/releases" target="_blank" rel="noopener">github.com/tosuapp/tosu</a>. Запустите tosu.exe до или после MapVault — подключение восстанавливается само.</div>
      </div>

      <div class="card"><h2>osu! API</h2>
        <ol class="small muted" style="padding-left:18px;margin-top:0">
          <li>Откройте <a href="https://osu.ppy.sh/home/account/edit#oauth" target="_blank" rel="noopener">osu.ppy.sh → Настройки → OAuth</a> → «New OAuth Application».</li>
          <li>Название любое, Application Callback URL: <span class="mono" style="color:var(--text)">${redirect.redirectUri}</span></li>
          <li>Скопируйте Client ID и Client Secret сюда и сохраните.</li>
          <li>Нажмите «Войти через osu!» (или просто укажите ник — тогда доступны только публичные данные).</li>
        </ol>
        <label class="field">Client ID<input id="clientId" value="${s.clientId || ''}"></label>
        <label class="field mt">Client Secret<input id="clientSecret" type="password" value="${s.clientSecret || ''}" placeholder="${s.clientSecret ? 'сохранён' : ''}"></label>
        <label class="field mt">Ник в osu! (если не входить)<input id="username" value="${s.username || ''}"></label>
        <div class="row mt">
          ${status.osuApi.loggedIn ? html`<span class="pill good">Вход выполнен${status.osuApi.user ? `: ${status.osuApi.user.username}` : ''}</span><button id="logout">Выйти</button>` : html`<a href="/api/osu/login"><button ${status.osuApi.configured ? '' : 'disabled'}>Войти через osu!</button></a>`}
        </div>
        ${status.osuApi.lastError ? html`<div class="notice bad mt small">${status.osuApi.lastError}</div>` : ''}
        <div class="small muted mt">Ключи хранятся только локально, в базе MapVault. Лимит API — около 60 запросов в минуту, MapVault соблюдает его сам.</div>
      </div>

      <div class="card"><h2>Расчёты и приложение</h2>
        <label class="field">Режим игры<select id="mode"><option value="0">osu!</option><option value="1">osu!taiko</option><option value="2">osu!catch</option><option value="3">osu!mania</option></select></label>
        <label class="field mt">Правила pp по умолчанию<select id="ppMode"><option value="stable">osu!stable</option><option value="lazer">osu!lazer</option></select></label>
        <label class="field mt">Обновлять профиль каждые, мин (0 — вручную)<input id="profileRefreshMinutes" type="number" min="0" value="${s.profileRefreshMinutes}"></label>
        <label class="field mt">Порт локального сайта (после перезапуска)<input id="port" type="number" value="${s.port}"></label>
        <label class="row mt small"><input type="checkbox" id="openBrowser" ${s.openBrowser ? 'checked' : ''}> Открывать браузер при запуске</label>
        <div class="kv mt small"><div>Версия</div><div>${status.version}</div><div>Данные</div><div class="mono">${status.dataDir}</div><div>База</div><div class="mono">${status.dbFile}</div></div>
        <div class="row mt"><button class="primary" id="save">Сохранить настройки</button><span class="spacer"></span><button id="quit">Выйти из MapVault</button></div>
      </div>
    </div>
    <div class="card mt"><div class="row between"><h2 style="margin:0">Журнал</h2><button id="logs-refresh">Обновить</button></div>
      <pre id="logs" class="small mono" style="max-height:320px;overflow:auto;white-space:pre-wrap;margin:12px 0 0"></pre></div>`;

  el.querySelector('#mode').value = String(s.mode);
  el.querySelector('#ppMode').value = s.ppMode;

  const paintIx = (st) => {
    const pct = st.total ? Math.round((st.done / st.total) * 100) : 0;
    el.querySelector('#ix').innerHTML = html`
      ${st.running ? html`<div class="progress"><div style="width:${pct}%"></div></div><div class="small muted mt">${st.phase === 'listing' ? 'Читаю список файлов…' : `${fmt.num(st.done)} / ${fmt.num(st.total)} (${pct}%)`}</div>` : ''}
      <div class="small muted mt">В индексе: ${fmt.num(st.indexed)} карт, рассчитано ${fmt.num(st.calculated)}.
      ${st.finishedAt ? `Последнее сканирование: ${fmt.ago(st.finishedAt)} — новых ${st.added}, обновлено ${st.updated}, пропало ${st.removed}, ошибок ${st.errors}.` : ''}</div>
      ${st.lastError ? html`<div class="small" style="color:var(--bad)">${st.lastError}</div>` : ''}`;
  };
  paintIx(ix);
  ctx.on('indexer', paintIx);
  ctx.on('tosu', (t) => { const x = el.querySelector('#tosu-state'); if (x) x.textContent = t.state; });

  const collect = () => ({
    gameDir: el.querySelector('#gameDir').value || null,
    songsDir: el.querySelector('#songsDir').value || null,
    autoScanOnStart: el.querySelector('#autoScanOnStart').checked,
    tosuEnabled: el.querySelector('#tosuEnabled').checked,
    tosuUrl: el.querySelector('#tosuUrl').value,
    clientId: el.querySelector('#clientId').value,
    clientSecret: el.querySelector('#clientSecret').value,
    username: el.querySelector('#username').value,
    mode: el.querySelector('#mode').value,
    ppMode: el.querySelector('#ppMode').value,
    profileRefreshMinutes: el.querySelector('#profileRefreshMinutes').value,
    port: el.querySelector('#port').value,
    openBrowser: el.querySelector('#openBrowser').checked,
  });
  const save = async () => {
    await api('/api/settings', { method: 'PUT', body: collect() });
    toast('Настройки сохранены');
  };
  el.querySelector('#save').addEventListener('click', () => save().catch((e) => toast(e.message, 'bad')));
  el.querySelector('#detect').addEventListener('click', async () => {
    const out = el.querySelector('#detect-res');
    out.textContent = 'Ищу…';
    try {
      const r = await api('/api/osu/detect', { method: 'POST', body: { apply: true } });
      if (r.found) {
        el.querySelector('#gameDir').value = r.gameDir || '';
        el.querySelector('#songsDir').value = r.songsDir || '';
        out.textContent = `Найдено (${r.source}).`;
      } else {
        out.textContent = `Не найдено${r.lazerDir ? ' (есть только osu!lazer)' : ''}. Укажите путь вручную.`;
      }
    } catch (e) {
      out.textContent = e.message;
    }
  });
  const scan = (force) => async () => {
    try {
      await save();
      paintIx(await api('/api/songs/scan', { method: 'POST', body: { force } }));
    } catch (e) {
      toast(e.message, 'bad');
    }
  };
  el.querySelector('#scan').addEventListener('click', scan(false));
  el.querySelector('#rescan').addEventListener('click', scan(true));
  el.querySelector('#cancel').addEventListener('click', () => api('/api/songs/cancel', { method: 'POST' }));
  el.querySelector('#statuses').addEventListener('click', async (e) => {
    e.target.disabled = true;
    try {
      const r = await api('/api/songs/statuses', { method: 'POST' });
      toast(r.busy ? 'Проверка статусов уже идёт' : `Проверено карт: ${r.checked}, обновлено: ${r.updated}`);
    } catch (err) {
      toast(err.message, 'bad');
    } finally {
      e.target.disabled = false;
    }
  });
  el.querySelector('#logout')?.addEventListener('click', async () => {
    await api('/api/osu/logout', { method: 'POST' });
    settingsView(el, _p, ctx);
  });
  el.querySelector('#quit').addEventListener('click', async () => {
    if (!confirm('Закрыть MapVault? Данные сохранены.')) return;
    await api('/api/shutdown', { method: 'POST' });
    document.body.innerHTML = '<div class="empty" style="grid-column:1/-1;margin-top:20vh">MapVault закрыт. Запустите его снова, чтобы продолжить.</div>';
  });
  const loadLogs = async () => {
    const logs = await api('/api/logs?limit=300');
    el.querySelector('#logs').textContent = logs.map((l) => `${l.ts.slice(11, 19)} ${l.level.toUpperCase().padEnd(5)} [${l.scope}] ${l.msg}`).join('\n') || 'Пусто';
  };
  el.querySelector('#logs-refresh').addEventListener('click', loadLogs);
  loadLogs();
}
