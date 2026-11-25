// Owner-only account operations: add another official CLI account as its own
// route, and prepare a WSL Antigravity profile. Each account is logged in once
// through its own CLI; the Pool never handles the credentials themselves.
import { PoolError } from './config.js';
import { capture } from './process.js';
import { writeFileSync } from 'node:fs';
import { accountProfileAdapters, mirrorAgyPermissions, profileDirectory, nextFreeProfile, writeProfileRuntimeLocator, wslExecutable, wslProfileHome, wslWindowsPath, wslHelperDirectory, wslBrowserHelper } from './profiles.js';
import path from 'node:path';
import { homedir } from 'node:os';

const accountAdapters = accountProfileAdapters;
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
export async function prepareWslProfile(route, python, cwd, run = capture, mirror = mirrorAgyPermissions, write = writeHelper) {
  const home = wslProfileHome(route), helpers = wslHelperDirectory(route);
  const wsl = argv => run([wslExecutable(), '-d', route.wsl.distro, '--exec', ...argv], cwd, python);
  const result = await wsl(['/usr/bin/mkdir', '-p', home, helpers]);
  if (result.code !== 0) throw new PoolError('WSL_UNAVAILABLE', `WSL (${route.wsl.distro}) profil klasörü hazırlanamadı.`);
  // The sign-in page can still be copied from the terminal if the helper cannot be written.
  try { write(wslWindowsPath(route, `${helpers}/xdg-open`), wslBrowserHelper); await wsl(['/usr/bin/chmod', '755', `${helpers}/xdg-open`]); } catch { /* optional convenience */ }
  return mirror(wslWindowsPath(route, `${home}/.gemini`));
}

function writeHelper(file, content) {
  writeFileSync(file, content, { encoding: 'utf8' });
}

export function nextAccountRoute(config, baseRouteId, wsl = 'native', extraUsed = []) {
  const base = config.routes.find(route => route.id === baseRouteId);
  if (!base) throw new PoolError('NOT_FOUND', 'Bağlantı bulunamadı.');
  if (base.api || !accountAdapters.has(base.adapter)) throw new PoolError('ACCOUNT_UNSUPPORTED', 'Bu CLI bağlantısına ek hesap eklenemez.');
  const profile = nextFreeProfile(config.routes, base.adapter, 2, extraUsed);
  const route = structuredClone(base);
  Object.assign(route, { id: `${base.adapter}-${profile}`, profile, enabled: false });
  if (base.adapter === 'agy') {
    if (wsl && typeof wsl === 'object') {
      Object.assign(route, { runtime: 'wsl', executable: wsl.executable, wsl: { distro: wsl.distro, home: wsl.home } });
    } else if (wsl === 'native' || wsl === false) {
      delete route.runtime;
      delete route.wsl;
      if (base.runtime === 'wsl') {
        const nativeAgy = config.routes.find(item => item.adapter === 'agy' && item.runtime !== 'wsl' && !item.api);
        if (!nativeAgy) throw new PoolError('ACCOUNT_UNSUPPORTED', 'WSL bağlantısından yerel Windows Antigravity hesabı eklemek için yerel bir agy bağlantısı gerekli.');
        route.executable = nativeAgy.executable;
      } else {
        route.executable = base.executable;
      }
    } else {
      throw new PoolError('WSL_UNAVAILABLE', 'Ek Antigravity hesabı için WSL içinde agy gerekir.');
    }
  } else {
    delete route.runtime;
    delete route.wsl;
  }
  return { config: { ...config, routes: [...config.routes, route] }, route };
}

export function isolatedLoginRoute(config, routeId, extraUsed = []) {
  const base = config.routes.find(route => route.id === routeId);
  if (!base) throw new PoolError('NOT_FOUND', 'Bağlantı bulunamadı.');
  if (base.api || base.runtime === 'wsl' || !accountAdapters.has(base.adapter)) throw new PoolError('ACCOUNT_UNSUPPORTED', 'Bu CLI bağlantısı için izole hesap profili kullanılamaz.');
  const profile = nextFreeProfile(config.routes, base.adapter, 1, extraUsed);
  const route = structuredClone(base);
  Object.assign(route, { profile });
  delete route.runtime;
  delete route.wsl;
  return route;
}

export function prepareNativeAgyProfile(route, directory) {
  const home = profileDirectory(route, directory);
  writeProfileRuntimeLocator(home, directory);
  const targetGemini = path.join(home, '.gemini');
  return mirrorAgyPermissions(targetGemini, homedir(), false);
}
