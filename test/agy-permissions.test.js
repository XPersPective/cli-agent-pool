import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execute, buildArguments } from '../src/adapters.js';

test('Antigravity execute supplies native structured report schema without weakening native permissions', () => {
 const route={adapter:'agy',executable:process.execPath};
 const task={kind:'write',mode:'execute',workspace:tmpdir(),prompt:'fixture'};
 const args=buildArguments(route,{id:'flash'},task);
 const schema=JSON.parse(args[args.indexOf('--json-schema')+1]);
 assert.equal(schema.additionalProperties,false);assert(schema.required.includes('checks'));assert(schema.required.includes('blockers'));
 assert(!args.includes('--dangerously-skip-permissions'));assert(!args.includes('--settings'));assert(args.includes('accept-edits'));
 assert(!buildArguments(route,{id:'flash'},{...task,kind:'text',mode:'response'}).includes('--json-schema'));
});

test('Antigravity retains redacted native denial and blocked report even on SUCCESS', async t => {
  const root = mkdtempSync(path.join(tmpdir(), 'pool-agy-denial-'));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  const cli = path.join(root, 'agy.cjs');
  const report = JSON.stringify({ status: 'blocked', summary: 'Command denied', files: [], checks: [], research: [], blockers: ['git status denied'] });
  writeFileSync(cli, `process.stdin.resume();process.stdin.on('end',()=>{console.log(JSON.stringify({event:'step_update',step_update:{state:'ERROR',tool_info:{name:'run_command',error:{message:'permission check failed for git status: Matches user-configured deny rule.'}}}}));console.log(JSON.stringify({event:'result',result:{status:'SUCCESS',response:${JSON.stringify(report)},denied_actions:[{action:'command',display_name:'RunCommand'}]}}));});`);
  const outcome = await execute({ adapter: 'agy', executable: cli }, { id: 'flash' }, { kind: 'write', mode: 'execute', workspace: root, prompt: 'test', timeoutSeconds: 5 }, process.platform === 'win32' ? 'python' : 'python3', () => {}).done;
  assert.equal(outcome.error, 'PERMISSION_REQUIRED');
  assert.match(outcome.detail, /run_command.*git status.*deny rule/);
  assert.equal(outcome.result, report);
  assert(outcome.detail.length <= 600);
});

test('Antigravity denied_actions without an error event is a permission failure, not empty success', async t => {
  const root = mkdtempSync(path.join(tmpdir(), 'pool-agy-action-'));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  const cli = path.join(root, 'agy.cjs');
  writeFileSync(cli, `process.stdin.resume();process.stdin.on('end',()=>console.log(JSON.stringify({event:'result',result:{status:'SUCCESS',response:'',denied_actions:[{action:'read_file',display_name:'ReadFile'}]}})));`);
  const outcome = await execute({ adapter: 'agy', executable: cli }, { id: 'flash' }, { kind: 'write', mode: 'execute', workspace: root, prompt: 'test', timeoutSeconds: 5 }, process.platform === 'win32' ? 'python' : 'python3', () => {}).done;
  assert.equal(outcome.error, 'PERMISSION_REQUIRED');
  assert.match(outcome.detail, /ReadFile/);
});
