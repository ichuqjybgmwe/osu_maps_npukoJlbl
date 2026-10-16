// Поиск установки osu!stable и папки Songs.
// Источники по убыванию надёжности: Tosu (путь запущенной игры), реестр
// Windows, стандартные пути. Учитывается BeatmapDirectory из osu!.<user>.cfg.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export function readBeatmapDirectory(gameDir) {
  // Пользователь мог перенести Songs через настройки osu! — это хранится в cfg.
  let files = [];
  try {
    files = fs.readdirSync(gameDir).filter((f) => /^osu!\..+\.cfg$/i.test(f) && f.toLowerCase() !== 'osu!.cfg');
  } catch {
    return null;
  }
  for (const f of files) {
    try {
      const text = fs.readFileSync(path.join(gameDir, f), 'utf8');
      const m = /^\s*BeatmapDirectory\s*=\s*(.+?)\s*$/m.exec(text);
      if (m && m[1]) return path.isAbsolute(m[1]) ? m[1] : path.join(gameDir, m[1]);
    } catch {
      // пропускаем нечитаемый cfg
    }
  }
  return null;
}

export function songsDirFor(gameDir) {
  const custom = readBeatmapDirectory(gameDir);
  if (custom && fs.existsSync(custom)) return custom;
  const def = path.join(gameDir, 'Songs');
  return fs.existsSync(def) ? def : null;
}

async function registryCandidates() {
  if (process.platform !== 'win32') return [];
  const keys = [
    ['HKEY_CLASSES_ROOT\\osu\\shell\\open\\command', ''],
    ['HKEY_CLASSES_ROOT\\osu!\\shell\\open\\command', ''],
    ['HKEY_CLASSES_ROOT\\osustable.File.osz\\shell\\open\\command', ''],
  ];
  const out = [];
  for (const [key] of keys) {
    try {
      const { stdout } = await execFileAsync('reg', ['query', key, '/ve'], { windowsHide: true, timeout: 3000 });
      const m = /"([^"]+osu!\.exe)"/i.exec(stdout);
      if (m) out.push(path.dirname(m[1]));
    } catch {
      // ключа нет
    }
  }
  return out;
}

function defaultCandidates(env = process.env) {
  const list = [];
  if (env.LOCALAPPDATA) list.push(path.join(env.LOCALAPPDATA, 'osu!'));
  list.push(path.join(os.homedir(), 'AppData', 'Local', 'osu!'));
  for (const drive of ['C:', 'D:', 'E:']) {
    list.push(`${drive}\\osu!`, `${drive}\\Games\\osu!`, `${drive}\\Program Files\\osu!`, `${drive}\\Program Files (x86)\\osu!`);
  }
  // Wine / Linux
  list.push(path.join(os.homedir(), '.local', 'share', 'osu-wine', 'osu!'), path.join(os.homedir(), 'osu!'));
  return list;
}

function lazerDataDir(env = process.env) {
  const candidates = [];
  if (env.APPDATA) candidates.push(path.join(env.APPDATA, 'osu'));
  candidates.push(path.join(os.homedir(), '.local', 'share', 'osu'));
  return candidates.find((d) => fs.existsSync(path.join(d, 'client.realm'))) || null;
}

/**
 * @param {{tosuFolders?: {game?: string, songs?: string}}} hints
 */
export async function detectOsu(hints = {}) {
  const tried = [];
  const result = { found: false, gameDir: null, songsDir: null, source: null, lazerDir: lazerDataDir(), tried };

  if (hints.tosuFolders?.songs && fs.existsSync(hints.tosuFolders.songs)) {
    return { ...result, found: true, gameDir: hints.tosuFolders.game || null, songsDir: hints.tosuFolders.songs, source: 'tosu' };
  }

  const fromRegistry = await registryCandidates();
  const all = [...fromRegistry.map((d) => ['registry', d]), ...defaultCandidates().map((d) => ['default', d])];
  for (const [source, dir] of all) {
    tried.push(dir);
    if (!fs.existsSync(path.join(dir, 'osu!.exe')) && !fs.existsSync(path.join(dir, 'Songs'))) continue;
    const songs = songsDirFor(dir);
    if (songs) return { ...result, found: true, gameDir: dir, songsDir: songs, source };
  }
  return result;
}
