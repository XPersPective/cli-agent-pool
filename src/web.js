import { workspaceSkills, readWorkspaceSkill } from './skills.js';
import { randomBytes, timingSafeEqual, createHmac, createHash } from 'node:crypto';
import { readFileSync, realpathSync, statSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { configView, saveConfig, PoolError, dataDirectory } from './config.js';
import { discover, routeCatalog, importDiscoveredRoutes, loginCommands, mergeCatalogModels, executableArgv } from './adapters.js';
import { codexControl } from './codex-control.js';
import { saveSecret, hasSecret } from './secrets-store.js';
import { childEnvironment, runProcess } from './process.js';

const execPicker = async (file, args, options) => {
  const result = await runProcess({ argv: [file, ...args], cwd: process.cwd(), extraEnv: options.env, timeoutMs: options.timeout, maxBytes: options.maxBuffer }).done;
  if (result.code !== 0 || result.stopReason) throw new Error('Picker process failed');
  return { stdout: result.output };
};

export async function pickWindowsFolder(initialPath = '', { run = execPicker, platform = process.platform, directory = dataDirectory() } = {}) {
  if (platform !== 'win32') throw new PoolError('PICKER_UNAVAILABLE', 'Windows klasör seçicisi yalnızca Windows üzerinde kullanılabilir.');
  const source = readFileSync(new URL('./folder-picker.cs', import.meta.url));
  const digest = createHash('sha256').update(source).digest('hex').slice(0, 16);
  const cache = path.join(directory, 'ui');
  const executable = path.join(cache, `folder-picker-${digest}.exe`);
  const env = childEnvironment({ CLI_AGENT_POOL_PICKER_START: initialPath });
  if (!existsSync(executable)) {
    mkdirSync(cache, { recursive: true, mode: 0o700 });
    const filename = path.join(cache, `folder-picker-${digest}.cs`);
    writeFileSync(filename, source, { mode: 0o600 });
    const compiler = path.join(process.env.SystemRoot || 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe');
    try { await run(compiler, ['/nologo', '/target:winexe', `/out:${executable}`, '/reference:System.Web.Extensions.dll', filename], { env, windowsHide: true, timeout: 30000, maxBuffer: 16384 }); }
    catch { throw new PoolError('PICKER_FAILED', 'Windows klasör seçicisi hazırlanamadı.'); }
  }
  let result;
  // The GUI helper uses the Windows shell dialog; its supervisor owns and retires the process tree.
  try { result = await run(executable, [], { env, windowsHide: false, encoding: 'utf8', timeout: 180_000, maxBuffer: 16384 }); }
  catch { throw new PoolError('PICKER_FAILED', 'Windows klasör seçicisi tamamlanamadı. Yeniden deneyin.'); }
  let selected;
  try { selected = JSON.parse(result.stdout).path; } catch { throw new PoolError('PICKER_FAILED', 'Windows klasör seçicisi geçerli sonuç döndürmedi.'); }
  if (selected == null) return { path: null };
  if (typeof selected !== 'string' || !path.isAbsolute(selected)) throw new PoolError('INVALID_WORKSPACE', 'Geçerli bir klasör seçin.');
  const actual = realpathSync(selected);
  if (!statSync(actual).isDirectory()) throw new PoolError('INVALID_WORKSPACE', 'Bir klasör seçin.');
  return { path: actual };
}

export async function openCliLogin(route, { platform = process.platform, run = promisify(execFile) } = {}) {
  const command = loginCommands[route.adapter];
  if (route.api || !command || ['custom','lmstudio','ollama'].includes(route.adapter)) throw new PoolError('LOGIN_UNAVAILABLE', 'Bu bağlantının anahtar veya yerel uygulama ayarlarını Ayarlar ekranından düzenleyin.');
  const argv = [...executableArgv(route.executable), ...command.split(' ').slice(1)];
  if (platform !== 'win32') return { opened: false, message: `Terminalde ${command} çalıştırın, girişten sonra Kontrol et düğmesine basın.` };
  if (argv.some(arg => /["\r\n]/.test(arg))) throw new PoolError('LOGIN_UNAVAILABLE', `Terminalde ${command} çalıştırın.`);
  // Fixed platform script only: arguments travel as JSON data, never executable PowerShell text.
  // Every forwarded argument is a file or fixed login word, without embedded quotes or trailing backslashes.
  const script = `$ErrorActionPreference = 'Stop'; $taskLoginRequest = ConvertFrom-Json $env:CLI_AGENT_POOL_LOGIN_ARGV; $taskLoginOptions = @{FilePath=$taskLoginRequest.file; WindowStyle='Normal'; PassThru=$true; ErrorAction='Stop'}; if ($taskLoginRequest.arguments.Count -gt 0) { $taskLoginOptions.ArgumentList = (($taskLoginRequest.arguments | ForEach-Object { '"' + $_ + '"' }) -join ' ') }; $taskLoginProcess = Start-Process @taskLoginOptions; @{opened=$true} | ConvertTo-Json -Compress`;
  try {
    const result = await run(path.join(process.env.SystemRoot || 'C:\\Windows','System32','WindowsPowerShell','v1.0','powershell.exe'), ['-NoProfile','-NonInteractive','-Command',script], { env: childEnvironment({CLI_AGENT_POOL_LOGIN_ARGV: JSON.stringify({file:argv[0],arguments:argv.slice(1)})}), windowsHide: true, timeout: 15000, maxBuffer: 4096 });
    if (!JSON.parse(result.stdout).opened) throw new Error('Not opened');
  } catch { throw new PoolError('LOGIN_FAILED', `Giriş penceresi açılamadı. Terminalde ${command} çalıştırın.`); }
  return { opened: true, message: 'Resmî CLI giriş penceresi açıldı. Girişi orada tamamlayıp Kontrol et düğmesine basın.' };
}

function annotateView(view, directory) {
  return {
    ...view,
    secretStates: Object.fromEntries(view.config.routes.map(route => [
      route.id,
      route.api?.secretRef ? hasSecret(directory, route.api.secretRef) : false,
    ])),
  };
}

export function managementOperation(pool, management, body) {
  if (body.operation === 'save') {
    if (body.config?.port !== pool.config.port || body.config?.python !== pool.config.python) throw new PoolError('RESTART_REQUIRED', 'Port veya Python yolunu değiştirmek için servisi durdurup yerel ayarları değiştirin.');
    if (body.secrets && typeof body.secrets === 'object') {
      for (const [secretRef, value] of Object.entries(body.secrets)) {
        if (typeof value === 'string' && value.trim()) saveSecret(management.directory, secretRef, value);
      }
    }
    pool.config = saveConfig(management.directory, body.config, body.revision);
    pool.schedule();
  } else if (body.operation !== 'get') throw new PoolError('INVALID_OPERATION', 'Geçersiz yönetim işlemi.');
  return annotateView(configView(management.directory), management.directory);
}

export function browserUI(pool, management) {
  let folderPicker = null;
  const catalogFor = async route => {
    const cwd = management.directory;
    if (route.adapter === 'codex' && !route.api) {
      try { return await codexControl(route, cwd, pool.config.python, 'models'); }
      catch { return routeCatalog(route, cwd, pool.config.python); }
    }
    return routeCatalog(route, cwd, pool.config.python);
  };
  let launchToken = randomBytes(32).toString('hex');
  const cookieSecret = createHmac('sha256', Buffer.from(management.token, 'hex')).update('cli-agent-pool-browser-cookie-v1').digest();
  const assets = new Map([
    ['/', ['text/html; charset=utf-8', readFileSync(new URL('../web/index.html', import.meta.url))]],
    ['/pool-state.js', ['text/javascript; charset=utf-8', readFileSync(new URL('../web/pool-state.js', import.meta.url))]],
    ['/app.js', ['text/javascript; charset=utf-8', readFileSync(new URL('../web/app.js', import.meta.url))]],
    ['/style.css', ['text/css; charset=utf-8', readFileSync(new URL('../web/style.css', import.meta.url))]],
  ]);
  const equal = (a, b) => typeof a === 'string' && typeof b === 'string' && Buffer.byteLength(a) === Buffer.byteLength(b) && timingSafeEqual(Buffer.from(a), Buffer.from(b));
  const sign = payload => createHmac('sha256', cookieSecret).update(payload).digest('hex');
  return {
    launchURL(port) {
      if (!launchToken) launchToken = randomBytes(32).toString('hex');
      return `http://127.0.0.1:${port}/?token=${launchToken}`;
    },
    authorized(req, port) {
      const cookie = (req.headers.cookie || '').split(';').map(c => c.trim()).find(c => c.startsWith(`pool_${port}=`));
      if (!cookie) return false;
      const [expires, mac] = cookie.slice(cookie.indexOf('=') + 1).split('.');
      return /^\d{13}$/.test(expires) && Number(expires) > Date.now() && equal(mac, sign(`${port}:${expires}`));
    },
    serve(req, res, port) {
      let url;
      try { url = new URL(req.url, `http://127.0.0.1:${port}`); } catch { return false; }
      if (req.method !== 'GET' || !assets.has(url.pathname)) return false;
      const pairing = url.searchParams.get('token');
      if (url.pathname === '/' && pairing && launchToken && equal(pairing, launchToken)) {
        launchToken = null;
        const expires = String(Date.now() + 8 * 60 * 60 * 1000);
        res.writeHead(303, { Location: '/', 'Set-Cookie': `pool_${port}=${expires}.${sign(`${port}:${expires}`)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=28800`, 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' });
        res.end(); return true;
      }
      if (!this.authorized(req, port)) {
        res.writeHead(401, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end('Yönetim ekranını terminalde yazdırılan tek kullanımlık bağlantıdan açın.'); return true;
      }
      const [type, bytes] = assets.get(url.pathname);
      res.writeHead(200, {
        'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer',
        'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
      });
      res.end(bytes); return true;
    },
    async operation(body) {
      const { operation, payload = {} } = body;
      if (operation === 'snapshot') {
        const quotas = Object.fromEntries(pool.config.routes.map(route => [route.id, pool.store.quota(route.id)]).filter(([, q]) => q));
        return {
          version,
          revision: configView(management.directory).revision,
          connections: pool.config.routes.map(({ id, adapter, enabled, billing, autoSelect, api }) => ({
            id, adapter, enabled, billing,
            autoSelect: autoSelect ?? (billing !== 'paid_api'),
            protocol: api?.protocol || null,
            baseUrl: api?.baseUrl || null,
            hasSecret: api?.secretRef ? hasSecret(management.directory, api.secretRef) : false,
            loginCommand: loginCommands[adapter],
          })),
          quotas,
          models: pool.models(),
          tasks: pool.list(160,0,true),
          installed: discover(),
          workspaceRoots: pool.config.workspaceRoots,
          selectionMode: pool.config.selectionMode,
        };
      }
      if (operation === 'settings') return managementOperation(pool, management, { operation: 'get' });
      if (operation === 'pick_folder') {
        const initial = payload.path ?? '';
        if (typeof initial !== 'string' || initial.length > 4096 || /[\u0000-\u001f]/.test(initial) || (initial && !path.isAbsolute(initial))) throw new PoolError('INVALID_WORKSPACE', 'Geçerli bir klasör yolu girin.');
        if (folderPicker) throw new PoolError('PICKER_BUSY', 'Windows klasör seçme penceresi zaten açık.');
        folderPicker = pickWindowsFolder(initial, { directory: management.directory });
        try { return await folderPicker; } finally { folderPicker = null; }
      }
      if (operation === 'login') {
        const route = pool.config.routes.find(route => route.id === payload.routeId);
        if (!route) throw new PoolError('NOT_FOUND', 'Bağlantı bulunamadı.');
        return openCliLogin(route);
      }
      if (operation === 'skills') return workspaceSkills(payload.workspace || '', pool.config.workspaceRoots);
      if (operation === 'skill') return readWorkspaceSkill(payload.workspace || '', pool.config.workspaceRoots, payload.id);
      if (operation === 'select') return pool.selectLive(payload);
      if (operation === 'save') return managementOperation(pool, management, { ...payload, operation: 'save' });
      if (operation === 'scan_import') {
        const view = configView(management.directory);
        const imported = importDiscoveredRoutes(view.config);
        const catalogErrors = [];
        for (const route of imported.config.routes.filter(route => !route.api && (['claude', 'agy'].includes(route.adapter) || route.id === payload.routeId))) {
          try { imported.addedModels += mergeCatalogModels(route, await catalogFor(route), imported.config.modelFilters); }
          catch (error) { catalogErrors.push({ routeId: route.id, message: error instanceof PoolError ? error.message : 'Model sürümleri alınamadı.' }); }
        }
        pool.config = saveConfig(management.directory, imported.config, view.revision);
        pool.schedule();
        return { ...annotateView(configView(management.directory), management.directory), addedRoutes: imported.addedRoutes, addedModels: imported.addedModels, discoveredCount: imported.discoveredCount, catalogErrors };
      }
      if (operation === 'secret') {
        saveSecret(management.directory, payload.secretRef, payload.secret);
        return { saved: payload.secretRef };
      }
      if (operation === 'submit') return pool.submitLive(payload);
      if (operation === 'probe_model') return pool.probeModel(payload);
      if (operation === 'task') return pool.get(payload.taskId);
      if (operation === 'cancel') return pool.cancel(payload.taskId);
      if (operation === 'quota') return pool.getQuota(payload.routeId, payload.force === true);
      if (operation === 'quotas') {
        const routes = pool.config.routes.filter(route => !payload.routeId || route.id === payload.routeId);
        const quotas = {}, errors = {};
        await Promise.all(routes.map(async route => {
          try { quotas[route.id] = await pool.getQuota(route.id, payload.force === true); }
          catch (error) { errors[route.id] = error instanceof PoolError ? error.message : 'Kota sorgulanamadı'; }
        }));
        return { quotas, errors };
      }
      if (operation === 'catalog' || operation === 'refresh_catalog') {
        const route = pool.config.routes.find(r => r.id === payload.routeId);
        if (!route) throw new PoolError('NOT_FOUND', 'Bağlantı bulunamadı.');
        const catalog = await catalogFor(route);
        if (operation === 'catalog') return catalog;
        const view = configView(management.directory);
        mergeCatalogModels(view.config.routes.find(item => item.id === route.id), catalog, view.config.modelFilters);
        pool.config = saveConfig(management.directory, view.config, view.revision);
        return annotateView(configView(management.directory), management.directory);
      }
      throw new PoolError('INVALID_OPERATION', 'Geçersiz panel işlemi.');
    },
  };
}
import { version } from './version.js';
