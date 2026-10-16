// Импортируется первым в main.js, до остальных модулей.
// 1) В собранном exe WASM-модуль rosu-pp лежит внутри исполняемого файла как ресурс.
// 2) Прячем предупреждение Node о «экспериментальном» SQLite — оно пугает пользователей,
//    а API node:sqlite мы фиксируем версией Node, с которой собирается exe.
import { seaAssets } from './sea.js';

const assets = seaAssets();
if (assets) {
  globalThis.__MAPVAULT_WASM__ = () => assets('rosu_pp_js_bg.wasm');
}

const emitWarning = process.emitWarning;
process.emitWarning = function (warning, ...rest) {
  const text = typeof warning === 'string' ? warning : warning?.message;
  const type = typeof rest[0] === 'string' ? rest[0] : rest[0]?.type;
  if (type === 'ExperimentalWarning' && /SQLite/i.test(text || '')) return;
  return emitWarning.call(process, warning, ...rest);
};
