// Работа с модами: разные источники присылают их по-разному
// (битовая маска stable, строка "HDDT", массив строк, массив {acronym}).

export const MOD_BITS = {
  NF: 1, EZ: 2, TD: 4, HD: 8, HR: 16, SD: 32, DT: 64, RX: 128, HT: 256, NC: 512,
  FL: 1024, AT: 2048, SO: 4096, AP: 8192, PF: 16384,
  '4K': 32768, '5K': 65536, '6K': 131072, '7K': 262144, '8K': 524288,
  FI: 1048576, RD: 2097152, CN: 4194304, TP: 8388608, '9K': 16777216,
  CO: 33554432, '1K': 67108864, '3K': 134217728, '2K': 268435456, V2: 536870912, MR: 1073741824,
};

// Порядок отображения: как в osu!stable (по битам): HDDT, HDHR, EZHD…
const ORDER = ['NF', 'EZ', 'TD', 'HD', 'HR', 'SD', 'PF', 'DT', 'NC', 'RX', 'HT', 'DC', 'FL', 'AT', 'SO', 'AP', 'FI', 'RD', 'CN', 'TP', 'V2', 'MR'];

// Моды, которые не влияют на pp/сложность и не мешают сравнению.
const IGNORED_FOR_KEY = new Set(['CL']);

function splitAcronyms(str) {
  const s = String(str).toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (!s || s === 'NM' || s === 'NOMOD') return [];
  const out = [];
  for (let i = 0; i < s.length; i += 2) out.push(s.slice(i, i + 2));
  return out;
}

/** Нормализованный список акронимов (без CL, без дублей, в каноническом порядке). */
export function parseMods(input) {
  let list = [];
  if (input == null || input === '') list = [];
  else if (typeof input === 'number') {
    for (const [k, bit] of Object.entries(MOD_BITS)) if (input & bit) list.push(k);
    if (list.includes('NC')) list = list.filter((m) => m !== 'DT');
    if (list.includes('PF')) list = list.filter((m) => m !== 'SD');
  } else if (typeof input === 'string') list = splitAcronyms(input);
  else if (Array.isArray(input)) {
    for (const m of input) {
      if (typeof m === 'string') list.push(...splitAcronyms(m));
      else if (m && typeof m === 'object' && m.acronym) list.push(String(m.acronym).toUpperCase());
    }
  } else if (typeof input === 'object') {
    if (Array.isArray(input.array)) return parseMods(input.array);
    if (typeof input.name === 'string') return parseMods(input.name);
    if (typeof input.number === 'number') return parseMods(input.number);
  }
  const uniq = [...new Set(list)].filter((m) => !IGNORED_FOR_KEY.has(m));
  return uniq.sort((a, b) => rank(a) - rank(b));
}

function rank(m) {
  const i = ORDER.indexOf(m);
  return i === -1 ? 100 : i;
}

export function modsToString(mods) {
  return parseMods(mods).join('');
}

export function modsToBits(mods) {
  let bits = 0;
  for (const m of parseMods(mods)) {
    bits |= MOD_BITS[m] || 0;
    if (m === 'NC') bits |= MOD_BITS.DT;
    if (m === 'PF') bits |= MOD_BITS.SD;
  }
  return bits;
}

/** Скорость воспроизведения. Учитывает speed_change из lazer-модов. */
export function modsRate(input) {
  if (Array.isArray(input)) {
    for (const m of input) {
      const r = m && typeof m === 'object' && m.settings && m.settings.speed_change;
      if (typeof r === 'number') return r;
    }
  }
  if (input && typeof input === 'object' && !Array.isArray(input) && typeof input.rate === 'number' && input.rate > 0) {
    return input.rate;
  }
  const mods = parseMods(input);
  if (mods.includes('DT') || mods.includes('NC')) return 1.5;
  if (mods.includes('HT') || mods.includes('DC')) return 0.75;
  return 1;
}

/** Моды, которые меняют сложность/pp (для группировок и рекомендаций). */
export function difficultyMods(input) {
  return parseMods(input)
    .map((m) => (m === 'NC' ? 'DT' : m === 'DC' ? 'HT' : m))
    .filter((m) => ['EZ', 'HT', 'HR', 'DT', 'HD', 'FL'].includes(m))
    .filter((m, i, a) => a.indexOf(m) === i)
    .sort((a, b) => rank(a) - rank(b));
}
