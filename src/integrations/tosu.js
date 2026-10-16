// Подключение к Tosu по WebSocket с автоматическим переподключением.
// Если Tosu не запущен, приложение работает дальше: статус «нет связи»,
// сохранённые данные доступны, попытки подключения продолжаются в фоне.
import { EventEmitter } from 'node:events';
import { log } from '../logger.js';

const L = log('tosu');

export class TosuClient extends EventEmitter {
  constructor({ url = 'ws://127.0.0.1:24050/websocket/v2' } = {}) {
    super();
    this.url = url;
    this.ws = null;
    this.stopped = true;
    this.retryMs = 1000;
    this.timer = null;
    this.status = { state: 'disconnected', url, connectedAt: null, lastFrameAt: null, lastError: null, frames: 0, client: null };
  }

  setUrl(url) {
    if (url === this.url) return;
    this.url = url;
    this.status.url = url;
    if (!this.stopped) {
      this.stop();
      this.start();
    }
  }

  setStatus(patch) {
    Object.assign(this.status, patch);
    this.emit('status', { ...this.status });
  }

  start() {
    this.stopped = false;
    this.connect();
  }

  stop() {
    this.stopped = true;
    clearTimeout(this.timer);
    if (this.ws) {
      try { this.ws.close(); } catch { /* ignore */ }
      this.ws = null;
    }
    this.setStatus({ state: 'disconnected' });
  }

  connect() {
    if (this.stopped) return;
    if (typeof WebSocket !== 'function') {
      this.setStatus({ state: 'error', lastError: 'В этой версии Node нет WebSocket (нужен Node 22+)' });
      return;
    }
    this.setStatus({ state: 'connecting' });
    let ws;
    try {
      ws = new WebSocket(this.url);
    } catch (e) {
      this.setStatus({ state: 'error', lastError: e.message });
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;
    let opened = false;
    let finished = false;
    // В Node 22 при отказе в соединении WebSocket шлёт только error (без close),
    // поэтому завершение обрабатываем в одном месте для обоих событий + таймаут.
    const finish = (reason) => {
      if (finished) return;
      finished = true;
      clearTimeout(connectTimer);
      if (this.ws === ws) this.ws = null;
      try { ws.close(); } catch { /* ignore */ }
      if (opened) L.warn(`Соединение с Tosu потеряно${reason ? `: ${reason}` : ''}`);
      this.setStatus({ state: this.stopped ? 'disconnected' : 'waiting', connectedAt: null });
      if (opened) this.emit('disconnect');
      this.scheduleReconnect();
    };
    const connectTimer = setTimeout(() => {
      if (!opened) {
        this.status.lastError = 'Таймаут подключения';
        finish('таймаут');
      }
    }, 5000);
    ws.onopen = () => {
      opened = true;
      clearTimeout(connectTimer);
      this.retryMs = 1000;
      L.info(`Подключено к Tosu: ${this.url}`);
      this.setStatus({ state: 'connected', connectedAt: new Date().toISOString(), lastError: null });
    };
    ws.onmessage = (ev) => {
      let frame;
      try {
        frame = JSON.parse(typeof ev.data === 'string' ? ev.data : Buffer.from(ev.data).toString('utf8'));
      } catch (e) {
        L.warn(`Не удалось разобрать кадр Tosu: ${e.message}`);
        return;
      }
      if (frame && frame.error) {
        this.status.lastError = String(frame.error);
        return;
      }
      this.status.frames++;
      this.status.lastFrameAt = new Date().toISOString();
      this.status.client = frame.client || null;
      try {
        this.emit('frame', frame);
      } catch (e) {
        // ошибка обработчика не должна рвать соединение
        L.error('Ошибка обработки кадра Tosu', e);
      }
    };
    ws.onerror = (ev) => {
      const msg = ev?.message || ev?.error?.message || 'ошибка соединения';
      this.status.lastError = opened ? msg : `Tosu недоступен (${msg})`;
      finish(msg);
    };
    ws.onclose = () => finish();
  }

  scheduleReconnect() {
    if (this.stopped) return;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.connect(), this.retryMs);
    this.retryMs = Math.min(this.retryMs * 2, 5000);
  }
}
