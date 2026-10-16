// Расположение данных приложения. База, логи и кэш .osu-файлов живут вне
// папки программы, поэтому переустановка или обновление exe их не трогает.
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

export function resolveDataDir(env = process.env, platform = process.platform) {
  if (env.MAPVAULT_DATA) return path.resolve(env.MAPVAULT_DATA);
  if (platform === 'win32') {
    const base = env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
    return path.join(base, 'MapVault');
  }
  if (platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', 'MapVault');
  }
  const base = env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share');
  return path.join(base, 'mapvault');
}

export function ensureDataDirs(dataDir) {
  const dirs = {
    root: dataDir,
    logs: path.join(dataDir, 'logs'),
    osuCache: path.join(dataDir, 'osu-cache'),
    backups: path.join(dataDir, 'backups'),
  };
  for (const d of Object.values(dirs)) fs.mkdirSync(d, { recursive: true });
  return { ...dirs, db: path.join(dataDir, 'mapvault.db') };
}
