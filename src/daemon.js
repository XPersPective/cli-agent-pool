import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { initialize, loadConfig, configView, saveConfig, allowedWorkspace, PoolError } from './config.js';
import { importDiscoveredRoutes } from './adapters.js';
import { capture } from './process.js';
import { version } from './version.js';

const poolBinPath = fileURLToPath(new URL('../bin/pool.js', import.meta.url));
const repoRootPath = fileURLToPath(new URL('..', import.meta.url));

export function ensureInitialized(directory, autoImport = true) {
  initialize(directory);
  if (autoImport) {
    const view = configView(directory);
    const imported = importDiscoveredRoutes(view.config);
    const changed = imported.addedRoutes > 0 || imported.addedModels > 0;
    if (changed) {
      saveConfig(directory, imported.config, view.revision);
    }
  }
  return loadConfig(directory);
}

export async function managementRequest(directory, config, body) {
  const managementToken = readFileSync(path.join(directory, 'management-token'), 'utf8').trim();
  const response = await fetch(`http://127.0.0.1:${config.port}/manage`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${managementToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
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

export async function ensureDaemon(directory, config = ensureInitialized(directory)) {
  try {
    const info = await managementRequest(directory, config, { operation: 'pair_ui' });
    return { ...info, started: false };
  } catch (error) {
    // A responding server may own active writes or even belong to another app.
    // Startup never kills a PID or an arbitrary listener to claim the port.
    if (error?.status) throw error;
  }
  const child = spawn(process.execPath, [poolBinPath, 'serve'], {
    cwd: directory,
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
    env: { ...process.env, CLI_AGENT_POOL_HOME: directory },
  });
  child.unref();

  for (let attempt = 0; attempt < 60; attempt++) {
    await delay(100);
    try {
      const info = await managementRequest(directory, config, { operation: 'pair_ui' });
      return { ...info, started: true };
    } catch {
      // Wait until HTTP listener is ready.
    }
  }
  throw new PoolError('DAEMON_START_TIMEOUT', 'CLI Agent Pool arka plan servisi başlatılamadı.');
}

export function openDashboardWindow(url) {
  if (process.platform === 'win32') {
    const programFiles = process.env.ProgramFiles || 'C:\\Program Files';
    const programFilesX86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
    const localAppData = process.env.LOCALAPPDATA || path.join(homedir(), 'AppData', 'Local');
    const browsers = [
      path.join(programFilesX86, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
      path.join(programFiles, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
      path.join(programFiles, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      path.join(localAppData, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    ];
    for (const browser of browsers) {
      if (existsSync(browser)) {
        const proc = spawn(browser, [`--app=${url}`, '--new-window'], {
          detached: true,
          stdio: 'ignore',
          windowsHide: false,
        });
        proc.unref();
        return { opened: true, mode: 'app-window', browser };
      }
    }
    const fallback = spawn('rundll32.exe', ['url.dll,FileProtocolHandler', url], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    });
    fallback.unref();
    return { opened: true, mode: 'default-browser' };
  }
  const opener = process.platform === 'darwin' ? 'open' : 'xdg-open';
  const proc = spawn(opener, [url], { detached: true, stdio: 'ignore' });
  proc.unref();
  return { opened: true, mode: 'default-browser' };
}

export function ensureWorkspaceAllowed(directory, workspacePath) {
  const resolved = path.resolve(workspacePath);
  const view = configView(directory);
  try {
    allowedWorkspace(resolved, view.config.workspaceRoots);
    return resolved;
  } catch {
    view.config.workspaceRoots.push(resolved);
    saveConfig(directory, view.config, view.revision);
    return resolved;
  }
}

export async function withMcpClient(directory, callback) {
  const config = ensureInitialized(directory);
  await ensureDaemon(directory, config);
  const token = readFileSync(path.join(directory, 'access-token'), 'utf8').trim();
  const client = new Client({ name: 'cli-agent-pool-cli', version });
  const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${config.port}/mcp`), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  });
  await client.connect(transport);
  try {
    return await callback(client, config);
  } finally {
    await client.close();
  }
}

export async function callPoolTool(client, name, args = {}) {
  const res = await client.callTool({ name, arguments: args });
  const text = res.content?.[0]?.text;
  const parsed = text ? JSON.parse(text) : res.structuredContent?.data;
  if (res.isError) {
    throw new PoolError(parsed?.error?.code || 'TOOL_FAILED', parsed?.error?.message || 'Havuz işlemi başarısız.');
  }
  return parsed;
}

export async function runTaskFromCli(directory, options) {
  const workspace = ensureWorkspaceAllowed(directory, options.workspace || process.cwd());
  const config = loadConfig(directory);
  await ensureDaemon(directory, config);
  const view = configView(directory);
  await managementRequest(directory, config, { operation: 'save', config: view.config, revision: view.revision });

  return withMcpClient(directory, async client => {
    const submitted = await callPoolTool(client, 'pool_submit', {
      prompt: options.prompt,
      workspace,
      kind: options.kind || 'read',
      ...(options.routeId ? { routeId: options.routeId } : {}),
      ...(options.modelId ? { modelId: options.modelId } : {}),
      ...(options.group ? { group: options.group } : {}),
      ...(options.effort ? { effort: options.effort } : {}),
      ...(options.timeoutSeconds ? { timeoutSeconds: Number(options.timeoutSeconds) } : {}),
      idempotencyKey: options.idempotencyKey || `cli-${randomUUID()}`,
    });
    if (options.detach) return submitted;
    const deadline = Date.now() + ((Number(options.timeoutSeconds) || 900) + 15) * 1000;
    while (Date.now() < deadline) {
      const current = await callPoolTool(client, 'pool_get_task', { taskId: submitted.id, after: 0 });
      if (!['queued', 'starting', 'running', 'cancelling'].includes(current.state)) {
        return current;
      }
      await delay(250);
    }
    throw new PoolError('CLI_WAIT_TIMEOUT', `Görev zaman aşımına uğradı: ${submitted.id}`);
  });
}

export async function installDesktopAndSkills(directory) {
  const config = ensureInitialized(directory, true);
  const daemonInfo = await ensureDaemon(directory, config);
  const appData = process.env.APPDATA || path.join(homedir(), 'AppData', 'Roaming');
  const globalPoolBin = path.join(appData, 'npm', 'node_modules', 'cli-agent-pool', 'bin', 'pool.js');
  const activePoolBin = existsSync(globalPoolBin) ? globalPoolBin : poolBinPath;
  const activeRoot = path.resolve(path.dirname(activePoolBin), '..');

  const results = {
    dataDirectory: directory,
    runtimePath: activeRoot,
    endpoint: daemonInfo.endpoint,
    routesConfigured: config.routes.length,
    restartRequired: daemonInfo.version !== version,
    desktopShortcut: null,
    startMenuShortcut: null,
    skillsManager: null,
  };

  if (process.platform === 'win32') {
    const vbsPath = path.join(directory, 'launch-ui.vbs');
    const escapedNode = process.execPath.replace(/"/g, '""');
    const escapedPool = activePoolBin.replace(/"/g, '""');
    const vbsContent = [
      'Set sh = CreateObject("WScript.Shell")',
      `sh.Run """${escapedNode}"" ""${escapedPool}"" open", 0, False`,
    ].join('\r\n') + '\r\n';
    writeFileSync(vbsPath, vbsContent, 'utf8');

    const psScript = `
$ErrorActionPreference = 'Stop'
$sh = New-Object -ComObject WScript.Shell
$desktop = [Environment]::GetFolderPath('Desktop')
$startMenu = Join-Path $env:APPDATA 'Microsoft\\Windows\\Start Menu\\Programs'
$vbs = ${JSON.stringify(vbsPath)}
$workDir = ${JSON.stringify(directory)}
$edgeExe = Join-Path $\{env:ProgramFiles(x86)} 'Microsoft\\Edge\\Application\\msedge.exe'
$icon = if (Test-Path $edgeExe) { "$edgeExe,0" } else { "$env:SystemRoot\\System32\\shell32.dll,13" }

foreach ($targetDir in @($desktop, $startMenu)) {
  if ($targetDir -and (Test-Path $targetDir)) {
    $lnkPath = Join-Path $targetDir 'CLI Agent Pool.lnk'
    $sc = $sh.CreateShortcut($lnkPath)
    $sc.TargetPath = Join-Path $env:SystemRoot 'System32\\wscript.exe'
    $sc.Arguments = '"' + $vbs + '"'
    $sc.WorkingDirectory = $workDir
    $sc.Description = 'CLI Agent Pool - Yerel AI CLI ve Model Havuzu'
    $sc.IconLocation = $icon
    $sc.Save()
  }
}
Write-Output (ConvertTo-Json @{ desktop = (Join-Path $desktop 'CLI Agent Pool.lnk'); startMenu = (Join-Path $startMenu 'CLI Agent Pool.lnk') })
`;
    const shortcutRes = await capture(['powershell.exe', '-NoProfile', '-NonInteractive', '-Command', psScript], directory, config.python);
    if (shortcutRes.code === 0) {
      try {
        const parsed = JSON.parse(shortcutRes.output.trim());
        results.desktopShortcut = parsed.desktop;
        results.startMenuShortcut = parsed.startMenu;
      } catch {
        results.desktopShortcut = 'CLI Agent Pool.lnk';
      }
    }
  }

  const skillFolder = existsSync(path.join(activeRoot, 'skills', 'cli-agent-pool'))
    ? path.join(activeRoot, 'skills', 'cli-agent-pool')
    : path.join(repoRootPath, 'skills', 'cli-agent-pool');
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
