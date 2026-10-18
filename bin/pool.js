#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { dataDirectory, initialize, loadConfig, configView, saveConfig, PoolError } from '../src/config.js';
import { discover, executableArgv, routeCatalog, importDiscoveredRoutes } from '../src/adapters.js';
import { capture } from '../src/process.js';
import { Store } from '../src/store.js';
import { Pool } from '../src/pool.js';
import { createServer } from '../src/server.js';
import { codexControl } from '../src/codex-control.js';
import { stdioBridge } from '../src/stdio.js';

export async function main(args = process.argv.slice(2)) {
  const [command, ...rest] = args;
  const directory = dataDirectory();
  const print = value => console.log(JSON.stringify(value, null, 2));
  if (!command || command === 'help' || command === '--help') {
    console.log('CLI Agent Pool\n\n  init                    Create private local configuration\n  discover                Scan system for all installed AI CLIs and local model configs\n  scan-import             Import all discovered CLIs and models into local config\n  validate                Validate local configuration\n  models <route>          Discover models for a route without starting a task\n  refresh-models <route>  Update catalog for a route, preserving manual groups\n  serve                   Start independent dashboard and MCP\n  stdio                   Connect an MCP coding tool to the shared pool\n  resolve <task-id>       Release an interrupted workspace after manual inspection\n\nConfiguration: ' + path.join(directory, 'config.json'));
    return;
  }
  if (command === 'init') { initialize(directory); print({ configuration: path.join(directory, 'config.json'), tokenFile: path.join(directory, 'access-token'), next: 'Configure workspaceRoots and routes; secrets stay outside the repository.' }); return; }
  if (command === 'discover') { print(discover()); return; }
  if (command === 'scan-import') {
    const view = configView(directory);
    const imported = importDiscoveredRoutes(view.config);
    saveConfig(directory, imported.config, view.revision);
    print({ discoveredCLIs: imported.discoveredCount, addedRoutes: imported.addedRoutes, addedModels: imported.addedModels, totalRoutes: imported.config.routes.length });
    return;
  }
  const config = loadConfig(directory);
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
      const kinds = route.adapter === 'mmx' ? ['text'] : route.adapter === 'qwen' ? ['text', 'read'] : ['text', 'read', 'write'];
      for (const model of catalog.models) {
        const existing = stored.models.find(m => m.id === model.id);
        if (existing) { existing.efforts = model.efforts; if (!model.efforts.includes(existing.defaultEffort)) delete existing.defaultEffort; }
        else stored.models.push({ id: model.id, alias: model.name, group: model.free ? 'free' : 'unassigned', efforts: model.efforts, kinds });
      }
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
  let stopping = false;
  async function stop() {
    if (stopping) return;
    stopping = true;
    app.server.close();
    app.server.closeAllConnections();
    await pool.close();
    store.close();
  }
  try {
    const address = await app.listen();
    print({ status: 'listening', endpoint: `http://127.0.0.1:${address.port}/mcp`, dashboard: app.uiURL(), authentication: 'Bearer token from private access-token file; dashboard uses a separate HttpOnly browser session' });
    process.once('SIGINT', () => { void stop(); });
    process.once('SIGTERM', () => { void stop(); });
  } catch (error) { await stop(); throw error; }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch(error => {
    console.error(JSON.stringify({ error: { code: error instanceof PoolError ? error.code : 'START_FAILED', message: error instanceof PoolError ? error.message : 'Havuz başlatılamadı. Servis zaten çalışıyor olabilir; yerel ayarları kontrol edin.' } }));
    process.exitCode = 1;
  });
}
