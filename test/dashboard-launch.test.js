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
