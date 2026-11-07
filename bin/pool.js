#!/usr/bin/env node
import { readFileSync, writeFileSync, rmSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { dataDirectory, initialize, loadConfig, configView, saveConfig, PoolError } from '../src/config.js';
import { discover, commandArgv, routeCatalog, importDiscoveredRoutes, mergeCatalogModels } from '../src/adapters.js';
import { capture } from '../src/process.js';
import { Store } from '../src/store.js';
import { Pool } from '../src/pool.js';
import { createServer } from '../src/server.js';
import { codexControl } from '../src/codex-control.js';
import { prepareWslProfile, prepareNativeAgyProfile } from '../src/accounts.js';
import { stdioBridge } from '../src/stdio.js';
import { rpcRequest } from '../src/rpc.js';
import { version } from '../src/version.js';
import { ensureInitialized, ensureDaemon, managementRequest, openDashboardWindow, withMcpClient, callPoolTool, runTaskFromCli, installDesktopAndSkills } from '../src/daemon.js';
import { waitForTask } from '../src/task-protocol.js';
import { setTimeout as delay } from 'node:timers/promises';

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

// Repeated flags (--read-path a --read-path b) collect into arrays.
function multiFlags(args) {
  const values = {};
  const positional = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (!arg.startsWith('--')) { positional.push(arg); continue; }
    const key = arg.slice(2);
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
      '  ensure                  Ensure background pool service is running',
      '  status                  Show active connections, models and policy (auto-starts service)',
      '  pools                   Categories; --group <id> reads one category model page',
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
    print(await installDesktopAndSkills(directory));
    return;
  }
  if (command === 'open' || command === 'ui' || command === 'dashboard') {
    const config = ensureInitialized(directory, false);
    const info = await ensureDaemon(directory, config);
    const windowInfo = await openDashboardWindow(info.dashboard);
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
      service: await callPoolTool(client, 'pool_help'),
      catalog: await callPoolTool(client, 'pool_catalog'),
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
  if (command === 'catalog' || command === 'pools' || command === 'help-code') {
    const { flags } = parseFlags(rest);
    print(await withMcpClient(directory, client => callPoolTool(client, command === 'pools' ? 'pool_list_pools' : command === 'help-code' ? 'pool_help' : 'pool_catalog', {
      ...(flags.group && command === 'pools' ? { group: flags.group } : {}),
      ...(flags.code ? { code: flags.code } : {}),
      ...(flags.view ? { view: flags.view } : {}),
      ...(flags.billing ? { billing: flags.billing } : {}),
      ...(flags.adapter ? { adapter: flags.adapter } : {}),
      ...(flags.kind ? { kind: flags.kind } : {}),
      ...(flags.route ? { routeId: flags.route } : {}),
      ...(flags.query ? { query: flags.query } : {}),
      ...(flags.limit ? { limit: Number(flags.limit) } : {}),
      ...(flags.offset ? { offset: Number(flags.offset) } : {}),
    })));
    return;
  }
  if (command === 'select') {
    const { flags } = parseFlags(rest);
    const out = await withMcpClient(directory, client => callPoolTool(client, 'pool_select', {
      kind: flags.kind || (flags.mode === 'execute' ? 'write' : flags.mode === 'response' ? 'text' : 'read'),
      ...(flags.mode ? { mode: flags.mode } : {}),
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
      kind: flags.kind || (flags.mode === 'execute' ? 'write' : flags.mode === 'response' ? 'text' : 'read'),
      routeId: flags.route,
      mode: flags.mode,
      waitSeconds: flags.wait,
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
  if (command === 'init') { initialize(directory); print({ configuration: path.join(directory, 'config.json'), tokenFile: path.join(directory, 'access-token'), next: 'Configure routes; secrets stay outside the repository.' }); return; }
  if (command === 'discover') { print(discover()); return; }
  if (command === 'scan-import') {
    initialize(directory);
    const view = configView(directory);
    const imported = importDiscoveredRoutes(view.config);
    const catalogErrors = [];
    for (const route of imported.config.routes.filter(route => !route.api && ['claude','agy'].includes(route.adapter))) {
      try { imported.addedModels += mergeCatalogModels(route, await routeCatalog(route, directory, imported.config.python), imported.config.modelFilters); }
      catch { catalogErrors.push(route.id); }
    }
    saveConfig(directory, imported.config, view.revision);
    print({ catalogErrors, discoveredCLIs: imported.discoveredCount, addedRoutes: imported.addedRoutes, addedModels: imported.addedModels, totalRoutes: imported.config.routes.length });
    return;
  }
  const config = ensureInitialized(directory, false);
  if (command === 'stdio') { await stdioBridge(directory, config); return; }
  if (command === 'validate') {
    for (const route of config.routes) commandArgv(route);
    const python = await capture([config.python, '--version'], directory, config.python);
    if (python.code !== 0 || !/Python 3\.(?:1[1-9]|[2-9]\d)/.test(python.output + python.stderr)) throw new PoolError('PYTHON_REQUIRED', 'Python 3.11 veya üstünü kurun.');
    print({ valid: true, connections: config.routes.length, enabled: config.routes.filter(r => r.enabled).length }); return;
  }
  if (command === 'models' || command === 'refresh-models') {
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
    const started = await managementRequest(directory, config, { operation: 'preflight', input });
    if (started.cached || values.detach) { print(started); return; }
    const status = await withMcpClient(directory, async client => {
      await waitForTask(id => callPoolTool(client, 'pool_get_task', { taskId: id, compact: true }), started.taskId, { waitSeconds: 1200, sleep: delay });
      const { force, ...query } = input; void force;
      return callPoolTool(client, 'pool_preflight_status', query);
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
