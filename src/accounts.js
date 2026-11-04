// Owner-only account operations: add another official CLI account as its own
// route, and prepare a WSL Antigravity profile. Each account is logged in once
// through its own CLI; the Pool never handles the credentials themselves.
import { PoolError } from './config.js';
import { capture } from './process.js';
import { mirrorAgyPermissions, wslExecutable, wslProfileHome, wslWindowsPath } from './profiles.js';

const accountAdapters = new Set(['codex', 'claude', 'agy']);
export const wslInstallCommand = 'curl -fsSL https://antigravity.google/cli/install.sh | bash';

export async function detectWslAgy(python, cwd, run = capture) {
  const exe = wslExecutable();
  let info;
  try { info = await run([exe, '--exec', '/usr/bin/printenv', 'WSL_DISTRO_NAME', 'HOME'], cwd, python); }
  catch { info = { code: 1, output: '' }; }
  const [distro, home] = (info.output || '').trim().split(/\r?\n/).map(line => line.trim());
  if (info.code !== 0 || !/^[A-Za-z0-9._-]{1,64}$/.test(distro || '') || !/^\/[A-Za-z0-9._/-]{1,255}$/.test(home || '')) {
    throw new PoolError('WSL_UNAVAILABLE', 'WSL bulunamadı. Ek Antigravity hesapları için WSL ve bir Linux dağıtımı (ör. Ubuntu) kurun.');
  }
  const executable = `${home}/.local/bin/agy`;
  const check = await run([exe, '-d', distro, '--exec', '/usr/bin/test', '-x', executable], cwd, python);
  if (check.code !== 0) throw new PoolError('WSL_AGY_MISSING', `WSL (${distro}) içinde agy bulunamadı. Linux terminalinde resmi kurulumu çalıştırın: ${wslInstallCommand}`);
  return { distro, home, executable };
}

// Creates the profile HOME and mirrors the owner's native project permissions,
// so tasks in this account do not stop on permission prompts the owner already answered.
export async function prepareWslProfile(route, python, cwd, run = capture, mirror = mirrorAgyPermissions) {
  const home = wslProfileHome(route);
  const result = await run([wslExecutable(), '-d', route.wsl.distro, '--exec', '/usr/bin/mkdir', '-p', home], cwd, python);
  if (result.code !== 0) throw new PoolError('WSL_UNAVAILABLE', `WSL (${route.wsl.distro}) profil klasörü hazırlanamadı.`);
  return mirror(wslWindowsPath(route, `${home}/.gemini`));
}

export function nextAccountRoute(config, baseRouteId, wsl = null) {
  const base = config.routes.find(route => route.id === baseRouteId);
  if (!base) throw new PoolError('NOT_FOUND', 'Bağlantı bulunamadı.');
  if (base.api || !accountAdapters.has(base.adapter)) throw new PoolError('ACCOUNT_UNSUPPORTED', 'Ek hesap yalnızca Codex, Claude ve Antigravity CLI bağlantılarına eklenebilir.');
  if (base.adapter === 'agy' && !wsl) throw new PoolError('WSL_UNAVAILABLE', 'Ek Antigravity hesabı için WSL içinde agy gerekir.');
  const used = new Set(config.routes.filter(route => route.adapter === base.adapter).map(route => route.profile).filter(Boolean));
  let number = 2;
  while (used.has(`acc${number}`) || config.routes.some(route => route.id === `${base.adapter}-acc${number}`)) number++;
  const route = structuredClone(base);
  Object.assign(route, { id: `${base.adapter}-acc${number}`, profile: `acc${number}`, enabled: false });
  if (base.adapter === 'agy') Object.assign(route, { runtime: 'wsl', executable: wsl.executable, wsl: { distro: wsl.distro, home: wsl.home } });
  else { delete route.runtime; delete route.wsl; }
  return { config: { ...config, routes: [...config.routes, route] }, route };
}
