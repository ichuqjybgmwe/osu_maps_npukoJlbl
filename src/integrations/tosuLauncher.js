// Запуск tosu вместе с MapVault — без окна консоли (windowsHide).
// Если tosu уже работает (порт отвечает), второй экземпляр не запускаем.
// При выходе из MapVault закрываем только тот tosu, который запустили сами.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { log } from '../logger.js';

const L = log('tosu-launcher');

function portAlive(url) {
  return new Promise((resolve) => {
    let u;
    try {
      u = new URL(url.replace(/^ws/, 'http'));
    } catch {
      resolve(false);
      return;
    }
    const req = http.get({ host: u.hostname, port: u.port || 80, path: '/', timeout: 1500 }, (res) => {
      res.resume();
      resolve(true);
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });
}

/** Поиск tosu.exe в типичных местах (Загрузки, Рабочий стол, Документы, рядом с osu!). */
export function findTosu({ gameDir } = {}, env = process.env) {
  const home = os.homedir();
  const roots = [
    path.join(home, 'Downloads'), path.join(home, 'Desktop'), path.join(home, 'Documents'),
    env.LOCALAPPDATA && path.join(env.LOCALAPPDATA, 'Programs'), env.LOCALAPPDATA,
    gameDir, gameDir && path.dirname(gameDir), 'C:\\tosu', 'D:\\tosu', 'C:\\Games', 'D:\\Games',
  ].filter(Boolean);
  const seen = new Set();
  const walk = (dir, depth) => {
    if (depth < 0 || seen.has(dir)) return null;
    seen.add(dir);
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return null;
    }
    for (const e of entries) {
      if (e.isFile() && e.name.toLowerCase() === 'tosu.exe') return path.join(dir, e.name);
    }
    for (const e of entries) {
      if (!e.isDirectory() || e.name.startsWith('.') || e.name === 'node_modules') continue;
      // Глубоко смотрим только в папки, похожие на tosu, чтобы поиск был быстрым.
      const deeper = /tosu/i.test(e.name) ? depth : depth - 1;
      const found = walk(path.join(dir, e.name), deeper);
      if (found) return found;
    }
    return null;
  };
  for (const r of roots) {
    const found = walk(r, 1);
    if (found) return found;
  }
  return null;
}

export class TosuLauncher {
  constructor({ getSettings }) {
    this.getSettings = getSettings;
    this.child = null;
    this.state = { running: false, startedByUs: false, pid: null, lastError: null };
  }

  status() {
    return { ...this.state };
  }

  async start() {
    const s = this.getSettings();
    if (!s.tosuAutostart || !s.tosuPath) return this.status();
    if (this.child) return this.status();
    if (await portAlive(s.tosuUrl)) {
      this.state = { running: true, startedByUs: false, pid: null, lastError: null };
      return this.status();
    }
    if (!fs.existsSync(s.tosuPath)) {
      this.state.lastError = `Не найден файл: ${s.tosuPath}`;
      L.warn(this.state.lastError);
      return this.status();
    }
    try {
      const child = spawn(s.tosuPath, [], {
        cwd: path.dirname(s.tosuPath),
        windowsHide: true, // главное: без чёрного окна
        stdio: 'ignore',
        detached: false,
      });
      this.child = child;
      this.state = { running: true, startedByUs: true, pid: child.pid, lastError: null };
      L.info(`tosu запущен в фоне (pid ${child.pid})`);
      child.on('exit', (code) => {
        L.info(`tosu завершился (код ${code})`);
        this.child = null;
        this.state = { ...this.state, running: false, pid: null };
      });
      child.on('error', (e) => {
        this.state.lastError = e.message;
        L.warn(`Не удалось запустить tosu: ${e.message}`);
      });
    } catch (e) {
      this.state.lastError = e.message;
      L.warn(`Не удалось запустить tosu: ${e.message}`);
    }
    return this.status();
  }

  stop() {
    if (!this.child) return;
    try {
      if (process.platform === 'win32') {
        // tosu может запускать дочерние процессы — закрываем всё дерево.
        spawn('taskkill', ['/pid', String(this.child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
      } else {
        this.child.kill();
      }
    } catch {
      // уже завершён
    }
    this.child = null;
  }
}
