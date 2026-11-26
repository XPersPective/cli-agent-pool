import { existsSync, readFileSync, writeFileSync, mkdirSync, cpSync, renameSync, unlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { initialize, loadConfig, configView, saveConfig, allowedWorkspace, dataDirectory, PoolError } from './config.js';
import { importDiscoveredRoutes } from './adapters.js';
import { capture, spawnDetachedHidden } from './process.js';
import { version } from './version.js';
import { taskHeader } from './task-header.js';
import { waitForTask } from './task-protocol.js';

const poolBinPath = fileURLToPath(new URL('../bin/pool.js', import.meta.url));
const repoRootPath = fileURLToPath(new URL('..', import.meta.url));

export function ensureInitialized(directory, autoImport = true) {
  initialize(directory);
  if (autoImport) {
    const view = configView(directory);
    const imported = importDiscoveredRoutes(view.config, directory);
    const changed = imported.addedRoutes > 0 || imported.addedModels > 0 || imported.refreshedModels > 0;
    if (changed) {
      saveConfig(directory, imported.config, view.revision);
    }
  }
  return loadConfig(directory);
}

export async function managementRequest(directory, config, body, { signal, timeoutMs = 4000 } = {}) {
  const managementToken = readFileSync(path.join(directory, 'management-token'), 'utf8').trim();
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const combinedSignal = signal ? AbortSignal.any([timeoutSignal, signal]) : timeoutSignal;
  const response = await fetch(`http://127.0.0.1:${config.port}/manage`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${managementToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
    signal: combinedSignal,
  });
  if (!response.ok) {
    const text = await response.text();
    const err = new PoolError(response.status===401?'DAEMON_IDENTITY_CONFLICT':'MANAGE_FAILED', response.status===401?'Bu porttaki servis bu kurulumun veri diziniyle eşleşmiyor. Açık başka havuz örneğini kontrol edin; çalışan servis otomatik kapatılmadı.':`Yönetim isteği başarısız (${response.status}): ${text}`);
    err.status = response.status;
    err.body = text;
    throw err;
  }
  return response.json();
}

const ensuringDaemons = new Map();

export async function ensureDaemon(directory, config = ensureInitialized(directory), { signal } = {}) {
  const key = `${path.resolve(directory)}:${config.port}`;
  if (ensuringDaemons.has(key)) return ensuringDaemons.get(key);
  const work = (async () => {
    try {
      const info = await managementRequest(directory, config, { operation: 'pair_ui' }, { signal });
      return { ...info, started: false };
    } catch (error) {
      // A responding server may own active writes or even belong to another app.
      // Startup never kills a PID or an arbitrary listener to claim the port.
      if (signal?.aborted) throw error;
      if (error?.status) throw error;
    }
    spawnDetachedHidden([process.execPath, poolBinPath, 'serve'], {
      cwd: directory,
      env: { ...process.env, CLI_AGENT_POOL_HOME: directory },
      python: config.python,
    });

    for (let attempt = 0; attempt < 100; attempt++) {
      await delay(100, undefined, signal ? { signal } : undefined);
      try {
        const info = await managementRequest(directory, config, { operation: 'pair_ui' }, { signal });
        return { ...info, started: true };
      } catch (error) {
        if (signal?.aborted) throw error;
        if (error?.status) throw error;
        // Wait until HTTP listener is ready.
      }
    }
    throw new PoolError('DAEMON_START_TIMEOUT', 'CLI Agent Pool arka plan servisi başlatılamadı.');
  })();
  ensuringDaemons.set(key, work);
  try { return await work; } finally { ensuringDaemons.delete(key); }
}

export async function remoteManagementRequest(directory, body, port = 43128) {
  const managementToken = readFileSync(path.join(directory, 'management-token'), 'utf8').trim();
  const response = await fetch(`http://127.0.0.1:${port}/r/manage`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${managementToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(4000),
  });
  if (!response.ok) {
    const text = await response.text();
    const err = new PoolError(response.status === 401 ? 'DAEMON_IDENTITY_CONFLICT' : 'MANAGE_FAILED', `Remote yönetim isteği başarısız (${response.status}): ${text}`);
    err.status = response.status;
    throw err;
  }
  return response.json();
}

export async function ensureRemoteDaemon(directory, { host = 'tailscale', port = 43128, python = undefined, wait = true } = {}) {
  const config = ensureInitialized(directory, false);
  try {
    const info = await remoteManagementRequest(directory, { operation: 'pair_local' }, port);
    return { ...info, started: false };
  } catch (error) {
    if (error?.status) throw error;
  }
  spawnDetachedHidden([process.execPath, poolBinPath, 'remote', '--host', host, '--port', String(port)], {
    cwd: directory,
    env: { ...process.env, CLI_AGENT_POOL_HOME: directory },
    python: python || config.python,
  });
  if (!wait) return { started: true, port };
  for (let attempt = 0; attempt < 60; attempt++) {
    await delay(100);
    try {
      const info = await remoteManagementRequest(directory, { operation: 'pair_local' }, port);
      return { ...info, started: true };
    } catch (error) {
      if (error?.status) throw error;
      // Wait until Remote HTTP listener is ready.
    }
  }
  throw new PoolError('REMOTE_START_TIMEOUT', 'CLI Agent Remote arka plan servisi başlatılamadı.');
}

export async function stopRemoteDaemon(directory, port = 43128) {
  try {
    return await remoteManagementRequest(directory, { operation: 'shutdown' }, port);
  } catch (error) {
    if (error?.status) throw error;
    return { stopped: true, alreadyStopped: true };
  }
}

const CONHOST_GUID = '{B23D10C0-E52E-411E-9D5B-209FDF7094FF}';

export async function windowsConsoleHostStatus(python = 'python', { platform = process.platform, runCapture = capture } = {}) {
  if (platform !== 'win32') return { supported: false, fixed: true, needsFix: false };
  try {
    const res = await runCapture(['reg.exe', 'query', 'HKCU\\Console\\%%Startup'], homedir(), python, {}, 5000);
    const text = res.output || '';
    const cons = /DelegationConsole\s+REG_SZ\s+(\S+)/i.exec(text)?.[1] || '';
    const term = /DelegationTerminal\s+REG_SZ\s+(\S+)/i.exec(text)?.[1] || '';
    const fixed = cons.toUpperCase() === CONHOST_GUID && term.toUpperCase() === CONHOST_GUID;
    return { supported: true, fixed, needsFix: !fixed, delegationConsole: cons || 'default', delegationTerminal: term || 'default' };
  } catch {
    return { supported: true, fixed: false, needsFix: true, delegationConsole: 'default', delegationTerminal: 'default' };
  }
}

export async function applyWindowsConsoleHostFix(python = 'python', { platform = process.platform, runCapture = capture } = {}) {
  if (platform !== 'win32') return { supported: false, fixed: true, applied: false };
  const key = 'HKCU\\Console\\%%Startup';
  const r1 = await runCapture(['reg.exe', 'add', key, '/v', 'DelegationConsole', '/t', 'REG_SZ', '/d', CONHOST_GUID, '/f'], homedir(), python, {}, 5000);
  const r2 = await runCapture(['reg.exe', 'add', key, '/v', 'DelegationTerminal', '/t', 'REG_SZ', '/d', CONHOST_GUID, '/f'], homedir(), python, {}, 5000);
  if (r1.code !== 0 || r2.code !== 0) {
    throw new PoolError('CONSOLE_FIX_FAILED', 'Windows konsol delegasyon ayarı güncellenemedi.');
  }
  return { supported: true, fixed: true, applied: true, delegationConsole: CONHOST_GUID, delegationTerminal: CONHOST_GUID };
}

async function dashboardExecutable(directory, python = undefined) {
  const source = readFileSync(new URL('./dashboard.cs', import.meta.url));
  const cache = path.join(directory, 'ui');
  const digest = createHash('sha256').update(source).digest('hex').slice(0,16);
  const executable = path.join(cache, 'dashboard-' + digest + '.exe');
  if (!existsSync(executable)) {
    mkdirSync(cache, { recursive:true, mode:0o700 });
    const filename = path.join(cache, 'dashboard-' + digest + '.cs');
    writeFileSync(filename,source,{mode:0o600});
    const compiler = path.join(process.env.SystemRoot || 'C:\\Windows','Microsoft.NET','Framework64','v4.0.30319','csc.exe');
    const tempExe = path.join(cache, `dashboard-${digest}-${randomBytes(6).toString('hex')}.exe`);
    try {
      const result = await capture([compiler,'/nologo','/target:winexe','/out:'+tempExe,'/reference:System.Web.Extensions.dll','/reference:System.Management.dll','/reference:System.Windows.Forms.dll',filename],directory,python);
      if(result.code!==0) throw new PoolError('DASHBOARD_BUILD_FAILED','Windows panel baslaticisi hazirlanamadi.');
      try { renameSync(tempExe, executable); } catch { if (!existsSync(executable)) throw new PoolError('DASHBOARD_BUILD_FAILED','Windows panel baslaticisi hazirlanamadi.'); }
    } finally {
      if (existsSync(tempExe)) { try { unlinkSync(tempExe); } catch { /* ignore */ } }
    }
  }
  return executable;
}

export async function openDashboardWindow(url, { remote = false, reauth = false, directory = dataDirectory() } = {}) {
  const windows = process.platform === 'win32';
  const executable = windows ? await dashboardExecutable(directory) : process.platform === 'darwin' ? 'open' : 'xdg-open';
  const winArgs = remote
    ? [directory, '--remote-url', url, 'remote']
    : [directory, '--url', url, ...(reauth ? ['--reauth'] : [])];
  const proc = spawn(executable, windows ? winArgs : [url], { detached:true, stdio:'ignore', windowsHide:false });
  if(windows) {
    const [code] = await once(proc,'exit');
    if(code!==0) throw new PoolError('DASHBOARD_FAILED', remote ? 'Remote penceresi acilamadi.' : 'Panel penceresi acilamadi.');
  } else await once(proc,'spawn');
  proc.unref();
  return { launchRequested:true, mode:windows?'app-window':'default-browser' };
}

export async function openRemoteWindow(url, options = {}) {
  return openDashboardWindow(url, { ...options, remote: true });
}

export async function apiRequest(directory, routePath, { method = 'GET', body, timeoutMs = 120_000 } = {}) {
  const config = ensureInitialized(directory, !existsSync(path.join(directory, 'config.json')));
  const send = () => {
    const token = readFileSync(path.join(directory, 'access-token'), 'utf8').trim();
    return fetch(`http://127.0.0.1:${config.port}${routePath}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...taskHeader(),
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(timeoutMs),
    });
  };
  let response;
  try {
    response = await send();
  } catch (error) {
    if (error?.name === 'TimeoutError') {
      throw new PoolError('REQUEST_TIMEOUT', 'Havuz isteği zaman aşımına uğradı.');
    }
    await ensureDaemon(directory, config);
    response = await send();
  }
  if (response.status === 401) {
    throw new PoolError('DAEMON_IDENTITY_CONFLICT', 'Bu porttaki servis bu kurulumun veri diziniyle eşleşmiyor. Açık başka havuz örneğini kontrol edin; çalışan servis otomatik kapatılmadı.');
  }
  const parsed = await response.json();
  if (!response.ok) {
    throw new PoolError(parsed?.error?.code || 'TOOL_FAILED', parsed?.error?.message || `Havuz isteği başarısız (${response.status}).`);
  }
  return parsed;
}

async function openMcpClient(directory, config) {
  const token = readFileSync(path.join(directory, 'access-token'), 'utf8').trim();
  const client = new Client({ name: 'cli-agent-pool-cli', version });
  const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${config.port}/mcp`), {
    requestInit: { headers: { Authorization: `Bearer ${token}`, ...taskHeader() } },
  });
  await client.connect(transport, { timeout: 15_000 });
  return client;
}

export async function withMcpClient(directory, callback) {
  const config = ensureInitialized(directory, !existsSync(path.join(directory, 'config.json')));
  await ensureDaemon(directory, config);
  const client = await openMcpClient(directory, config);
  try {
    return await callback(client, config);
  } finally {
    try { await client.close(); } catch { /* ignore close errors */ }
  }
}

export async function callPoolTool(client, name, args = {}, { timeout = 120_000 } = {}) {
  const res = await client.callTool({ name, arguments: args }, undefined, { timeout });
  const text = res.content?.[0]?.text;
  let parsed;
  try { parsed = text ? JSON.parse(text) : res.structuredContent?.data; }
  catch {
    // MCP validation/transport errors can be plain text, not our JSON envelope.
    throw new PoolError('TOOL_FAILED', 'MCP yanıtı beklenen JSON biçiminde değil. Araç adını ve argümanlarını kontrol edin.');
  }
  if (res.isError) {
    throw new PoolError(parsed?.error?.code || 'TOOL_FAILED', parsed?.error?.message || 'Havuz işlemi başarısız.');
  }
  return parsed;
}

export async function waitTaskWithReconnect(directory, initialClient, config, taskId, { waitSeconds = 0, sleep = delay } = {}) {
  let client = initialClient;
  let ownsClient = false;
  const getTask = async id => {
    let lastError = null;
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        return await callPoolTool(client, 'pool_get_task', { taskId: id, compact: true });
      } catch (error) {
        if (error instanceof PoolError) throw error;
        lastError = error;
        if (attempt === 4) break;
        if (ownsClient) { try { await client.close(); } catch { /* ignore */ } }
        await sleep(500);
        await ensureDaemon(directory, config);
        client = await openMcpClient(directory, config);
        ownsClient = true;
      }
    }
    throw lastError;
  };
  try {
    return await waitForTask(getTask, taskId, { waitSeconds, sleep });
  } finally {
    if (ownsClient) { try { await client.close(); } catch { /* ignore */ } }
  }
}

export async function runTaskFromCli(directory, options) {
  const waitSeconds = Number(options.waitSeconds ?? 0);
  if (!Number.isInteger(waitSeconds) || waitSeconds < 0 || waitSeconds > Math.floor(2147483647 / 1000))
    throw new PoolError('INVALID_REQUEST', '--wait 0 (süresiz) veya pozitif saniye olmalı ve native timer aralığında kalmalı.');
  const workspace = allowedWorkspace(options.workspace || process.cwd());
  const config = ensureInitialized(directory, !existsSync(path.join(directory, 'config.json')));
  await ensureDaemon(directory, config);

  return withMcpClient(directory, async (client, cfg) => {
    const submitted = await callPoolTool(client, 'pool_submit', {
      prompt: options.prompt,
      workspace,
      kind: options.kind || (options.mode === 'execute' ? 'write' : options.mode === 'response' ? 'text' : 'read'),
      ...(options.mode ? { mode: options.mode } : {}),
      ...(options.routeId ? { routeId: options.routeId } : {}),
      ...(options.modelId ? { modelId: options.modelId } : {}),
      ...(options.group ? { group: options.group } : {}),
      ...(options.effort ? { effort: options.effort } : {}),
      ...(options.timeoutSeconds !== undefined ? { timeoutSeconds: Number(options.timeoutSeconds) } : {}),
      idempotencyKey: options.idempotencyKey || `cli-${randomUUID()}`,
    });
    if (options.detach) return submitted;
    return waitTaskWithReconnect(directory, client, cfg, submitted.id, { waitSeconds, sleep: delay });
  });
}

export function compareSemver(a, b) {
  const parse = v => String(v || '').replace(/^v/i, '').split('.').map(n => Number.parseInt(n, 10) || 0);
  const pa = parse(a), pb = parse(b);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) - (pb[i] || 0);
  }
  return 0;
}

export function updateNeedsRestart(runningVersion, installedVersion) {
  if (typeof installedVersion !== 'string' || !installedVersion) return false;
  if (typeof runningVersion !== 'string' || !runningVersion) return true;
  return installedVersion !== runningVersion;
}

export function resolveRuntimeRoot(installedRoot = null) {
  const appData = process.env.APPDATA || path.join(homedir(), 'AppData', 'Roaming');
  const globalPoolBin = path.join(appData, 'npm', 'node_modules', 'cli-agent-pool', 'bin', 'pool.js');
  return installedRoot ? path.resolve(installedRoot) : existsSync(globalPoolBin) ? path.resolve(path.dirname(globalPoolBin), '..') : repoRootPath;
}

export function readInstalledVersion(installedRoot = null) {
  const activeRoot = resolveRuntimeRoot(installedRoot);
  try {
    return JSON.parse(readFileSync(path.join(activeRoot, 'package.json'), 'utf8')).version || null;
  } catch {
    return null;
  }
}

export async function liveServiceVersion(config, fetchImpl = fetch) {
  try {
    const res = await fetchImpl(`http://127.0.0.1:${config.port}/api/health`, { signal: AbortSignal.timeout(2000) });
    if (!res.ok) return null;
    const data = await res.json();
    return typeof data?.version === 'string' && data.version ? data.version : null;
  } catch {
    return null;
  }
}

let remoteUpdateCache = { checkedAt: 0, latestVersion: null };

export async function checkUpdateStatus({ runningVersion = version, installedRoot = null, fetchImpl = fetch, checkRemote = true, force = false } = {}) {
  const installedVersion = readInstalledVersion(installedRoot) || runningVersion;
  const restartRequired = updateNeedsRestart(runningVersion, installedVersion);
  let latestVersion = remoteUpdateCache.latestVersion;
  const now = Date.now();
  if (checkRemote && (force || now - remoteUpdateCache.checkedAt > 10 * 60_000)) {
    try {
      const res = await fetchImpl('https://api.github.com/repos/XPersPective/cli-agent-pool/tags?per_page=10', {
        headers: { Accept: 'application/vnd.github+json', 'User-Agent': `cli-agent-pool/${runningVersion}` },
        signal: AbortSignal.timeout(4000),
      });
      if (res.ok) {
        const tags = await res.json();
        const versions = (Array.isArray(tags) ? tags : [])
          .map(t => String(t?.name || '').replace(/^v/i, ''))
          .filter(v => /^\d+\.\d+\.\d+$/.test(v))
          .sort((a, b) => compareSemver(b, a));
        latestVersion = versions[0] || null;
        remoteUpdateCache = { checkedAt: now, latestVersion };
      }
    } catch {
      remoteUpdateCache = { checkedAt: now, latestVersion: remoteUpdateCache.latestVersion };
    }
  }
  const remoteNewer = Boolean(latestVersion && compareSemver(latestVersion, installedVersion || runningVersion) > 0);
  const updateAvailable = restartRequired || remoteNewer;
  const targetVersion = remoteNewer ? latestVersion : installedVersion;
  return {
    runningVersion,
    installedVersion,
    latestVersion: latestVersion || installedVersion,
    restartRequired,
    remoteNewer,
    updateAvailable,
    targetVersion,
    checkedAt: new Date().toISOString(),
  };
}

export function scheduleServiceRestart(directory, targetPoolBin = poolBinPath, python = undefined) {
  const entry = targetPoolBin || poolBinPath;
  spawnDetachedHidden([process.execPath, entry, 'restart'], {
    cwd: directory,
    env: { ...process.env, CLI_AGENT_POOL_HOME: directory },
    ...(python ? { python } : {}),
  });
  return { scheduled: true };
}

export async function installDesktopAndSkills(directory, installedRoot = null, { fixConsole = false } = {}) {
  const config = ensureInitialized(directory, true);
  const daemonInfo = await ensureDaemon(directory, config);
  let remoteInfo = null;
  try { remoteInfo = await ensureRemoteDaemon(directory, { python: config.python }); } catch { /* optional */ }
  const activeRoot = resolveRuntimeRoot(installedRoot);
  const activePoolBin = path.join(activeRoot, 'bin', 'pool.js');
  const installedVersion = readInstalledVersion(activeRoot);
  const liveVersion = (await liveServiceVersion(config)) || version;
  const consoleHost = fixConsole
    ? await applyWindowsConsoleHostFix(config.python)
    : await windowsConsoleHostStatus(config.python);

  const results = {
    dataDirectory: directory,
    runtimePath: activeRoot,
    endpoint: daemonInfo.endpoint,
    remotePort: remoteInfo?.port || 43128,
    routesConfigured: config.routes.length,
    runningVersion: liveVersion,
    installedVersion,
    restartRequired: updateNeedsRestart(liveVersion, installedVersion),
    windowsConsoleHost: consoleHost,
    desktopShortcut: null,
    startMenuShortcut: null,
    remoteDesktopShortcut: null,
    remoteStartMenuShortcut: null,
    skillsManager: null,
  };

  if (process.platform === 'win32') {
    const launcher = await dashboardExecutable(directory, config.python);
    const quoteArg = value => `"${String(value).replace(/\\+$/, m => m + m)}"`;
    const psScript = [
      "$ErrorActionPreference = 'Stop'",
      '$sh = New-Object -ComObject WScript.Shell',
      "$desktop = [Environment]::GetFolderPath('Desktop')",
      "$startMenu = Join-Path $env:APPDATA 'Microsoft\\Windows\\Start Menu\\Programs'",
      '$launcher = $env:POOL_SHORTCUT_LAUNCHER',
      '$workDir = $env:POOL_SHORTCUT_WORKDIR',
      '$poolArgs = $env:POOL_SHORTCUT_ARGS',
      '$remoteArgs = $env:POOL_SHORTCUT_REMOTE_ARGS',
      "$edgeExe = Join-Path ${env:ProgramFiles(x86)} 'Microsoft\\Edge\\Application\\msedge.exe'",
      '$icon = if (Test-Path $edgeExe) { "$edgeExe,0" } else { "$env:SystemRoot\\System32\\shell32.dll,13" }',
      'foreach ($targetDir in @($desktop, $startMenu)) {',
      '  if ($targetDir -and (Test-Path $targetDir)) {',
      "    $lnkPath = Join-Path $targetDir 'CLI Agent Pool.lnk'",
      '    $sc = $sh.CreateShortcut($lnkPath)',
      '    $sc.TargetPath = $launcher',
      '    $sc.Arguments = $poolArgs',
      '    $sc.WorkingDirectory = $workDir',
      "    $sc.Description = 'CLI Agent Pool - Yerel AI CLI ve Model Havuzu'",
      '    $sc.IconLocation = $icon',
      '    $sc.Save()',
      "    $remoteLnk = Join-Path $targetDir 'CLI Agent Remote.lnk'",
      '    $rsc = $sh.CreateShortcut($remoteLnk)',
      '    $rsc.TargetPath = $launcher',
      '    $rsc.Arguments = $remoteArgs',
      '    $rsc.WorkingDirectory = $workDir',
      "    $rsc.Description = 'CLI Agent Remote - Mobil ve Masaustu Ajan Sohbeti'",
      '    $rsc.IconLocation = $icon',
      '    $rsc.Save()',
      '  }',
      '}',
      '$runtimeDir = [IO.Path]::GetDirectoryName([IO.Path]::GetDirectoryName($launcher))',
      "Write-Output (ConvertTo-Json @{ desktop = (Join-Path $desktop 'CLI Agent Pool.lnk'); startMenu = (Join-Path $startMenu 'CLI Agent Pool.lnk'); remoteDesktop = (Join-Path $desktop 'CLI Agent Remote.lnk'); remoteStartMenu = (Join-Path $startMenu 'CLI Agent Remote.lnk'); runtimeDirectory = $runtimeDir })",
    ].join('\n');
    const shortcutEnv = {
      POOL_SHORTCUT_LAUNCHER: launcher,
      POOL_SHORTCUT_WORKDIR: directory,
      POOL_SHORTCUT_ARGS: `${quoteArg(directory)} ${quoteArg(process.execPath)} ${quoteArg(activePoolBin)}`,
      POOL_SHORTCUT_REMOTE_ARGS: `${quoteArg(directory)} ${quoteArg(process.execPath)} ${quoteArg(activePoolBin)} "remote"`,
    };
    const shortcutRes = await capture(['powershell.exe', '-NoProfile', '-NonInteractive', '-Command', psScript], directory, config.python, shortcutEnv);
    if (shortcutRes.code !== 0) throw new PoolError('SHORTCUT_FAILED', 'Windows kisayollari olusturulamadi.');
    if (shortcutRes.code === 0) {
      try {
        const parsed = JSON.parse(shortcutRes.output.trim());
        results.desktopShortcut = parsed.desktop;
        results.startMenuShortcut = parsed.startMenu;
        results.remoteDesktopShortcut = parsed.remoteDesktop;
        results.remoteStartMenuShortcut = parsed.remoteStartMenu;
        if (parsed.runtimeDirectory && !process.env.CLI_AGENT_POOL_HOME) {
          const locator = path.join(homedir(),'.cli-agent-pool');
          mkdirSync(locator,{recursive:true,mode:0o700});
          writeFileSync(path.join(locator,'runtime-path'),parsed.runtimeDirectory+'\n',{mode:0o600});
        }
      } catch {
        results.desktopShortcut = 'CLI Agent Pool.lnk';
      }
    }
  }

  const skillFolder = existsSync(path.join(activeRoot, 'skills', 'cli-agent-pool'))
    ? path.join(activeRoot, 'skills', 'cli-agent-pool')
    : path.join(repoRootPath, 'skills', 'cli-agent-pool');
  const agyConfigSkills = path.join(homedir(), '.gemini', 'config', 'skills');
  if (existsSync(path.join(skillFolder, 'SKILL.md')) && existsSync(agyConfigSkills)) {
    const targetDir = path.join(agyConfigSkills, 'cli-agent-pool');
    mkdirSync(targetDir, { recursive: true });
    writeFileSync(path.join(targetDir, 'SKILL.md'), readFileSync(path.join(skillFolder, 'SKILL.md')));
    if (existsSync(path.join(skillFolder, 'references'))) cpSync(path.join(skillFolder, 'references'), path.join(targetDir, 'references'), { recursive: true });
  }
  const smCli = path.join(homedir(), '.skills-manager', 'bin', process.platform === 'win32' ? 'skills-manager-cli.exe' : 'skills-manager-cli');
  if (existsSync(skillFolder) && existsSync(smCli)) {
    const listRes = await capture([smCli, '--json', 'skills', 'list'], activeRoot, config.python);
    let agents = ['antigravity', 'claude_code', 'codex', 'opencode', 'qwen_code', 'zcode', 'kimi'];
    let alreadyInstalled = false;
    try {
      const skills = JSON.parse(listRes.output);
      alreadyInstalled = skills.some(s => s.name === 'cli-agent-pool');
      const existing = skills.find(s => s.name === 'cli-agent-pool' && Array.isArray(s.deployed_to) && s.deployed_to.length > 0);
      if (existing) agents = existing.deployed_to;
    } catch { /* use default agent list */ }

    const installRes = alreadyInstalled
      ? await capture([smCli, '--json', 'skills', 'update', 'cli-agent-pool'], activeRoot, config.python)
      : await capture([smCli, '--json', 'skills', 'install', skillFolder, '--local'], activeRoot, config.python);
    await capture([smCli, '--json', 'presets', 'add-skill', 'Default', 'cli-agent-pool'], activeRoot, config.python);
    const deployArgs = [smCli, '--json', 'skills', 'deploy', 'cli-agent-pool'];
    for (const agent of agents) deployArgs.push('--agent', agent);
    const deployRes = await capture(deployArgs, activeRoot, config.python);
    results.skillsManager = {
      installed: installRes.code === 0 || alreadyInstalled,
      deployed: deployRes.code === 0,
      agentsCount: agents.length,
    };
  }

  return results;
}
