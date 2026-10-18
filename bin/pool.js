#!/usr/bin/env node
import { readFileSync, writeFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { dataDirectory, initialize, loadConfig, configView, saveConfig, PoolError } from '../src/config.js';
import { discover, executableArgv, routeCatalog, importDiscoveredRoutes, mergeCatalogModels } from '../src/adapters.js';
import { capture } from '../src/process.js';
import { Store } from '../src/store.js';
import { Pool } from '../src/pool.js';
import { createServer } from '../src/server.js';
import { codexControl } from '../src/codex-control.js';
import { stdioBridge } from '../src/stdio.js';
import { rpcRequest } from '../src/rpc.js';
import { version } from '../src/version.js';
import { ensureInitialized, ensureDaemon, openDashboardWindow, withMcpClient, callPoolTool, runTaskFromCli, installDesktopAndSkills } from '../src/daemon.js';

function parseFlags(args) {
  const flags = {};
  const positional = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg.startsWith('--')) {
      const key = arg.slice(2);
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
      '  ensure                  Ensure background pool service is running',
      '  status                  Show active connections, models and policy (auto-starts service)',
      '  rpc                     Call one agent MCP tool using a JSON request on stdin (auto-starts service)',
      '  mcp-config              Print credential-free stdio configuration for editors and Freebuff',
      '  select                  Select best available model (--kind read|write|text --group <g>)',
      '  run                     Execute a bounded task (--kind read|write|text --workspace <dir> --prompt <text>)',
      '  init                    Create private local configuration',
      '  discover                Scan system for all installed AI CLIs and local model configs',
      '  scan-import             Import all discovered CLIs and models into local config',
      '  validate                Validate local configuration',
      '  models <route>          Discover models for a route without starting a task',
      '  refresh-models <route>  Update catalog for a route, preserving manual groups',
      '  serve                   Run background HTTP MCP and dashboard server in foreground',
      '  stdio                   Connect an MCP coding tool to the shared pool (auto-starts service)',
      '  resolve <task-id>       Release an interrupted workspace after manual inspection',
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
    print(await installDesktopAndSkills(directory));
    return;
  }
  if (command === 'open' || command === 'ui' || command === 'dashboard') {
    const config = ensureInitialized(directory, true);
    const info = await ensureDaemon(directory, config);
    const windowInfo = openDashboardWindow(info.dashboard);
    print({ ...info, ...windowInfo });
    return;
  }
  if (command === 'ensure' || command === 'start') {
    const config = ensureInitialized(directory, true);
    print(await ensureDaemon(directory, config));
    return;
  }
  if (command === 'status') {
    const out = await withMcpClient(directory, async client => ({
      connections: await callPoolTool(client, 'pool_list_connections'),
      models: await callPoolTool(client, 'pool_list_models'),
      policy: await callPoolTool(client, 'pool_get_policy'),
      pools: await callPoolTool(client, 'pool_list_pools'),
    }));
    print(out);
    return;
  }
  if (command === 'rpc') {
    const request = await rpcRequest(process.stdin);
    print(await withMcpClient(directory, client => callPoolTool(client, request.tool, request.arguments)));
    return;
  }
  if (command === 'select') {
    const { flags } = parseFlags(rest);
    const out = await withMcpClient(directory, client => callPoolTool(client, 'pool_select', {
      kind: flags.kind || 'read',
      ...(flags.route ? { routeId: flags.route } : {}),
      ...(flags.model ? { modelId: flags.model } : {}),
      ...(flags.group ? { group: flags.group } : {}),
      ...(flags.effort ? { effort: flags.effort } : {}),
    }));
    print(out);
    return;
  }
  if (command === 'run') {
    const { flags, positional } = parseFlags(rest);
    const prompt = flags.prompt || positional.join(' ');
    if (!prompt) throw new PoolError('PROMPT_REQUIRED', 'Görev metnini --prompt "..." ile belirtin.');
    const out = await runTaskFromCli(directory, {
      prompt,
      workspace: flags.workspace || process.cwd(),
      kind: flags.kind || 'read',
      routeId: flags.route,
      modelId: flags.model,
      group: flags.group,
      effort: flags.effort,
      timeoutSeconds: flags.timeout,
      idempotencyKey: flags.key,
      detach: Boolean(flags.detach),
    });
    print(out);
    return;
  }
  if (command === 'init') { initialize(directory); print({ configuration: path.join(directory, 'config.json'), tokenFile: path.join(directory, 'access-token'), next: 'Configure workspaceRoots and routes; secrets stay outside the repository.' }); return; }
  if (command === 'discover') { print(discover()); return; }
  if (command === 'scan-import') {
    initialize(directory);
    const view = configView(directory);
    const imported = importDiscoveredRoutes(view.config);
    saveConfig(directory, imported.config, view.revision);
    print({ discoveredCLIs: imported.discoveredCount, addedRoutes: imported.addedRoutes, addedModels: imported.addedModels, totalRoutes: imported.config.routes.length });
    return;
  }
  const config = ensureInitialized(directory, false);
  if (command === 'stdio') { await stdioBridge(directory, config); return; }
  if (command === 'validate') {
    for (const route of config.routes) executableArgv(route.executable);
    const python = await capture([config.python, '--version'], config.workspaceRoots[0] || directory, config.python);
    if (python.code !== 0 || !/Python 3\.(?:1[1-9]|[2-9]\d)/.test(python.output + python.stderr)) throw new PoolError('PYTHON_REQUIRED', 'Python 3.11 veya üstünü kurun.');
    print({ valid: true, connections: config.routes.length, enabled: config.routes.filter(r => r.enabled).length }); return;
  }
  if (command === 'models' || command === 'refresh-models') {
    const route = config.routes.find(r => r.id === rest[0]);
    const cwd = config.workspaceRoots[0] || directory;
    if (!route) throw new PoolError('NOT_FOUND', 'Bağlantı kimliği bulunamadı.');
    let catalog;
    if (route.adapter === 'codex' && !route.api) {
      try { catalog = await codexControl(route, cwd, config.python, 'models'); }
      catch { catalog = await routeCatalog(route, cwd, config.python); }
    } else {
      catalog = await routeCatalog(route, cwd, config.python);
    }
    if (command === 'refresh-models') {
      const view = configView(directory);
      const stored = view.config.routes.find(r => r.id === route.id);
      mergeCatalogModels(stored, catalog);
      saveConfig(directory, view.config, view.revision);
      print({ updated: stored.id, models: stored.models.length, manualGroups: 'preserved', restart: 'Restart pool service if already running.' });
    } else print(catalog);
    return;
  }
  if (command === 'resolve') {
    if (!rest[0]) throw new PoolError('TASK_REQUIRED', 'Elle incelenen görev kimliğini belirtin.');
    const store = new Store(path.join(directory, 'pool.sqlite'));
    try {
      const task = store.get(rest[0]);
      if (task?.state !== 'needs_review') throw new PoolError('INVALID_STATE', 'Yalnızca inceleme bekleyen görev çözümlenebilir.');
      store.update(task.id, 'failed', null, 'MANUALLY_RESOLVED');
      print({ resolved: task.id });
    } finally { store.close(); }
    return;
  }
  if (command !== 'serve') throw new PoolError('UNKNOWN_COMMAND', 'Bilinmeyen komut. help komutunu çalıştırın.');
  const token = readFileSync(path.join(directory, 'access-token'), 'utf8').trim();
  const store = new Store(path.join(directory, 'pool.sqlite'));
  const pool = new Pool(config, store, { directory });
  const app = createServer(pool, token, config.port, { directory, token: readFileSync(path.join(directory, 'management-token'), 'utf8').trim() });
  const pidFile = path.join(directory, 'daemon.pid');
  let stopping = false;
  async function stop() {
    if (stopping) return;
    stopping = true;
    try { rmSync(pidFile, { force: true }); } catch { /* ignore */ }
    app.server.close();
    app.server.closeAllConnections();
    await pool.close();
    store.close();
  }
  try {
    const address = await app.listen();
    writeFileSync(pidFile, String(process.pid), 'utf8');
    print({ status: 'listening', endpoint: `http://127.0.0.1:${address.port}/mcp`, dashboard: app.uiURL(), authentication: 'Bearer token from private access-token file; dashboard uses a separate HttpOnly browser session' });
    process.once('SIGINT', () => { void stop(); });
    process.once('SIGTERM', () => { void stop(); });
  } catch (error) { await stop(); throw error; }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch(error => {
    const report = process.argv[2] === 'rpc' ? console.log : console.error;
    report(JSON.stringify({ error: { code: error instanceof PoolError ? error.code : 'START_FAILED', message: error instanceof PoolError ? error.message : 'Havuz başlatılamadı. Servis zaten çalışıyor olabilir; yerel ayarları kontrol edin.' } }));
    process.exitCode = 1;
  });
}
