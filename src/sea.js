// Доступ к ресурсам, встроенным в MapVault.exe (Node Single Executable Application).
// При обычном запуске через node возвращает null, и статика читается из папки web/.
import { createRequire } from 'node:module';

export function seaAssets() {
  let sea;
  try {
    sea = createRequire(import.meta.url)('node:sea');
  } catch {
    return null;
  }
  if (!sea.isSea()) return null;
  return (name) => {
    try {
      return Buffer.from(sea.getAsset(name));
    } catch {
      return null;
    }
  };
}
