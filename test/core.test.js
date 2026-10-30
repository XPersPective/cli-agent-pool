import { rm } from 'node:fs/promises';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, symlinkSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { loadConfig, configSchema, allowedWorkspace, overlaps, redact, configView, saveConfig } from '../src/config.js';
import { writeFileSync } from 'node:fs';
import { existsSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { Store } from '../src/store.js';
import { Pool } from '../src/pool.js';
import { runProcess, childEnvironment } from '../src/process.js';
import { buildArguments, checkAuth, execute, quota, routeEnvironment, opencodeCatalog, importDiscoveredRoutes } from '../src/adapters.js';
import { saveSecret, hasSecret, loadSecret } from '../src/secrets-store.js';

function fixture(t, dependencies = {}) {
  const root = mkdtempSync(path.join(tmpdir(), 'pool-test-'));
  const config = configSchema.parse({ workspaceRoots: [root], routes: [{ id: 'test', adapter: 'codex', executable: process.execPath, enabled: true, billing: 'subscription', models: [{ id: 'test-model', alias: 'Test', group: 'manual', efforts: ['low'], kinds: ['read', 'write', 'text'] }] }] });
  const store = new Store(path.join(root, 'pool.sqlite'));
  const pool = new Pool(config, store, { checkAuth: async () => {}, execute: () => ({ cancel() {}, done: Promise.resolve({ result: 'ok' }) }), ...dependencies });
  t.after(async () => { await pool.close(); store.close(); await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });
  const request = { prompt: 'test', workspace: root, kind: 'read', idempotencyKey: 'test-key-123' };
  return { root, config, store, pool, request };
}

async function terminal(pool, id) {
  for (let i = 0; i < 200; i++) { const task = pool.get(id); if (!['queued', 'starting', 'running', 'cancelling'].includes(task.state)) return task; await delay(10); }
  throw new Error('Task did not settle');
}

test('canonical workspace containment rejects siblings, traversal and symlink escape', t => {
  const { root } = fixture(t);
  const outside = mkdtempSync(path.join(tmpdir(), 'pool-outside-'));
  t.after(() => rm(outside, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  const child = path.join(root, 'child'); mkdirSync(child);
  assert.equal(allowedWorkspace(child, [root]), child);
  assert.equal(allowedWorkspace(outside), outside);
  assert.throws(() => allowedWorkspace('relative'), { code: 'INVALID_WORKSPACE' });
  assert.throws(() => allowedWorkspace(path.join(root, 'missing')), { code: 'INVALID_WORKSPACE' });
  const file = path.join(root, 'file'); writeFileSync(file, 'test');
  assert.throws(() => allowedWorkspace(file), { code: 'INVALID_WORKSPACE' });
  assert.throws(() => allowedWorkspace(outside, [root]), { code: 'WORKSPACE_DENIED' });
  assert.throws(() => allowedWorkspace(path.dirname(root), [root]), { code: 'WORKSPACE_DENIED' });
  symlinkSync(outside, path.join(root, 'escape'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => allowedWorkspace(path.join(root, 'escape'), [root]), { code: 'WORKSPACE_DENIED' });
  assert.equal(allowedWorkspace(path.join(root, 'escape')), outside);
  assert.ok(overlaps(root, child)); assert.ok(!overlaps(root, outside));
});

test('lost response and concurrent same-key submissions create one durable task', async t => {
  const { pool, request, root, store } = fixture(t);
  const submissions = await Promise.all(Array.from({ length: 20 }, () => Promise.resolve().then(() => pool.submit(request))));
  assert.equal(new Set(submissions.map(task => task.id)).size, 1);
  const id = submissions[0].id;
  assert.equal((await terminal(pool, id)).result, 'ok');
  assert.equal(pool.submit(request).id, id);
  assert.throws(() => pool.submit({ ...request, prompt: 'different' }), { code: 'IDEMPOTENCY_CONFLICT' });
  assert.equal(store.list().length, 1);
  assert.throws(() => new Store(path.join(root, 'pool.sqlite')), /POOL_ALREADY_RUNNING/);
});

test('manual group, explicit route and effort are hard filters', t => {
  const { pool, request } = fixture(t);
  assert.equal(pool.select({ kind: 'read', group: 'manual', effort: 'low' }).selected.id, 'test-model');
  assert.throws(() => pool.submit({ ...request, effort: 'invented' }), { code: 'NO_ROUTE' });
  assert.throws(() => pool.select({ kind: 'read', routeId: 'unknown' }), { code: 'NO_ROUTE' });
  pool.config.routes[0].enabled = false;
  assert.throws(() => pool.submit(request), { code: 'NO_ROUTE' });
});

test('overlapping workspace stays reserved until cancellation cleanup finishes', async t => {
  let release;
  let cancelled = false;
  let starts = 0;
  const { pool, request } = fixture(t, { execute: () => { starts++; return { cancel: () => { cancelled = true; }, done: new Promise(resolve => { const timer = setTimeout(() => resolve({ error: 'TEST_TIMEOUT' }), 5000); release = value => { clearTimeout(timer); resolve(value); }; }) }; } });
  pool.config.concurrency = 2; pool.config.routes[0].maxConcurrent = 2;
  const first = pool.submit(request);
  const second = pool.submit({ ...request, idempotencyKey: 'second-key-123' });
  await delay(30);
  assert.equal(starts, 1);
  pool.cancel(first.id);
  assert.ok(cancelled); assert.equal(pool.get(second.id).state, 'queued');
  release({ error: 'CANCELLED' });
  assert.equal((await terminal(pool, first.id)).state, 'cancelled');
  await delay(30); assert.equal(starts, 2);
  pool.cancel(second.id); release({ error: 'CANCELLED' });
});

test('serial and parallel admission follows the configured task limit for separate workspaces', async t => {
  for (const [mode, limit] of [['serial', 1], ['parallel', 20]]) {
    const pending = [];
    let starts = 0;
    const { root, pool, request } = fixture(t, { execute: () => {
      starts++;
      return { cancel() {}, done: new Promise(resolve => pending.push(resolve)) };
    } });
    pool.config.concurrency = limit;
    pool.config.routes[0].maxConcurrent = limit;
    const workspaces = Array.from({ length: 20 }, (_, index) => path.join(root, `workspace-${index}`));
    workspaces.forEach(workspace => mkdirSync(workspace));
    const tasks = workspaces.map((workspace, index) => pool.submit({ ...request, workspace, idempotencyKey: `workspace-task-${index}-123` }));
    await delay(40);
    assert.equal(starts, limit, `${mode} should admit ${limit} distinct-workspace tasks`);
    if (mode === 'serial') {
      for (let index = 0; index < tasks.length; index++) {
        pending.shift()({ result: 'done' });
        await terminal(pool, tasks[index].id);
        if (index + 1 < tasks.length) {
          await delay(40);
          assert.equal(starts, index + 2, 'serial mode should admit the next task after the previous one settles');
        }
      }
    } else {
      for (const resolve of pending) resolve({ result: 'done' });
      await Promise.all(tasks.map(task => terminal(pool, task.id)));
    }
  }
});

test('concurrency and route concurrency reject values above the supported cap', () => {
  assert.throws(() => configSchema.parse({ concurrency: 33, routes: [] }));
  assert.throws(() => configSchema.parse({ routes: [{ id: 'test', adapter: 'codex', executable: process.execPath, maxConcurrent: 33, models: [] }] }));
  assert.equal(configSchema.parse({ routes: [] }).concurrency, 20);
  assert.equal(configSchema.parse({ routes: [{ id: 'test', adapter: 'codex', executable: process.execPath, models: [] }] }).routes[0].maxConcurrent, 20);
});

test('write failure quarantines the workspace and never retries', async t => {
  let starts = 0;
  const { pool, request } = fixture(t, { execute: () => { starts++; return { cancel() {}, done: Promise.resolve({ error: 'CLI_FAILED' }) }; } });
  const first = pool.submit({ ...request, kind: 'write' });
  assert.equal((await terminal(pool, first.id)).state, 'needs_review');
  const second = pool.submit({ ...request, idempotencyKey: 'second-key-123' });
  await delay(30);
  assert.equal(pool.get(second.id).state, 'queued'); assert.equal(starts, 1);
});

test('restart preserves completed results and quarantines interrupted tasks', t => {
  const root = mkdtempSync(path.join(tmpdir(), 'pool-restart-'));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  const filename = path.join(root, 'pool.sqlite');
  let store = new Store(filename);
  store.insert({ id: '1', key: 'key1', fingerprint: 'fp', workspace: root, request: {} });
  store.insert({ id: '2', key: 'key2', fingerprint: 'fp', workspace: root, request: {} });
  store.update('1', 'succeeded', 'saved'); store.update('2', 'running'); store.close();
  store = new Store(filename);
  try { assert.equal(store.get('1').result, 'saved'); assert.equal(store.get('2').state, 'needs_review'); }
  finally { store.close(); }
});

test('storage failure prevents a successful admission', t => {
  const { pool, request, store } = fixture(t);
  store.insert = () => { throw new Error('disk full'); };
  assert.throws(() => pool.submit(request), /disk full/);
  assert.equal(pool.list().length, 0);
});

test('known account quota gates model selection and expires without fabricated percentages', t => {
  const { pool, store } = fixture(t);
  store.saveQuota('test', { status: 'rate_limited', windows: [{ remainingPercent: 0 }], observedAt: new Date().toISOString() });
  assert.throws(() => pool.select({ kind: 'read' }), { code: 'NO_ROUTE' });
  store.saveQuota('test', { status: 'rate_limited', windows: [], observedAt: new Date(Date.now() - 61_000).toISOString() });
  assert.equal(pool.select({ kind: 'read' }).selected.routeId, 'test');
  pool.config.routes[0].minRemainingPercent = 20;
  store.saveQuota('test', { status: 'available', windows: [{ remainingPercent: 15 }], observedAt: new Date().toISOString() });
  assert.throws(() => pool.select({ kind: 'read' }), { code: 'NO_ROUTE' });
});

test('atomic configuration updates preserve manual groups and reject stale or invalid saves', t => {
  const { root, config } = fixture(t);
  const filename = path.join(root, 'config.json');
  writeFileSync(filename, JSON.stringify(config));
  const first = configView(root);
  const edited = structuredClone(first.config); edited.routes[0].models[0].group = 'my-group';
  saveConfig(root, edited, first.revision);
  assert.equal(configView(root).config.routes[0].models[0].group, 'my-group');
  assert.throws(() => saveConfig(root, first.config, first.revision), { code: 'CONFIG_CONFLICT' });
  const before = readFileSync(filename, 'utf8');
  assert.throws(() => saveConfig(root, { ...edited, apiKey: 'not-allowed' }, configView(root).revision));
  assert.equal(readFileSync(filename, 'utf8'), before);
});

test('no inherited API secrets and shell-free Codex/Claude arguments', t => {
  const previous = process.env.POOL_TEST_API_KEY; process.env.POOL_TEST_API_KEY = 'hidden';
  try { assert.equal(childEnvironment().POOL_TEST_API_KEY, undefined); }
  finally { if (previous === undefined) delete process.env.POOL_TEST_API_KEY; else process.env.POOL_TEST_API_KEY = previous; }
  const { config, request } = fixture(t);
  const argv = buildArguments(config.routes[0], config.routes[0].models[0], { ...request, effort: 'low' });
  assert.ok(argv.includes('--ignore-user-config')); assert.ok(argv.includes('read-only'));
  assert.equal(argv[argv.indexOf('-C')+1], request.workspace);
  if(process.platform === 'win32') assert.ok(argv.includes('windows.sandbox="elevated"'));
  const writeArgs=buildArguments(config.routes[0],config.routes[0].models[0],{...request,kind:'write'}); assert.ok(writeArgs.includes('workspace-write')); assert.ok(!writeArgs.includes('danger-full-access'));
  assert.ok(!argv.includes(request.prompt));
  assert.ok(!argv.some(a => a.includes('dangerously')));
  assert.equal(redact('Bearer ' + 'a'.repeat(30)), 'Bearer [REDACTED]');
});

const py = process.platform === 'win32' ? 'python' : 'python3';
test('auth checks enforce subscription vs token_plan vs free_credits and reject removed Gemini routes', async t => {
  const root = mkdtempSync(path.join(tmpdir(), 'pool-auth-'));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  const fake = (name, body) => { const file = path.join(root, `${name}.js`); writeFileSync(file, `const a=process.argv.slice(2).join(' ');${body}`); return file; };
  const claude = (authMethod, baseURL, billing = 'subscription') => ({ id: 'c', adapter: 'claude', billing, trustedSettings: true, executable: fake(`claude-${authMethod}-${Boolean(baseURL)}-${billing}`,
    `const fs=require('fs');if(a.startsWith('--setting-sources project,local '))fs.writeFileSync(__filename+'.scoped','1');if(a.replace('--setting-sources project,local ','')==='auth status --json')console.log(JSON.stringify({loggedIn:true,authMethod:${JSON.stringify(authMethod)},apiProvider:'firstParty'}));else if(a==='auth status --text')console.log(${JSON.stringify(baseURL ? `Auth token: ANTHROPIC_AUTH_TOKEN\nAnthropic base URL: ${baseURL}` : 'Login method: Claude Max account')});else process.exit(2)`) });
  await assert.rejects(checkAuth(claude('oauth_token', 'https://example.invalid/anthropic', 'subscription'), root, py), { code: 'AUTH_REQUIRED' });
  // A user-settings endpoint redirect is skipped by subscription runs, so it no longer blocks the claude.ai login.
  await checkAuth(claude('claude.ai', 'https://example.invalid/anthropic', 'subscription'), root, py);
  const subscriptionArgs = buildArguments(claude('claude.ai', null, 'subscription'), { id: 'claude-x' }, { kind: 'text', workspace: root });
  assert.deepEqual(subscriptionArgs.slice(subscriptionArgs.indexOf('--setting-sources'), subscriptionArgs.indexOf('--setting-sources') + 2), ['--setting-sources', 'project,local']);
  assert.ok(!buildArguments(claude('oauth_token', null, 'token_plan'), { id: 'x' }, { kind: 'text', workspace: root }).includes('--setting-sources'));
  const scopedRoute = claude('claude.ai', null, 'subscription');
  await checkAuth(scopedRoute, root, py);
  assert.ok(existsSync(scopedRoute.executable + '.scoped'), 'subscription auth must be inspected without user settings');
  // When explicitly declared as token_plan, Claude Code redirected to a Coding Plan endpoint is allowed.
  await checkAuth(claude('oauth_token', 'https://example.invalid/anthropic', 'token_plan'), root, py);
  const mmx = (name, body, billing = 'subscription') => ({ id: 'm', adapter: 'mmx', billing, trustedSettings: true, executable: fake(name, body) });
  const missing = mmx('mmx-none', `if(a.includes('auth status'))console.log(JSON.stringify({method:'oauth'}));else{process.stderr.write(JSON.stringify({error:{code:1,message:'API error: no active token plan subscription (HTTP 200)'}}));process.exit(1)}`);
  await assert.rejects(checkAuth(missing, root, py), { code: 'SUBSCRIPTION_REQUIRED' });
  assert.equal((await quota(missing, root, py)).subscription, 'none');
  // Daily / free credits on mmx work even when there is no active token plan subscription.
  await checkAuth({ ...missing, billing: 'free_credits' }, root, py);
  const drift = mmx('mmx-drift', `if(a.includes('auth status'))console.log(JSON.stringify({method:'oauth'}));else console.log('not json')`);
  assert.equal((await quota(drift, root, py)).subscription, 'unknown');
  await assert.rejects(checkAuth(drift, root, py), { code: 'SUBSCRIPTION_REQUIRED' });
  const active = mmx('mmx-active', `if(a.includes('auth status'))console.log(JSON.stringify({method:'oauth'}));else console.log(JSON.stringify({data:{plan:'active'}}))`);
  await checkAuth(active, root, py);
  assert.equal((await quota(active, root, py)).subscription, 'active');
  assert.throws(() => configSchema.parse({ workspaceRoots: [], routes: [{ id: 'g', adapter: 'gemini', executable: process.execPath, models: [] }] }));
});

test('OpenCode JSON events, free model catalog and custom API routes work with write-only secrets', async t => {
  const root = mkdtempSync(path.join(tmpdir(), 'pool-opencode-'));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  saveSecret(root, 'my-api', 'secret-token-value-123456');
  assert.equal(hasSecret(root, 'my-api'), true);
  assert.equal(loadSecret(root, 'my-api'), 'secret-token-value-123456');
  const script = path.join(root, 'opencode.js');
  writeFileSync(script, `const args=process.argv.slice(2);if(args[0]==='models'){console.log('opencode/beam-free\\n'+JSON.stringify({id:'beam-free',name:'Beam Free',cost:{input:0,output:0},variants:{low:{},high:{}}}));process.exit(0);}let p='';process.stdin.on('data',c=>p+=c).on('end',()=>{const cfg=JSON.parse(process.env.OPENCODE_CONFIG_CONTENT||'{}');console.log(JSON.stringify({type:'step_start'}));console.log(JSON.stringify({type:'text',part:{text:p+':'+Boolean(cfg.provider?.pool_custom_openai?.options?.apiKey)}}));console.log(JSON.stringify({type:'step_finish'}))});`);
  const freeRoute = { id: 'oc-free', adapter: 'opencode', billing: 'free', trustedSettings: true, executable: script, models: [{ id: 'opencode/beam-free', alias: 'Beam Free', group: 'free', efforts: ['low', 'high'], kinds: ['text', 'read', 'write'] }] };
  const cat = await opencodeCatalog(freeRoute, root, py);
  assert.equal(cat.models.length, 1);
  assert.equal(cat.models[0].free, true);
  const routerScript=path.join(root,'router.cjs');
  writeFileSync(routerScript, `for(const [id,cost] of [['openrouter/vendor/free:free',0],['openrouter/vendor/paid',1]])console.log(id+'\\n'+JSON.stringify({cost:{input:cost,output:cost}}));`);
  for(const billing of ['free','free_credits','token_plan','paid_api']) {
    const models=(await opencodeCatalog({...freeRoute,executable:routerScript,billing},root,py)).models;
    assert.deepEqual(models.map(model=>model.id),billing==='paid_api'?['openrouter/vendor/free:free','openrouter/vendor/paid']:['openrouter/vendor/free:free']);
  }

  const apiRoute = { id: 'custom-openai', adapter: 'opencode', billing: 'token_plan', trustedSettings: true, executable: script, api: { protocol: 'openai', baseUrl: 'https://example.invalid/v1', secretRef: 'my-api' }, models: [{ id: 'qwen-max', alias: 'Qwen Max', group: 'api', efforts: [], kinds: ['text', 'read', 'write'] }] };
  await checkAuth(apiRoute, root, py, root);
  const outcome = await execute(apiRoute, apiRoute.models[0], { prompt: 'hello', workspace: root, kind: 'read', timeoutSeconds: 10 }, py, () => {}, root).done;
  assert.deepEqual(outcome, { result: 'hello:true' });
  const anthropicRoute = { id: 'custom-anth', adapter: 'claude', billing: 'paid_api', trustedSettings: true, executable: script, api: { protocol: 'anthropic', baseUrl: 'https://example.invalid/anthropic', secretRef: 'my-api' }, models: [{ id: 'claude-sonnet', alias: 'Sonnet', group: 'api', efforts: [], kinds: ['text'] }] };
  const env = routeEnvironment(anthropicRoute, root, 'text');
  assert.equal(env.ANTHROPIC_BASE_URL, 'https://example.invalid/anthropic');
  assert.equal(env.ANTHROPIC_AUTH_TOKEN, 'secret-token-value-123456');
});

test('Qwen stream-json result envelope is parsed, errors fail and writes stay disabled', async t => {
  const root = mkdtempSync(path.join(tmpdir(), 'pool-qwen-'));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  const script = (name, events) => { const file = path.join(root, `${name}.js`); writeFileSync(file, `let p='';process.stdin.on('data',c=>p+=c).on('end',()=>{for(const e of ${events})console.log(JSON.stringify(e))})`); return file; };
  const run = executable => execute({ id: 'q', adapter: 'qwen', executable }, { id: 'qwen-model' }, { prompt: 'say ok', workspace: root, kind: 'read', timeoutSeconds: 10 }, py, () => {}).done;
  const ok = script('ok', `[{type:'system',subtype:'init'},{type:'assistant',message:{role:'assistant',content:[{type:'text',text:p}]}},{type:'result',subtype:'success',is_error:false,result:'echo:'+p}]`);
  assert.deepEqual(await run(ok), { result: 'echo:say ok' });
  const failed = script('failed', `[{type:'result',subtype:'error_during_execution',is_error:true,error:{message:'x'}}]`);
  assert.equal((await run(failed)).error, 'CLI_FAILED');
  assert.throws(() => buildArguments({ adapter: 'qwen', executable: ok }, { id: 'm' }, { kind: 'write' }), { code: 'WRITE_NOT_SUPPORTED' });
});

test('ZCode stream-json response, MiniMax Code, Custom CLI argsTemplate and importDiscoveredRoutes work', async t => {
  const root = mkdtempSync(path.join(tmpdir(), 'pool-multi-cli-'));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  const zcodeFile = path.join(root, 'zcode.cjs');
  writeFileSync(zcodeFile, `const args=process.argv.slice(2);const pIdx=args.indexOf('-p');const p=pIdx>=0?args[pIdx+1]:'';console.log(JSON.stringify({type:'result',response:'zcode:'+p+':'+args.includes('--disallowed-tools')}));`);
  const zRoute = { id: 'zcode-local', adapter: 'zcode', billing: 'token_plan', trustedSettings: true, executable: zcodeFile, models: [{ id: 'builtin:zai-coding-plan/GLM-5.3', alias: 'GLM-5.3', group: 'zai', efforts: ['low', 'high'], kinds: ['text', 'read', 'write'] }] };
  const zRead = await execute(zRoute, zRoute.models[0], { prompt: 'hello-glm', workspace: root, kind: 'read', timeoutSeconds: 10 }, py, () => {}, root).done;
  assert.deepEqual(zRead, { result: 'zcode:hello-glm:true' });
  const zWriteArgs = buildArguments(zRoute, zRoute.models[0], { prompt: 'edit', workspace: root, kind: 'write', effort: 'high' });
  assert.ok(zWriteArgs.includes('edit'));
  assert.ok(zWriteArgs.includes('Bash') && !zWriteArgs.includes('Bash,Edit,Write'));

  const customFile = path.join(root, 'my-cli.js');
  writeFileSync(customFile, `let s='';process.stdin.on('data',c=>s+=c).on('end',()=>console.log('custom:'+process.argv.slice(2).join('|')+':'+s));`);
  const customRoute = configSchema.parse({
    workspaceRoots: [root],
    routes: [{ id: 'custom-1', adapter: 'custom', executable: customFile, billing: 'subscription', argsTemplate: ['run', '-m', '{model}', '--cwd', '{workspace}'], promptStdin: true, models: [{ id: 'my-model', alias: 'My Model', group: 'custom', efforts: [], kinds: ['text', 'read'] }] }],
  }).routes[0];
  const customRes = await execute(customRoute, customRoute.models[0], { prompt: 'stdin-prompt', workspace: root, kind: 'read', timeoutSeconds: 10 }, py, () => {}, root).done;
  assert.deepEqual(customRes, { result: `custom:run|-m|my-model|--cwd|${root}:stdin-prompt` });
  assert.throws(() => configSchema.parse({ workspaceRoots: [root], routes: [{ id: 'bad-custom', adapter: 'custom', executable: customFile, models: [] }] }));

  const emptyConfig = configSchema.parse({ workspaceRoots: [root], routes: [] });
  const imported = importDiscoveredRoutes(emptyConfig);
  assert.ok(Array.isArray(imported.config.routes));
});

test('non-metered routes are preferred over paid_api and missing subscription plan only blocks subscription/token_plan', t => {
test('Antigravity streams large Unicode prompts on stdin without changing explicit prompt argument or permission settings', async t => {
  const root = mkdtempSync(path.join(tmpdir(), 'pool-agy-stdin-'));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  const prompt = `lead 🎤\n${'x'.repeat(40_000)}\nend 🧪`;
  const executable = path.join(root, 'agy.js');
  writeFileSync(executable, `let input='';process.stdin.on('data',c=>input+=c).on('end',()=>{const message=JSON.parse(input);const expected=${JSON.stringify(prompt)};const args=process.argv.slice(2);const ok=message.event==='user'&&message.message?.content===expected&&!args.some(arg=>arg.includes('lead 🎤'));console.log(JSON.stringify({event:'result',result:{status:ok?'SUCCESS':'ERROR',response:ok?'stdin-ok':'bad-input'}}))});`);
  const route = { id: 'agy-test', adapter: 'agy', billing: 'subscription', executable, models: [] };
  const model = { id: 'gemini-4-argon', defaultEffort: 'medium', variants: { medium: 'gemini-4-argon-medium' } };
  const task = { prompt, workspace: root, kind: 'text', effort: 'medium', timeoutSeconds: 10 };
  const argv = buildArguments(route, model, task);
  assert.ok(argv.includes('--input-format') && argv[argv.indexOf('--input-format') + 1] === 'stream-json');
  assert.ok(argv.includes('--output-format') && argv[argv.indexOf('--output-format') + 1] === 'stream-json');
  assert.ok(!argv.some(arg => arg.includes(prompt) || arg.startsWith('--print=')));
  assert.ok(argv.includes('--mode') && argv[argv.indexOf('--mode') + 1] === 'plan');
  assert.ok(argv.includes('--model') && argv[argv.indexOf('--model') + 1] === 'gemini-4-argon-medium');
  assert.ok(argv.includes('--effort') && argv[argv.indexOf('--effort') + 1] === 'medium');
  const streamed = await execute(route, model, task, py, () => {}, root).done;
  assert.deepEqual(streamed, { result: 'stdin-ok' });
  const legacy = buildArguments({ ...route, promptStdin: false }, model, task);
  assert.ok(legacy.some(arg => arg === `--print=${prompt}`));
  assert.ok(!legacy.includes('--input-format'));
});
  const root = mkdtempSync(path.join(tmpdir(), 'pool-select-'));
  const config = configSchema.parse({
    workspaceRoots: [root],
    routes: [
      { id: 'paid', adapter: 'claude', executable: process.execPath, enabled: true, billing: 'paid_api', autoSelect: false, priority: 1, api: { protocol: 'anthropic', baseUrl: 'https://example.invalid' }, models: [{ id: 'paid-m', alias: 'Paid', group: 'g', efforts: [], kinds: ['text', 'read'] }] },
      { id: 'free-oc', adapter: 'opencode', executable: process.execPath, enabled: true, billing: 'free', priority: 100, models: [{ id: 'free-m', alias: 'Free', group: 'g', efforts: [], kinds: ['text', 'read'] }] },
      { id: 'mmx-cred', adapter: 'mmx', executable: process.execPath, enabled: true, billing: 'free_credits', priority: 50, models: [{ id: 'mmx-m', alias: 'MMX', group: 'g', efforts: [], kinds: ['text'] }] },
    ],
  });
  const store = new Store(path.join(root, 'pool.sqlite'));
  const pool = new Pool(config, store, { directory: root });
  t.after(async () => { await pool.close(); store.close(); await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });
  // Even though paid has priority 1, it is excluded from automatic selection when autoSelect is false.
  assert.equal(pool.select({ kind: 'read' }).selected.id, 'free-m');
  // Explicit routeId allows selecting paid_api.
  assert.equal(pool.select({ kind: 'read', routeId: 'paid' }).selected.id, 'paid-m');
  // Even with autoSelect=true, non-metered routes win over paid_api.
  pool.config.routes[0].autoSelect = true;
  assert.equal(pool.select({ kind: 'read' }).selected.id, 'free-m');
  // Snapshot with subscription='none' does NOT block free_credits on mmx, but DOES block subscription/token_plan.
  store.saveQuota('mmx-cred', { connection: 'mmx-cred', status: 'available', subscription: 'none', windows: [], observedAt: new Date().toISOString() });
  assert.equal(pool.select({ kind: 'text', routeId: 'mmx-cred' }).selected.id, 'mmx-m');
  pool.config.routes[2].billing = 'token_plan';
  assert.throws(() => pool.select({ kind: 'text', routeId: 'mmx-cred' }), { code: 'NO_ROUTE' });
});

test('supervisor preserves Unicode and literal prompt data', async () => {
  const result = await runProcess({ argv: [process.execPath, '-e', 'process.stdin.pipe(process.stdout)'], cwd: process.cwd(), input: 'İstanbul $() & | " ` test', timeoutMs: 5000 }).done;
  assert.equal(result.code, 0); assert.equal(result.output, 'İstanbul $() & | " ` test');
});

test('timeout kills a grandchild process tree before reporting completion', async t => {
  const root = mkdtempSync(path.join(tmpdir(), 'pool-process-'));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  const pidFile = path.join(root, 'pid');
  const code = `const {spawn}=require('node:child_process'); const fs=require('node:fs'); const c=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'}); fs.writeFileSync(${JSON.stringify(pidFile)},String(c.pid));setInterval(()=>{},1000)`;
  const result = await runProcess({ argv: [process.execPath, '-e', code], cwd: root, timeoutMs: 1500 }).done;
  assert.equal(result.stopReason, 'TIMEOUT');
  const pid = Number(readFileSync(pidFile, 'utf8'));
  for (let i = 0; i < 100; i++) { try { process.kill(pid, 0); } catch { return; } await delay(20); }
  assert.fail('Grandchild survived cancellation');
});

test('a hard parent exit closes the supervisor control pipe and kills the owned CLI', async t => {
  const root = mkdtempSync(path.join(tmpdir(), 'pool-parent-exit-'));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  const pidFile = path.join(root, 'pid');
  const moduleURL = pathToFileURL(path.resolve('src/process.js')).href;
  const childCode = `require('node:fs').writeFileSync(${JSON.stringify(pidFile)},String(process.pid));setInterval(()=>{},1000)`;
  const parentCode = `import {runProcess} from ${JSON.stringify(moduleURL)};import{existsSync}from'node:fs';runProcess({argv:[process.execPath,'-e',${JSON.stringify(childCode)}],cwd:${JSON.stringify(root)},timeoutMs:10000});const timer=setInterval(()=>{if(existsSync(${JSON.stringify(pidFile)})){clearInterval(timer);process.exit(0)}},20)`;
  const parent = spawn(process.execPath, ['--input-type=module', '-e', parentCode], { stdio: 'ignore', windowsHide: true });
  t.after(() => { if (parent.exitCode === null) parent.kill(); });
  await new Promise((resolve, reject) => { parent.once('error', reject); parent.once('exit', code => code === 0 ? resolve() : reject(new Error('Parent failed'))); });
  assert.ok(existsSync(pidFile));
  const pid = Number(readFileSync(pidFile, 'utf8'));
  for (let i = 0; i < 100; i++) { try { process.kill(pid, 0); } catch { return; } await delay(20); }
  assert.fail('Owned CLI survived its parent');
});

test('obsolete workspace registrations do not block config loading or saving', t => {
  const { root, config } = fixture(t);
  config.workspaceRoots = [path.join(root, 'deleted-project')];
  writeFileSync(path.join(root, 'config.json'), JSON.stringify(config));
  assert.deepEqual(loadConfig(root).workspaceRoots, config.workspaceRoots);
  const view = configView(root);
  assert.doesNotThrow(() => saveConfig(root, view.config, view.revision));
  assert.deepEqual(configSchema.parse({ routes: [] }).workspaceRoots, []);
});

test('runtime locator is shared across launch contexts and explicit override wins',t=>{
 const {root}=fixture(t),canonical=path.join(root,'canonical'),locator=path.join(root,'.cli-agent-pool');mkdirSync(locator);writeFileSync(path.join(locator,'runtime-path'),canonical+'\n');
 const script='import {dataDirectory} from '+JSON.stringify(new URL('../src/config.js',import.meta.url).href)+';console.log(dataDirectory())';
 const env={...process.env,USERPROFILE:root,HOME:root,CLI_AGENT_POOL_HOME:''};
 const result=spawnSync(process.execPath,['--input-type=module','-e',script],{env,encoding:'utf8',windowsHide:true});assert.equal(result.status,0,result.stderr);assert.equal(result.stdout.trim(),canonical);
 const explicit=spawnSync(process.execPath,['--input-type=module','-e',script],{env:{...env,CLI_AGENT_POOL_HOME:root},encoding:'utf8',windowsHide:true});assert.equal(explicit.status,0,explicit.stderr);assert.equal(explicit.stdout.trim(),root);
});
