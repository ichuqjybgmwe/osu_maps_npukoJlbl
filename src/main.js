// Точка входа: и для `npm start`, и для собранного MapVault.exe.
// Запускает локальный сервер, подключение к Tosu и открывает браузер.
import './bootstrap.js'; // должен быть первым: WASM калькулятора внутри exe, фильтр предупреждений
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { exec } from 'node:child_process';
import { resolveDataDir } from './paths.js';
import { logger, log } from './logger.js';
import { createApp } from './app.js';
import { VERSION } from './version.js';
import { seaAssets } from './sea.js';

const L = log('main');

function parseArgs(argv) {
  const args = { browser: true };
  for (const a of argv) {
    if (a === '--no-browser') args.browser = false;
    else if (a.startsWith('--port=')) args.port = Number(a.slice(7));
    else if (a.startsWith('--data=')) args.data = a.slice(7);
    else if (a.startsWith('--tosu=')) args.tosu = a.slice(7);
    else if (a === '--no-tosu') args.noTosu = true;
  }
  return args;
}

function openBrowser(url) {
  const cmd = process.platform === 'win32' ? `start "" "${url}"` : process.platform === 'darwin' ? `open "${url}"` : `xdg-open "${url}"`;
  exec(cmd, { windowsHide: true }, (err) => {
    if (err) L.warn(`Не удалось открыть браузер автоматически. Откройте вручную: ${url}`);
  });
}

async function alreadyRunning(port) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(1500) });
    const data = await res.json();
    return data?.app === 'mapvault';
  } catch {
    return false;
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const dataDir = args.data ? path.resolve(args.data) : resolveDataDir();
  fs.mkdirSync(dataDir, { recursive: true });
  logger.init({ dir: path.join(dataDir, 'logs'), level: process.env.MAPVAULT_LOG || 'info' });
  L.info(`MapVault ${VERSION} запускается. Данные: ${dataDir}`);

  const assets = seaAssets();
  const staticDir = assets ? null : path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'web');
  const app = createApp({ dataDir, staticDir, assets, tosuUrl: args.tosu });
  const settings = app.settings.get();
  const basePort = args.port || settings.port;

  // Один экземпляр: если MapVault уже запущен, просто открываем его.
  let port = null;
  for (let p = basePort; p < basePort + 10; p++) {
    try {
      port = await app.listen(p);
      break;
    } catch (e) {
      if (e.code !== 'EADDRINUSE') throw e;
      if (await alreadyRunning(p)) {
        L.info(`MapVault уже запущен на порту ${p} — открываю его.`);
        if (args.browser && settings.openBrowser) openBrowser(`http://localhost:${p}/`);
        app.db.close();
        setTimeout(() => process.exit(0), 300);
        return;
      }
      L.warn(`Порт ${p} занят другой программой, пробую следующий`);
    }
  }
  if (!port) throw new Error(`Не удалось занять порт ${basePort}–${basePort + 9}`);

  const url = `http://localhost:${port}/`;
  L.info(`Готово: ${url}`);
  console.log(`\n  MapVault работает: ${url}\n  Закройте это окно (или нажмите Ctrl+C), чтобы выйти.\n`);
  app.startBackground({ tosuEnabled: args.noTosu ? false : undefined });
  if (args.browser && settings.openBrowser) openBrowser(url);

  let stopping = false;
  const shutdown = async (reason) => {
    if (stopping) return;
    stopping = true;
    L.info(`Остановка (${reason})`);
    try {
      await Promise.race([app.close(), new Promise((r) => setTimeout(r, 3000))]);
    } catch (e) {
      L.error('Ошибка при остановке', e);
    }
    process.exit(0);
  };
  app.onShutdown(() => shutdown('кнопка «Выход»'));
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGHUP', () => shutdown('SIGHUP')); // закрытие окна консоли в Windows
  process.on('uncaughtException', (e) => L.error('Необработанная ошибка', e));
  process.on('unhandledRejection', (e) => L.error('Необработанный promise', e instanceof Error ? e : new Error(String(e))));
}

main().catch((e) => {
  L.error('Запуск не удался', e);
  console.error(e);
  // Окно консоли не должно мгновенно закрыться — пользователь должен увидеть ошибку.
  setTimeout(() => process.exit(1), process.platform === 'win32' ? 15000 : 0);
});
