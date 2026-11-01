import test from 'node:test';
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import fs from 'node:fs';
import { EventEmitter } from 'node:events';
import { syncBuiltinESMExports } from 'node:module';
import path from 'node:path';
import { dataDirectory } from '../src/config.js';
import { openDashboardWindow } from '../src/daemon.js';

test('dashboard launch uses the native singleton and reports process failures', async t => {
  const calls = [];
  let fail = false;
  t.mock.method(childProcess, 'spawn', (file, args, options) => {
    calls.push({ file, args, options });
    const child = new EventEmitter();
    child.unref = () => {};
    queueMicrotask(() => fail ? child.emit('error', new Error('launch failed')) : child.emit(process.platform === 'win32' ? 'exit' : 'spawn', 0));
    return child;
  });
  t.mock.method(fs, 'existsSync', () => true);
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  const result = await openDashboardWindow('http://127.0.0.1:43127/');
  assert.equal(result.launchRequested, true);
  assert.equal(result.opened, undefined);
  if (process.platform === 'win32' && result.mode === 'app-window') {
    assert.equal(calls[0].args[0], dataDirectory());
    assert.equal(calls[0].args[1], '--url');
    assert.match(calls[0].file, /dashboard-[a-f0-9]+\.exe$/);
    assert.equal(calls[0].options.windowsHide, false);
  }
  fail = true;
  await assert.rejects(openDashboardWindow('http://127.0.0.1:43127/'), /launch failed/);
});

test('pool CLI entrypoint executes when invoked through a directory symlink or junction', t => {
  const tempRoot = fs.mkdtempSync(path.join(process.env.TEMP || '/tmp', 'pool-symlink-cli-'));
  t.after(() => fs.rmSync(tempRoot, { recursive: true, force: true }));
  const linkedRepo = path.join(tempRoot, 'linked-cli-agent-pool');
  fs.symlinkSync(path.resolve('.'), linkedRepo, process.platform === 'win32' ? 'junction' : 'dir');
  const linkedBin = path.join(linkedRepo, 'bin', 'pool.js');
  const result = childProcess.spawnSync(process.execPath, [linkedBin, 'mcp-config'], { encoding: 'utf8', windowsHide: true });
  assert.equal(result.status, 0, result.stderr);
  const parsed = JSON.parse(result.stdout);
  assert.ok(parsed?.mcpServers?.['cli-agent-pool']);
});

test('normal dashboard launch ensures the daemon before activating an existing window', () => {
  const source = fs.readFileSync(new URL('../src/dashboard.cs', import.meta.url), 'utf8');
  const ensure = source.indexOf('string url = args[1] == "--url" ? args[2] : EnsureUrl(directory, args[1], args[2]);');
  const existingWindow = source.indexOf('var windows = Windows(profile);');
  const activateExisting = source.indexOf('if (windows.Count > 0) { Activate(windows); return 0; }');

  assert.notEqual(ensure, -1, 'normal shortcut path should ensure the daemon; --url keeps the supplied URL');
  assert.ok(existingWindow > ensure, 'daemon ensure must run before looking for a window to activate');
  assert.ok(activateExisting > existingWindow, 'existing window activation must remain in place');
});
