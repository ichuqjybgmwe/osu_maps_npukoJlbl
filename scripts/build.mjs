#!/usr/bin/env node
// Сборка MapVault в один исполняемый файл (Node.js Single Executable Application).
//
//   node scripts/build.mjs                 — для текущей платформы
//   node scripts/build.mjs --target=win-x64 — MapVault.exe для Windows (можно собирать на Linux)
//
// Шаги: esbuild → один CJS-файл; web/ и WASM калькулятора → ресурсы SEA;
// blob внедряется в официальный бинарник Node той же версии через postject.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import * as esbuild from 'esbuild';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const args = Object.fromEntries(process.argv.slice(2).map((a) => a.replace(/^--/, '').split('=')));
const hostTarget = `${process.platform === 'win32' ? 'win' : process.platform}-${process.arch}`;
const target = args.target || hostTarget;
const [targetOs] = target.split('-');
const nodeVersion = process.version; // blob должен внедряться в Node той же версии
const cache = path.join(root, 'build-cache');
const outDir = path.join(root, 'dist', `MapVault-${pkg.version}-${target}`);
const exeName = targetOs === 'win' ? 'MapVault.exe' : 'mapvault';

fs.mkdirSync(cache, { recursive: true });
fs.rmSync(outDir, { recursive: true, force: true });
fs.mkdirSync(outDir, { recursive: true });

const log = (m) => console.log(`[build] ${m}`);

// 1. Бандл
const rosuDir = path.dirname(require.resolve('rosu-pp-js/package.json'));
const wasmPatch = {
  name: 'rosu-wasm-from-sea',
  setup(b) {
    b.onLoad({ filter: /rosu_pp_js\.js$/ }, async (a) => {
      let src = await fs.promises.readFile(a.path, 'utf8');
      const needle = "const bytes = require('fs').readFileSync(path);";
      if (!src.includes(needle)) throw new Error('Не нашёл загрузку WASM в rosu-pp-js — проверьте версию пакета');
      src = src.replace(needle, "const bytes = (globalThis.__MAPVAULT_WASM__ && globalThis.__MAPVAULT_WASM__()) || require('fs').readFileSync(path);");
      return { contents: src, loader: 'js' };
    });
  },
};
const bundle = path.join(cache, 'mapvault.cjs');
await esbuild.build({
  entryPoints: [path.join(root, 'src', 'main.js')],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  outfile: bundle,
  plugins: [wasmPatch],
  define: { 'import.meta.url': '__mapvault_import_meta_url' },
  banner: { js: "const __mapvault_import_meta_url = require('node:url').pathToFileURL(__filename).href;" },
  logLevel: 'warning',
  legalComments: 'none',
});
log(`бандл: ${(fs.statSync(bundle).size / 1024).toFixed(0)} КБ`);

// 2. Ресурсы
const assets = { 'rosu_pp_js_bg.wasm': path.join(rosuDir, 'rosu_pp_js_bg.wasm') };
const walk = (dir, rel = '') => {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) walk(p, r);
    else assets[`web/${r}`] = p;
  }
};
walk(path.join(root, 'web'));
log(`ресурсов: ${Object.keys(assets).length}`);

// 3. SEA blob
const blob = path.join(cache, `sea-${target}.blob`);
const seaConfig = path.join(cache, 'sea-config.json');
fs.writeFileSync(seaConfig, JSON.stringify({
  main: bundle,
  output: blob,
  disableExperimentalSEAWarning: true,
  useSnapshot: false,
  useCodeCache: false, // кэш кода платформозависим — без него blob переносим между ОС
  assets,
}, null, 2));
execFileSync(process.execPath, ['--experimental-sea-config', seaConfig], { stdio: 'inherit' });

// 4. Базовый бинарник Node нужной платформы
async function baseBinary() {
  if (target === hostTarget) return process.execPath;
  if (targetOs !== 'win') throw new Error(`Кросс-сборка поддерживается только для win-x64 (запрошено ${target})`);
  const file = path.join(cache, `node-${nodeVersion}-${target}.exe`);
  if (!fs.existsSync(file)) {
    const url = `https://nodejs.org/dist/${nodeVersion}/${target}/node.exe`;
    log(`скачиваю ${url}`);
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Не удалось скачать node.exe: HTTP ${res.status}`);
    fs.writeFileSync(file, Buffer.from(await res.arrayBuffer()));
  }
  return file;
}
const exe = path.join(outDir, exeName);
fs.copyFileSync(await baseBinary(), exe);
fs.chmodSync(exe, 0o755);
if (target === hostTarget && process.platform === 'darwin') {
  execFileSync('codesign', ['--remove-signature', exe]);
}

// 5. Внедрение blob
const postjectArgs = [exe, 'NODE_SEA_BLOB', blob, '--sentinel-fuse', 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2', '--overwrite'];
if (targetOs === 'darwin') postjectArgs.push('--macho-segment-name', 'NODE_SEA');
execFileSync(process.execPath, [require.resolve('postject/dist/cli.js'), ...postjectArgs], { stdio: 'inherit' });
if (target === hostTarget && process.platform === 'darwin') execFileSync('codesign', ['--sign', '-', exe]);

// 6. Документация рядом с exe
fs.copyFileSync(path.join(root, 'docs', 'INSTALL.md'), path.join(outDir, 'ИНСТРУКЦИЯ.md'));
fs.copyFileSync(path.join(root, 'LICENSE'), path.join(outDir, 'LICENSE.txt'));
log(`готово: ${exe} (${(fs.statSync(exe).size / 1024 / 1024).toFixed(1)} МБ)`);

// 7. zip (если есть утилита)
try {
  const zip = `${outDir}.zip`;
  fs.rmSync(zip, { force: true });
  if (process.platform === 'win32') {
    execFileSync('powershell', ['-NoProfile', '-Command', `Compress-Archive -Path '${outDir}\\*' -DestinationPath '${zip}'`], { stdio: 'inherit' });
  } else {
    execFileSync('zip', ['-qr', zip, path.basename(outDir)], { cwd: path.dirname(outDir), stdio: 'inherit' });
  }
  log(`архив: ${zip}`);
} catch (e) {
  log(`zip пропущен: ${e.message}`);
}
