// Минимальный WebSocket-клиент (RFC 6455) на node:http — только то, что нужно для Tosu:
// приём текстовых/бинарных сообщений (с фрагментацией), ping/pong, close.
// Свой клиент вместо глобального WebSocket (undici): меньше зависимостей от
// окружения и предсказуемое поведение при отказе соединения.
import http from 'node:http';
import crypto from 'node:crypto';

export class MiniWebSocket {
  constructor(url, { timeoutMs = 5000 } = {}) {
    this.onopen = null;
    this.onmessage = null;
    this.onerror = null;
    this.onclose = null;
    this.socket = null;
    this.closed = false;
    const u = new URL(url);
    const key = crypto.randomBytes(16).toString('base64');
    this.expectedAccept = crypto.createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
    this.req = http.request({
      host: u.hostname,
      port: u.port || 80,
      path: u.pathname + u.search,
      headers: {
        Connection: 'Upgrade',
        Upgrade: 'websocket',
        'Sec-WebSocket-Key': key,
        'Sec-WebSocket-Version': '13',
      },
      timeout: timeoutMs,
    });
    this.req.on('upgrade', (res, socket, head) => this.handleUpgrade(res, socket, head));
    this.req.on('response', (res) => {
      res.resume();
      this.fail(new Error(`Сервер ответил HTTP ${res.statusCode} вместо WebSocket`));
    });
    this.req.on('timeout', () => this.fail(new Error('Таймаут подключения')));
    this.req.on('error', (e) => this.fail(e));
    this.req.end();
    this.buffer = Buffer.alloc(0);
    this.fragments = [];
  }

  handleUpgrade(res, socket, head) {
    if (res.headers['sec-websocket-accept'] !== this.expectedAccept) {
      socket.destroy();
      this.fail(new Error('Неверный ответ рукопожатия WebSocket'));
      return;
    }
    this.socket = socket;
    socket.setNoDelay(true);
    socket.on('data', (d) => this.onData(d));
    socket.on('error', (e) => this.fail(e));
    socket.on('close', () => this.finish());
    this.onopen?.({});
    if (head && head.length) this.onData(head);
  }

  onData(chunk) {
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : chunk;
    for (;;) {
      const b = this.buffer;
      if (b.length < 2) return;
      const fin = (b[0] & 0x80) !== 0;
      const opcode = b[0] & 0x0f;
      const masked = (b[1] & 0x80) !== 0;
      let len = b[1] & 0x7f;
      let off = 2;
      if (len === 126) {
        if (b.length < 4) return;
        len = b.readUInt16BE(2);
        off = 4;
      } else if (len === 127) {
        if (b.length < 10) return;
        len = Number(b.readBigUInt64BE(2));
        off = 10;
      }
      const maskOff = off;
      if (masked) off += 4;
      if (b.length < off + len) return;
      let payload = b.subarray(off, off + len);
      if (masked) {
        const mask = b.subarray(maskOff, maskOff + 4);
        payload = Buffer.from(payload);
        for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
      }
      this.buffer = b.subarray(off + len);
      this.handleFrame(fin, opcode, payload);
      if (this.closed) return;
    }
  }

  handleFrame(fin, opcode, payload) {
    if (opcode === 0x8) { // close
      this.sendFrame(0x8, Buffer.alloc(0));
      this.socket?.end();
      this.finish();
      return;
    }
    if (opcode === 0x9) { // ping
      this.sendFrame(0xa, payload);
      return;
    }
    if (opcode === 0xa) return; // pong
    if (opcode === 0x1 || opcode === 0x2) this.fragments = [payload];
    else if (opcode === 0x0) this.fragments.push(payload);
    else return;
    if (fin) {
      const data = Buffer.concat(this.fragments).toString('utf8');
      this.fragments = [];
      this.onmessage?.({ data });
    }
  }

  sendFrame(opcode, payload) {
    if (!this.socket || this.socket.destroyed) return;
    // Клиент обязан маскировать свои кадры.
    const mask = crypto.randomBytes(4);
    const len = payload.length;
    const header = len < 126 ? Buffer.from([0x80 | opcode, 0x80 | len]) : Buffer.from([0x80 | opcode, 0x80 | 126, len >> 8, len & 0xff]);
    const body = Buffer.from(payload);
    for (let i = 0; i < body.length; i++) body[i] ^= mask[i & 3];
    this.socket.write(Buffer.concat([header, mask, body]));
  }

  send(text) {
    this.sendFrame(0x1, Buffer.from(String(text)));
  }

  fail(err) {
    if (this.closed) return;
    this.onerror?.({ message: err.message, error: err });
    this.finish();
  }

  finish() {
    if (this.closed) return;
    this.closed = true;
    try { this.req.destroy(); } catch { /* ignore */ }
    try { this.socket?.destroy(); } catch { /* ignore */ }
    this.onclose?.({});
  }

  close() {
    if (this.closed) return;
    this.sendFrame(0x8, Buffer.alloc(0));
    this.finish();
  }
}
