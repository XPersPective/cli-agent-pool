#!/usr/bin/env node
import { readFileSync, writeFileSync, rmSync, realpathSync } from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { dataDirectory, initialize, loadConfig, configView, saveConfig, PoolError } from '../src/config.js';
import { discover, commandArgv, routeCatalog, importDiscoveredRoutes, mergeCatalogModels } from '../src/adapters.js';
import { capture, spawnDetachedHidden } from '../src/process.js';
import { Store } from '../src/store.js';
import { Pool } from '../src/pool.js';
import { createServer } from '../src/server.js';
import { codexControl } from '../src/codex-control.js';
import { prepareWslProfile, prepareNativeAgyProfile } from '../src/accounts.js';
import { stdioBridge } from '../src/stdio.js';
import { rpcRequest } from '../src/rpc.js';
import { version } from '../src/version.js';
import { ensureInitialized, ensureDaemon, ensureRemoteDaemon, stopRemoteDaemon, managementRequest, openDashboardWindow, openRemoteWindow, windowsConsoleHostStatus, applyWindowsConsoleHostFix, withMcpClient, apiRequest, callPoolTool, waitTaskWithReconnect, runTaskFromCli, installDesktopAndSkills, scheduleServiceRestart } from '../src/daemon.js';
import { createRemoteServer } from '../remote/server.js';
import { setTimeout as delay } from 'node:timers/promises';

const booleanFlags = new Set(['detach', 'live', 'force', 'status', 'open', 'fix-console']);

function parseFlags(args) {
  const flags = {};
  const positional = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--') { positional.push(...args.slice(i + 1)); break; }
    if (arg.startsWith('--')) {
      const eq = arg.indexOf('=');
      if (eq > 2) {
        flags[arg.slice(2, eq)] = arg.slice(eq + 1);
        continue;
      }
      const key = arg.slice(2);
      if (booleanFlags.has(key)) {
        flags[key] = true;
        continue;
      }
      const next = args[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        flags[key] = next;
        i++;
      } else {
        flags[key] = true;
      }
    } else {
      positional.push(arg);
    }
  }
  return { flags, positional };
}

// Repeated flags (--read-path a --read-path b) collect into arrays.
function multiFlags(args) {
  const values = {};
  const positional = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--') { positional.push(...args.slice(i + 1)); break; }
    if (!arg.startsWith('--')) { positional.push(arg); continue; }
    const eq = arg.indexOf('=');
    if (eq > 2) {
      const key = arg.slice(2, eq);
      (values[key] ||= []).push(arg.slice(eq + 1));
      continue;
    }
    const key = arg.slice(2);
    if (booleanFlags.has(key)) { (values[key] ||= []).push(true); continue; }
    const next = args[i + 1];
    let value = true;
    if (next !== undefined && !next.startsWith('--')) { value = next; i++; }
    (values[key] ||= []).push(value);
  }
  return { values, positional };
}

// Pool tasks always carry CLI_AGENT_POOL_WORKER=1; owner operations refuse to run from inside one.
function ownerOnly() {
  if (process.env.CLI_AGENT_POOL_WORKER === '1') throw new PoolError('OWNER_ONLY', 'This is an owner operation; it cannot run from inside a Pool task. Ask the owner session to run it.');
}

export async function main(args = process.argv.slice(2)) {
  const [command, ...rest] = args;
  const directory = dataDirectory();
  const print = value => console.log(JSON.stringify(value, null, 2));
  if (!command || command === 'help' || command === '--help') {
    console.log([
      `CLI Agent Pool (v${version})`,
      '',
      '  install                 Set up local pool, scan CLIs, create Desktop shortcut & deploy skill',
      '  open                    Auto-start background service if needed and open desktop app window',
      '  remote-open             Auto-start Pool + Remote services and open authenticated Remote desktop window',
      '  remote-ensure           Ensure background Remote service is running and print a fresh local pairing URL',
      '  remote-stop             Stop the background Remote service',
      '  remote                  Run Remote Agent Chat PWA in foreground (--host 127.0.0.1|tailscale --port 43128 --open)',
      '  fix-console             Check or apply Windows Console Host fix to stop background 0x800700e8 popups (--status)',
      '  ensure                  Ensure background pool service is running',
      '  stop                    Safely stop the background pool service (--force to stop during active tasks)',
      '  restart                 Stop the background service and start a fresh one (used after an update)',
      '  api                     Show local HTTP /api map and base URL (auto-starts service)',
      '  status                  Show active connections, quotas, pools and catalog (auto-starts service)',
      '  pools                   Categories; --group <id> reads one category model page',
      '  quotas                  Cached connection quotas; --route <id> [--live] queries one route',
      '  model                   Single model details and cached quota (--route <id> --model <id>)',
      '  help-code               Recovery guidance (--code AUTH_REQUIRED)',
      '  catalog                 Catalog sources or model page (--billing free --query name --view models)',
      '  rpc                     Call one agent MCP tool using a JSON request on stdin (auto-starts service)',
      '  mcp-config              Print credential-free stdio configuration for editors and Freebuff',
      '  select                  Select best available model (--kind read|write|text --group <g>)',
      '  run                     Run a task (--mode response|execute --workspace <dir> --prompt <text>; --wait seconds)',
      '  init                    Create private local configuration',
      '  discover                Scan system for all installed AI CLIs and local model configs',
      '  scan-import             Import all discovered CLIs and models into local config',
      '  validate                Validate local configuration',
      '  models <route>          Discover models for a route without starting a task',
      '  refresh-models <route>  Update catalog for a route, preserving manual groups',
      '  serve                   Run background HTTP MCP and dashboard server in foreground',
      '  stdio                   Connect an MCP coding tool to the shared pool (auto-starts service)',
      '  resolve <task-id>       Release an interrupted workspace after manual inspection',
      '  preflight               Director readiness probes (--route R --workspace W [--model M] [--read-path P]... [--capability C]... [--force])',
      '',
      'Configuration: ' + path.join(directory, 'config.json'),
    ].join('\n'));
    return;
  }
  if (command === 'mcp-config') {
    print({ mcpServers: { 'cli-agent-pool': { command: process.execPath, args: [fileURLToPath(import.meta.url), 'stdio'] } } });
    return;
  }
  if (command === 'install' || command === 'setup') {
    ownerOnly();
    const { flags } = parseFlags(rest);
    const res = await installDesktopAndSkills(directory, null, { fixConsole: Boolean(flags['fix-console']) });
    if (res.restartRequired) {
      const targetBin = res.runtimePath ? path.join(res.runtimePath, 'bin', 'pool.js') : undefined;
      scheduleServiceRestart(directory, targetBin, ensureInitialized(directory, false).python);
      res.restartScheduled = true;
    }
    print(res);
    return;
  }
  if (command === 'fix-console') {
    ownerOnly();
    const { flags } = parseFlags(rest);
    const config = ensureInitialized(directory, false);
    print(flags.status
      ? await windowsConsoleHostStatus(config.python)
      : await applyWindowsConsoleHostFix(config.python));
    return;
  }
  if (command === 'open' || command === 'ui' || command === 'dashboard') {
    ownerOnly();
    const config = ensureInitialized(directory, false);
    const info = await ensureDaemon(directory, config);
    void ensureRemoteDaemon(directory, { python: config.python, wait: false }).catch(() => {});
    const windowInfo = await openDashboardWindow(info.dashboard, { reauth: Boolean(info.reauthNeeded) });
    print({ ...info, ...windowInfo });
    return;
  }
  if (command === 'remote-ensure') {
    ownerOnly();
    const { flags } = parseFlags(rest);
    const config = ensureInitialized(directory, false);
    try { await ensureDaemon(directory, config); } catch { /* Remote UI can still start Pool */ }
    const port = flags.port !== undefined ? Number(flags.port) : 43128;
    const host = String(flags.host || 'tailscale');
    print(await ensureRemoteDaemon(directory, { host, port, python: config.python }));
    return;
  }
  if (command === 'remote-open') {
    ownerOnly();
    const { flags } = parseFlags(rest);
    const config = ensureInitialized(directory, false);
    try { await ensureDaemon(directory, config); } catch { /* Remote UI can still start Pool */ }
    const port = flags.port !== undefined ? Number(flags.port) : 43128;
    const host = String(flags.host || 'tailscale');
    const info = await ensureRemoteDaemon(directory, { host, port, python: config.python });
    const windowInfo = await openRemoteWindow(info.localUrl);
    print({ ...info, ...windowInfo });
    return;
  }
  if (command === 'remote-stop') {
    ownerOnly();
    const { flags } = parseFlags(rest);
    const port = flags.port !== undefined ? Number(flags.port) : 43128;
    print(await stopRemoteDaemon(directory, port));
    return;
  }
  if (command === 'remote') {
    ownerOnly();
    const { values } = multiFlags(rest);
    const host = String(values.host?.[values.host.length - 1] || 'tailscale');
    const portArg = values.port?.[values.port.length - 1];
    const port = portArg !== undefined ? Number(portArg) : 43128;
    if (!Number.isInteger(port) || port < 0 || port > 65535) {
      throw new PoolError('INVALID_REQUEST', '--port 0 ile 65535 arasında tam sayı olmalıdır.');
    }
    const allowHosts = (values['allow-host'] || []).filter(v => typeof v === 'string');
    let closing = false;
    let remote = null;
    const shutdown = async () => {
      if (closing) return;
      closing = true;
      if (remote) await remote.close();
      process.exit(0);
    };
    remote = createRemoteServer({ directory, port, host, allowHosts, onShutdown: shutdown });
    const info = await remote.listen();
    print({
      status: 'listening',
      ...info,
      pairingHint: 'Tek kullanımlık eşleştirme bağlantısını açın veya arayüzdeki QR kodu telefonunuzdan okutun.',
    });
    if (values.open) {
      try { await openRemoteWindow(info.localUrl); } catch { /* headless fallback */ }
    }
    process.once('SIGINT', () => { void shutdown(); });
    process.once('SIGTERM', () => { void shutdown(); });
    return;
  }
  if (command === 'ensure' || command === 'start') {
    const config = ensureInitialized(directory, true);
    const info = await ensureDaemon(directory, config);
    void ensureRemoteDaemon(directory, { python: config.python, wait: false }).catch(() => {});
    print(info);
    return;
  }
  if (command === 'stop') {
    ownerOnly();
    const { flags } = parseFlags(rest);
    const config = ensureInitialized(directory, false);
    try {
      print(await managementRequest(directory, config, { operation: 'shutdown', force: Boolean(flags.force) }));
    } catch (error) {
      if (error?.status) throw error;
      print({ stopped: true, alreadyStopped: true });
    }
    return;
  }
  if (command === 'restart') {
    ownerOnly();
    // Servisi durdurup aynı veri diziniyle yeni bir arka plan servisi başlatır.
    const { flags } = parseFlags(rest);
    const config = ensureInitialized(directory, false);
    const delayMs = flags.delay !== undefined ? Number(flags.delay) : 900;
    if (!Number.isFinite(delayMs) || delayMs < 0 || delayMs > 30_000) throw new PoolError('INVALID_REQUEST', '--delay 0 ile 30000 ms arasında olmalı.');
    await delay(delayMs);
    try {
      const res = await managementRequest(directory, config, { operation: 'shutdown', force: false });
      if (res.confirmRequired) {
        print({ restarted: false, reason: 'ACTIVE_TASKS', activeCount: res.activeCount });
        return;
      }
    } catch {
      // Servis zaten kapalı olabilir; yine de yeni örnek başlatılır.
    }
    let portReleased = false;
    for (let attempt = 0; attempt < 80; attempt++) {
      await delay(150);
      try {
        await managementRequest(directory, config, { operation: 'pair_ui' });
      } catch {
        portReleased = true;
        break; // Port boşaldı.
      }
    }
    if (!portReleased) throw new PoolError('SHUTDOWN_TIMEOUT', 'Eski servis belirlenen sürede kapanmadı.');
    spawnDetachedHidden([process.execPath, fileURLToPath(import.meta.url), 'serve'], {
      cwd: directory,
      env: { ...process.env, CLI_AGENT_POOL_HOME: directory },
      python: config.python,
    });
    // Also restart Remote daemon cleanly so remote/server.js & PWA stay on the same version (preserves paired devices & chats).
    let remoteRestarted = false;
    try {
      const stopRes = await stopRemoteDaemon(directory);
      if (stopRes && !stopRes.alreadyStopped) {
        for (let attempt = 0; attempt < 40; attempt++) {
          await delay(100);
          try {
            const check = await fetch('http://127.0.0.1:43128/manifest.webmanifest', { signal: AbortSignal.timeout(400) });
            if (!check.ok) break;
          } catch {
            break;
          }
        }
        await ensureRemoteDaemon(directory, { python: config.python });
        remoteRestarted = true;
      }
    } catch { /* Remote restart is best-effort */ }
    print({ restarted: true, remoteRestarted, endpoint: `http://127.0.0.1:${config.port}/mcp` });
    return;
  }
  const apiOrMcp = async (routePath, mcpTool, mcpArgs) => {
    try { return await apiRequest(directory, routePath); }
    catch (error) {
      if (error instanceof PoolError && error.code === 'NOT_FOUND' && mcpTool) {
        return withMcpClient(directory, client => callPoolTool(client, mcpTool, mcpArgs));
      }
      throw error;
    }
  };
  if (command === 'api') {
    print(await apiRequest(directory, '/api'));
    return;
  }
  if (command === 'status') {
    try {
      const [service, catalog, pools, quotas] = await Promise.all([
        apiRequest(directory, '/api/help'),
        apiRequest(directory, '/api/catalog'),
        apiRequest(directory, '/api/pools'),
        apiRequest(directory, '/api/quotas'),
      ]);
      print({ service, catalog, pools, quotas });
    } catch (error) {
      if (!(error instanceof PoolError) || error.code !== 'NOT_FOUND') throw error;
      print(await withMcpClient(directory, async client => ({
        service: await callPoolTool(client, 'pool_help'),
        catalog: await callPoolTool(client, 'pool_catalog'),
        pools: await callPoolTool(client, 'pool_list_pools'),
        quotas: await callPoolTool(client, 'pool_quota_overview'),
      })));
    }
    return;
  }
  if (command === 'quotas') {
    const { flags } = parseFlags(rest);
    const route = typeof flags.route === 'string' ? flags.route : '';
    const routePart = route ? `/${encodeURIComponent(route)}` : '';
    const livePart = flags.live ? '?live=1' : '';
    if (flags.live && !route) throw new PoolError('INVALID_REQUEST', '--live requires --route <routeId>.');
    print(await apiOrMcp(`/api/quotas${routePart}${livePart}`, flags.live ? 'pool_get_quotas' : 'pool_quota_overview', route ? { routeId: route } : {}));
    return;
  }
  if (command === 'model') {
    const { flags } = parseFlags(rest);
    const query = new URLSearchParams();
    if (typeof flags.route === 'string') query.set('route', flags.route);
    if (typeof flags.model === 'string') query.set('model', flags.model);
    print(await apiRequest(directory, `/api/model?${query.toString()}`));
    return;
  }
  if (command === 'rpc') {
    const request = await rpcRequest(process.stdin);
    print(await withMcpClient(directory, client => callPoolTool(client, request.tool, request.arguments)));
    return;
  }
  if (command === 'catalog' || command === 'pools' || command === 'help-code') {
    const { flags, positional } = parseFlags(rest);
    const codeArg = typeof flags.code === 'string' ? flags.code : (command === 'help-code' && positional[0] ? positional[0] : undefined);
    const query = new URLSearchParams();
    for (const [flag, key] of [['view', 'view'], ['billing', 'billing'], ['adapter', 'adapter'], ['kind', 'kind'], ['route', 'routeId'], ['query', 'query'], ['limit', 'limit'], ['offset', 'offset']]) {
      if (flags[flag] !== undefined && flags[flag] !== true) query.set(key, String(flags[flag]));
    }
    if (codeArg) query.set('code', codeArg);
    const base = command === 'pools'
      ? `/api/pools${typeof flags.group === 'string' ? `/${encodeURIComponent(flags.group)}` : ''}`
      : command === 'help-code' ? '/api/help' : '/api/catalog';
    const suffix = query.toString() ? `?${query.toString()}` : '';
    const mcpArgs = {
      ...(typeof flags.group === 'string' && command === 'pools' ? { group: flags.group } : {}),
      ...(codeArg ? { code: codeArg } : {}),
      ...(typeof flags.view === 'string' ? { view: flags.view } : {}),
      ...(typeof flags.billing === 'string' ? { billing: flags.billing } : {}),
      ...(typeof flags.adapter === 'string' ? { adapter: flags.adapter } : {}),
      ...(typeof flags.kind === 'string' ? { kind: flags.kind } : {}),
      ...(typeof flags.route === 'string' ? { routeId: flags.route } : {}),
      ...(typeof flags.query === 'string' ? { query: flags.query } : {}),
      ...(typeof flags.limit === 'string' ? { limit: Number(flags.limit) } : {}),
      ...(typeof flags.offset === 'string' ? { offset: Number(flags.offset) } : {}),
    };
    print(await apiOrMcp(`${base}${suffix}`, command === 'pools' ? 'pool_list_pools' : command === 'help-code' ? 'pool_help' : 'pool_catalog', mcpArgs));
    return;
  }
  if (command === 'select') {
    const { flags } = parseFlags(rest);
    const kind = flags.kind || (flags.mode === 'execute' ? 'write' : flags.mode === 'response' ? 'text' : 'read');
    const query = new URLSearchParams({ kind });
    for (const [flag, key] of [['mode', 'mode'], ['route', 'routeId'], ['model', 'modelId'], ['group', 'group'], ['effort', 'effort']]) {
      if (flags[flag] !== undefined && flags[flag] !== true) query.set(key, String(flags[flag]));
    }
    print(await apiOrMcp(`/api/select?${query.toString()}`, 'pool_select', {
      kind,
      ...(flags.mode ? { mode: flags.mode } : {}),
      ...(flags.route ? { routeId: flags.route } : {}),
      ...(flags.model ? { modelId: flags.model } : {}),
      ...(flags.group ? { group: flags.group } : {}),
      ...(flags.effort ? { effort: flags.effort } : {}),
    }));
    return;
  }
  if (command === 'run') {
    const { flags, positional } = parseFlags(rest);
    if (flags.wait === true) throw new PoolError('INVALID_REQUEST', '--wait sayısal saniye değeri ister.');
    if (flags.timeout === true) throw new PoolError('INVALID_REQUEST', '--timeout sayısal saniye değeri ister.');
    const prompt = (typeof flags.prompt === 'string' ? flags.prompt : '') || positional.join(' ');
    if (!prompt) throw new PoolError('PROMPT_REQUIRED', 'Görev metnini --prompt "..." ile belirtin.');
    const out = await runTaskFromCli(directory, {
      prompt,
      workspace: typeof flags.workspace === 'string' ? flags.workspace : process.cwd(),
      kind: (typeof flags.kind === 'string' ? flags.kind : '') || (flags.mode === 'execute' ? 'write' : flags.mode === 'response' ? 'text' : 'read'),
      routeId: typeof flags.route === 'string' ? flags.route : undefined,
      mode: typeof flags.mode === 'string' ? flags.mode : undefined,
      waitSeconds: flags.wait,
      modelId: typeof flags.model === 'string' ? flags.model : undefined,
      group: typeof flags.group === 'string' ? flags.group : undefined,
      effort: typeof flags.effort === 'string' ? flags.effort : undefined,
      timeoutSeconds: flags.timeout,
      idempotencyKey: typeof flags.key === 'string' ? flags.key : undefined,
      detach: Boolean(flags.detach),
    });
    print(out);
    return;
  }
  if (command === 'init') { ownerOnly(); initialize(directory); print({ configuration: path.join(directory, 'config.json'), tokenFile: path.join(directory, 'access-token'), next: 'Configure routes; secrets stay outside the repository.' }); return; }
  if (command === 'discover') { print(discover()); return; }
  if (command === 'scan-import') {
    ownerOnly();
    initialize(directory);
    const view = configView(directory);
    const imported = importDiscoveredRoutes(view.config, directory);
    const catalogErrors = [];
    for (const route of imported.config.routes.filter(route => !route.api && ['claude','agy'].includes(route.adapter))) {
      try { imported.addedModels += mergeCatalogModels(route, await routeCatalog(route, directory, imported.config.python, directory), imported.config.modelFilters); }
      catch { catalogErrors.push(route.id); }
    }
    saveConfig(directory, imported.config, view.revision);
    print({ catalogErrors, discoveredCLIs: imported.discoveredCount, addedRoutes: imported.addedRoutes, addedModels: imported.addedModels, refreshedModels: imported.refreshedModels, totalRoutes: imported.config.routes.length });
    return;
  }
  if (command === 'stdio') { await stdioBridge(directory); return; }
  const config = ensureInitialized(directory, false);
  if (command === 'validate') {
    for (const route of config.routes) commandArgv(route);
    const python = await capture([config.python, '--version'], directory, config.python);
    if (python.code !== 0 || !/Python 3\.(?:1[1-9]|[2-9]\d)/.test(python.output + python.stderr)) throw new PoolError('PYTHON_REQUIRED', 'Python 3.11 veya üstünü kurun.');
    print({ valid: true, connections: config.routes.length, enabled: config.routes.filter(r => r.enabled).length }); return;
  }
  if (command === 'models' || command === 'refresh-models') {
    if (command === 'refresh-models') ownerOnly();
    const route = config.routes.find(r => r.id === rest[0]);
    const cwd = directory;
    if (!route) throw new PoolError('NOT_FOUND', 'Bağlantı kimliği bulunamadı.');
    let catalog;
    if (route.adapter === 'codex' && !route.api) {
      try { catalog = await codexControl(route, cwd, config.python, 'models', directory); }
      catch { catalog = await routeCatalog(route, cwd, config.python, directory); }
    } else {
      catalog = await routeCatalog(route, cwd, config.python, directory);
    }
    if (command === 'refresh-models') {
      const view = configView(directory);
      const stored = view.config.routes.find(r => r.id === route.id);
      mergeCatalogModels(stored, catalog, view.config.modelFilters);
      saveConfig(directory, view.config, view.revision);
      print({ updated: stored.id, models: stored.models.length, manualGroups: 'preserved', restart: 'Restart pool service if already running.' });
    } else print(catalog);
    return;
  }
  if (command === 'preflight') {
    ownerOnly();
    const { values } = multiFlags(rest);
    const input = { routeId: values.route?.[0], workspace: path.resolve(values.workspace?.[0] || process.cwd()),
      ...(values.model ? { modelId: values.model[0] } : {}), ...(values.effort ? { effort: values.effort[0] } : {}), ...(values['read-path'] ? { readPaths: values['read-path'].map(item => path.resolve(item)) } : {}),
      ...(values.capability ? { capabilities: values.capability } : {}), ...(values.force ? { force: true } : {}) };
    if (!input.routeId) throw new PoolError('INVALID_REQUEST', '--route is required.');
    const config = ensureInitialized(directory, false);
    await ensureDaemon(directory, config);
    const started = await managementRequest(directory, config, { operation: 'preflight', input }, { timeoutMs: 30_000 });
    if (started.cached || values.detach) { print(started); return; }
    const status = await withMcpClient(directory, async (client, cfg) => {
      await waitTaskWithReconnect(directory, client, cfg, started.taskId, { waitSeconds: 0, sleep: delay });
      const { force, ...query } = input; void force;
      return withMcpClient(directory, freshClient => callPoolTool(freshClient, 'pool_preflight_status', query));
    });
    print({ taskId: started.taskId, ...status });
    if (!status.ready) process.exitCode = 2;
    return;
  }
  if (command === 'resolve') {
    ownerOnly();
    if (!rest[0]) throw new PoolError('TASK_REQUIRED', 'Elle incelenen görev kimliğini belirtin.');
    const config = ensureInitialized(directory, false);
    await ensureDaemon(directory, config);
    const { flags } = parseFlags(rest.slice(1));
    const task = await managementRequest(directory, config, { operation: 'resolve', taskId: rest[0], reviewed: true, note: flags.note || 'Operator inspected the stopped task and workspace before invoking CLI resolve.' });
    print({ resolved: task.id });
    return;
  }
  if (command !== 'serve') throw new PoolError('UNKNOWN_COMMAND', 'Bilinmeyen komut. help komutunu çalıştırın.');
  ownerOnly();
  const token = readFileSync(path.join(directory, 'access-token'), 'utf8').trim();
  const store = new Store(path.join(directory, 'pool.sqlite'));
  const pool = new Pool(config, store, { directory });
  const pidFile = path.join(directory, 'daemon.pid');
  let ownsPidFile = false;
  let stopping = false;
  async function stop() {
    if (stopping) return;
    stopping = true;
    if (ownsPidFile) {
      try {
        if (readFileSync(pidFile, 'utf8').trim() === String(process.pid)) rmSync(pidFile, { force: true });
      } catch { /* ignore */ }
    }
    app.server.close();
    app.server.closeAllConnections();
    await pool.close();
    store.close();
  }
  const app = createServer(pool, token, config.port, {
    directory,
    token: readFileSync(path.join(directory, 'management-token'), 'utf8').trim(),
    onShutdown: () => stop(),
    onUpdate: () => installDesktopAndSkills(directory),
  });
  try {
    const address = await app.listen();
    writeFileSync(pidFile, String(process.pid), 'utf8');
    ownsPidFile = true;
    print({ status: 'listening', endpoint: `http://127.0.0.1:${address.port}/mcp`, dashboard: app.uiURL(), authentication: 'Bearer token from private access-token file; dashboard uses a separate HttpOnly browser session' });
    void ensureRemoteDaemon(directory, { python: config.python, wait: false }).catch(() => {});
    // Refresh the owner's native Antigravity permissions in account profiles; failures only affect that route.
    for (const route of config.routes.filter(route => route.runtime === 'wsl')) void prepareWslProfile(route, config.python, directory).catch(() => {});
    for (const route of config.routes.filter(route => route.adapter === 'agy' && route.profile && route.runtime !== 'wsl')) {
      try { prepareNativeAgyProfile(route, directory); } catch { /* ignore */ }
    }
    process.once('SIGINT', () => { void stop(); });
    process.once('SIGTERM', () => { void stop(); });
  } catch (error) { await stop(); throw error; }
}

function isEntrypoint(entry) {
  if (!entry) return false;
  const resolved = path.resolve(entry);
  if (import.meta.url === pathToFileURL(resolved).href) return true;
  try { return import.meta.url === pathToFileURL(realpathSync(resolved)).href; }
  catch { return false; }
}

if (isEntrypoint(process.argv[1])) {
  main().catch(error => {
    const report = process.argv[2] === 'rpc' ? console.log : console.error;
    report(JSON.stringify({ error: { code: error instanceof PoolError ? error.code : 'START_FAILED', message: error instanceof PoolError ? error.message : 'Havuz başlatılamadı. Servis zaten çalışıyor olabilir; yerel ayarları kontrol edin.' } }));
    process.exitCode = 1;
  });
}
