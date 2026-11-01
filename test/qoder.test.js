import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { buildArguments, parseQoderModels, execute, checkAuth, quota, routeCatalog } from '../src/adapters.js';

test('Qoder native catalog preserves exact IDs and never guesses free billing or models from login errors', () => {
  assert.deepEqual(parseQoderModels('MODEL\r\nQwen3.8-Flash\r\nQwen3.8-Flash\r\n'), [{ id: 'Qwen3.8-Flash', name: 'Qwen3.8-Flash', efforts: [], free: false }]);
  assert.throws(() => parseQoderModels('Not logged in. Run qodercli login'), { code: 'AUTH_REQUIRED' });
  assert.throws(() => parseQoderModels('MODEL\n'), { code: 'DISCOVERY_FAILED' });
  assert.throws(() => parseQoderModels('MODEL\nUnexpected diagnostic message'), { code: 'DISCOVERY_FAILED' });
  const task = { workspace: tmpdir(), kind: 'write', mode: 'execute', prompt: 'test' };
  const route = { adapter: 'qoder', executable: process.execPath };
  const args = buildArguments(route, { id: 'Qwen3.8-Flash' }, task);
  assert.equal(args[args.indexOf('--permission-mode') + 1], 'accept_edits');
  assert.equal(args[args.indexOf('--max-model-request-retries') + 1], '0');
  assert.equal(args[args.indexOf('--tools') + 1], 'default');
  assert(args.includes('--strict-mcp-config'));
  assert(!args.includes('--dangerously-skip-permissions'));
  assert(!args.includes('bypass_permissions'));
  assert.equal(buildArguments(route, { id: 'x' }, { ...task, kind: 'read' })[args.indexOf('--tools') + 1], 'Read,Glob,Grep');
  assert.equal(buildArguments(route, { id: 'x' }, { ...task, kind: 'text' })[args.indexOf('--tools') + 1], '');
});

test('Qoder verifies native login without exposing account fields and retains native permission failures', async t => {
  const root = mkdtempSync(path.join(tmpdir(), 'pool-qoder-'));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  const executable = path.join(root, 'cli.cjs');
  const route = { adapter: 'qoder', executable, billing: 'free_credits', id: 'qoder' };
  writeFileSync(executable, `if(process.argv.includes('status'))console.log(JSON.stringify({logged_in:true,email:'private@example.invalid'}));else if(process.argv.includes('--list-models'))console.log('MODEL\\nQwen3.8-Flash');else{process.stdin.resume();process.stdin.on('end',()=>console.log(JSON.stringify({type:'result',result:'claimed success',permission_denials:[{tool_name:'Bash'}]})));}`);
  const python = process.platform === 'win32' ? 'python' : 'python3';
  await checkAuth(route, root, python, root);
  const status = await quota(route, root, python, root);
  assert.equal(status.auth, 'verified');
  assert.equal(status.status, 'unknown');
  assert(!JSON.stringify(status).includes('private@'));
  assert.equal((await routeCatalog(route, root, python)).models[0].id, 'Qwen3.8-Flash');
  const outcome = await execute(route, { id: 'Qwen3.8-Flash' }, { workspace: root, kind: 'write', mode: 'execute', prompt: 'test', timeoutSeconds: 5 }, python, () => {}, root).done;
  assert.equal(outcome.error, 'PERMISSION_REQUIRED');
  assert.match(outcome.detail, /Bash/);
  writeFileSync(executable, `console.log(JSON.stringify({logged_in:false}));`);
  await assert.rejects(checkAuth(route, root, python, root), { code: 'AUTH_REQUIRED' });
});
