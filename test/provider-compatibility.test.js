import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { buildArguments, classifyFailure, execute, quota, checkAuth, qwenAuthStatus, qwenLiveAuth, assertZcodePlanSelection } from '../src/adapters.js';
import { redact } from '../src/config.js';
import { taskKinds } from '../web/capabilities.js';

const python = process.platform === 'win32' ? 'python' : 'python3';

test('ZCode native plan routes never silently spend a personal API provider or substitute Individual for Starter', () => {
  const route = { billing: 'token_plan' };
  assert.throws(() => assertZcodePlanSelection(route, { providerId: 'personal-api', modelId: 'model' }), { code: 'BILLING_UNCONFIRMED' });
  assert.throws(() => assertZcodePlanSelection(route, null), { code: 'BILLING_UNCONFIRMED' });
  assert.doesNotThrow(() => assertZcodePlanSelection(route, { providerId: 'account:zai-start-plan', modelId: 'GLM-5.3-Flash' }));
  assert.doesNotThrow(() => assertZcodePlanSelection(route, { providerId: 'account:zai-individual-coding-plan', modelId: 'GLM-5.3-Flash' }));
  assert.doesNotThrow(() => assertZcodePlanSelection({ billing: 'paid_api' }, { providerId: 'personal-api' }));
});

test('MiniMax workspace tasks enable standard native tools instead of the text-only lightweight session', () => {
  for (const kind of ['write', 'text']) {
    const args = buildArguments({ adapter: 'mcode', executable: process.execPath }, { id: 'minimax/MiniMax-M3.1-Flash' }, { kind, workspace: tmpdir() });
    assert.equal(args[args.indexOf('--mode') + 1], kind === 'text' ? 'lightweight' : 'standard');
    assert.equal(args[args.indexOf('--permission') + 1], kind === 'write' ? 'full' : 'smart');
  }
  const route = { adapter: 'mcode', executable: process.execPath };
  assert.throws(() => buildArguments(route, { id: 'model' }, { kind: 'read' }), { code: 'UNSUPPORTED_TASK_KIND' });
  assert.deepEqual(taskKinds(route, { kinds: ['text', 'read', 'write'] }), ['text', 'write']);
  assert.deepEqual(taskKinds({ ...route, toolPolicy: 'configured' }, { kinds: ['read'] }), []);
  const executeArgs = buildArguments(route, { id: 'model' }, { kind: 'write', mode: 'execute', workspace: tmpdir() });
  assert.ok(!executeArgs.includes('--output-schema'));
  const textArgs = buildArguments(route, { id: 'model' }, { kind: 'text', workspace: tmpdir() });
  assert.ok(!textArgs.includes('--output-schema'));
});

test('MiniMax native schema output preserves a structured report object and completion errors', async t => {
  const report = { status: 'completed', summary: 'fixture', files: [], checks: [], research: [], blockers: [] };
  const { root, executable } = fixture(t, `console.log(JSON.stringify({type:'exec.completed',result:{status:'succeeded',output:${JSON.stringify(report)}}}));`);
  const route = { adapter: 'mcode', executable };
  const task = { kind: 'write', mode: 'execute', workspace: root, prompt: 'fixture', timeoutSeconds: 5 };
  const result = await execute(route, { id: 'model' }, task, python, () => {}).done;
  assert.deepEqual(JSON.parse(result.result), report);
  writeFileSync(executable, `console.log(JSON.stringify({type:'exec.completed',result:{status:'failed',error:{message:'Quota exhausted'}}}));`);
  assert.equal((await execute(route, { id: 'model' }, task, python, () => {}).done).error, 'QUOTA_EXHAUSTED');
});
function fixture(t, source) {
  const root = mkdtempSync(path.join(tmpdir(), 'pool-provider-'));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  const executable = path.join(root, 'cli.cjs');
  writeFileSync(executable, source);
  return { root, executable };
}

test('ZCode rejects a pinned model it cannot select instead of running a different model', () => {
  const route = { adapter: 'zcode', executable: process.execPath };
  const task = { kind: 'text', prompt: 'fixture', workspace: tmpdir() };
  for (const id of ['GLM-5.3', 'GLM-5.3-Flash', 'longcat:free']) {
    assert.throws(() => buildArguments(route, { id }, task), { code: 'MODEL_UNAVAILABLE' });
  }
  assert.ok(buildArguments(route, { id: 'zcode-default' }, task).includes('--json'));
});

test('MiniMax accepts only a single valid trailing fenced report and never hides native failure', async t => {
  const report = { status: 'completed', summary: 'fixture', files: [], checks: [], research: [], blockers: [] };
  const valid = 'Created file.\n\n```json\n' + JSON.stringify(report) + '\n```';
  const { root, executable } = fixture(t, '');
  const run = async (answer, status = 'succeeded') => {
    writeFileSync(executable, `console.log(JSON.stringify({type:'exec.completed',result:{status:${JSON.stringify(status)},output:${JSON.stringify(answer)}}}));`);
    return execute({ adapter: 'mcode', executable }, { id: 'model' }, { kind: 'write', mode: 'execute', workspace: root, prompt: 'fixture', timeoutSeconds: 5 }, python, () => {}).done;
  };
  assert.deepEqual(JSON.parse((await run(valid)).result), report);
  for (const answer of [valid + '\nextra prose', valid + '\n' + valid, 'Created.\n```json\n{"status":"completed"}\n```', '```text\nnote\n```\n' + valid, valid.replace('```json', '````json'), valid.replace('Created file.\n\n', 'Created file. ')]) {
    assert.equal((await run(answer)).result, answer);
  }
  assert.ok((await run(valid, 'failed')).error);
  const blocked = { ...report, status: 'blocked', blockers: ['Denied'] };
  assert.equal(JSON.parse((await run('Note\n```json\n' + JSON.stringify(blocked) + '\n```')).result).status, 'blocked');
});

test('stdout-only MMX quota errors remain actionable and diagnostics redact cookies', async t => {
  const { root, executable } = fixture(t, `console.log(JSON.stringify({error:{message:'Insufficient balance',headers:{'set-cookie':'session="private-cookie"; HttpOnly'}}}));process.exitCode=1;`);
  const result = await execute({ adapter: 'mmx', executable }, { id: 'model' }, { kind: 'text', prompt: 'fixture', workspace: root, timeoutSeconds: 5 }, python, () => {}).done;
  assert.equal(result.error, 'QUOTA_EXHAUSTED');
  assert.match(result.detail, /Insufficient balance/);
  assert.doesNotMatch(result.detail, /private-cookie/);
  for (const input of ["'set-cookie': 'session=private-cookie; HttpOnly', status: 429", 'Set-Cookie: session=private-cookie; HttpOnly\r\nstatus: 429']) {
    assert.doesNotMatch(redact(input), /private-cookie/);
    assert.match(redact(input), /429/);
  }
  for (const header of ['Cookie', 'Set-Cookie']) {
    for (const value of ['session="private-cookie"', "session='private-cookie'"]) {
      assert.doesNotMatch(redact(JSON.stringify({ [header]: value })), /private-cookie/);
    }
  }
});

test('an error event cannot be cleared by a later successful result envelope', async t => {
  const { root, executable } = fixture(t, `for(const event of [{type:'result',is_error:true,result:'Fable 5.1 requires usage credits.'},{type:'result',result:'OK'}])console.log(JSON.stringify(event));`);
  const result = await execute({ adapter: 'claude', executable }, { id: 'fable' }, { kind: 'text', prompt: 'fixture', workspace: root, timeoutSeconds: 5 }, python, () => {}).done;
  assert.equal(result.error, 'CREDITS_REQUIRED');
  assert.equal(classifyFailure('Fable 5.1 requires usage credits.'), 'CREDITS_REQUIRED');
});

test('MMX requires Token Plan while MiniMax Code handles account credits', async t => {
  const { root, executable } = fixture(t, `if(process.argv.includes('auth'))console.log(JSON.stringify({method:'oauth'}));else{console.log(JSON.stringify({error:{message:'No active token plan'}}));process.exitCode=1;}`);
  const route = { adapter: 'mmx', executable, billing: 'token_plan', trustedSettings: true };
  const snapshot = await quota(route, root, python);
  assert.equal(snapshot.subscription, 'none');
  assert.equal(snapshot.status, 'unknown');
  assert.deepEqual(snapshot.windows, []);
  await assert.rejects(checkAuth(route, root, python), { code: 'SUBSCRIPTION_REQUIRED' });
});

test('Qwen reports configured International credentials without claiming a successful login', t => {
  const home = mkdtempSync(path.join(tmpdir(), 'pool-qwen-auth-'));
  t.after(() => rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  const settings = {
    security: { auth: { selectedType: 'openai' } },
    model: { name: 'qwen3.7-plus' },
    env: { QWENCLOUD_TOKEN_PLAN_API_KEY: 'do-not-return-this' },
    modelProviders: { openai: [
      { id: 'qwen3.8-max', baseUrl: 'https://token-plan.maas.qwencloudapi.com/compatible-mode/v1', envKey: 'QWENCLOUD_TOKEN_PLAN_API_KEY' },
      { id: 'qwen3.8-max', baseUrl: 'https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1', envKey: 'BAILIAN_TOKEN_PLAN_API_KEY' },
    ] },
  };
  mkdirSync(path.join(home, '.qwen'), { recursive: true });
  writeFileSync(path.join(home, '.qwen', 'settings.json'), JSON.stringify(settings));
  assert.deepEqual(qwenAuthStatus(home, {}, 'qwen3.8-max'), {
    status: 'unknown', auth: 'credentials_present',
    note: 'Qwen anahtarı yerel CLI ayarında bulundu; gerçek endpoint doğrulaması ve kota durumu ayrı gösterilir.',
  });
  settings.model = { name: 'qwen3.8-max', baseUrl: 'https://wrong.example/v1' };
  writeFileSync(path.join(home, '.qwen', 'settings.json'), JSON.stringify(settings));
  assert.equal(qwenAuthStatus(home, {}, 'qwen3.8-max').auth, 'credentials_present');
  assert.equal(qwenAuthStatus(home, {}, 'missing-model').status, 'auth_required');
  assert.equal(JSON.stringify(qwenAuthStatus(home, {}, 'qwen3.8-max')).includes('do-not-return-this'), false);
  const project = path.join(home, 'project');
  const nested = path.join(project, 'packages', 'app');
  mkdirSync(path.join(project, '.qwen'), { recursive: true });
  mkdirSync(nested, { recursive: true });
  writeFileSync(path.join(project, '.qwen', '.env'), 'QWENCLOUD_TOKEN_PLAN_API_KEY=project-key-value\n');
  assert.equal(qwenAuthStatus(home, {}, 'qwen3.8-max', nested).auth, 'credentials_present');
  settings.modelProviders.openai = [{ id: 'qwen3.7-plus', baseUrl: 'https://token-plan.maas.qwencloudapi.com/v1' }];
  settings.security.auth.apiKey = 'legacy-key-value';
  writeFileSync(path.join(home, '.qwen', 'settings.json'), JSON.stringify(settings));
  assert.equal(qwenAuthStatus(home, {}, 'qwen3.7-plus').auth, 'credentials_present');
  delete settings.security.auth.apiKey;
  settings.env.QWENCLOUD_TOKEN_PLAN_API_KEY = '   ';
  settings.modelProviders.openai = [{ id: 'qwen3.7-plus', baseUrl: 'https://token-plan.maas.qwencloudapi.com/v1', envKey: 'QWENCLOUD_TOKEN_PLAN_API_KEY' }];
  writeFileSync(path.join(home, '.qwen', 'settings.json'), JSON.stringify(settings));
  assert.equal(qwenAuthStatus(home, {}, 'qwen3.7-plus').status, 'auth_required');
});

test('Qwen live auth checks the selected provider endpoint and never returns the configured key', async t => {
  const home = mkdtempSync(path.join(tmpdir(), 'pool-qwen-live-auth-'));
  t.after(() => rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  mkdirSync(path.join(home, '.qwen'), { recursive: true });
  const settings = {
    security: { auth: { selectedType: 'openai' } },
    model: { name: 'qwen3.8-max', baseUrl: 'https://token-plan.maas.qwencloudapi.com/compatible-mode/v1' },
    env: { QWENCLOUD_TOKEN_PLAN_API_KEY: 'never-return-or-log-this' },
    modelProviders: { openai: [{ id: 'qwen3.8-max', baseUrl: 'https://token-plan.maas.qwencloudapi.com/compatible-mode/v1', envKey: 'QWENCLOUD_TOKEN_PLAN_API_KEY' }] },
  };
  writeFileSync(path.join(home, '.qwen', 'settings.json'), JSON.stringify(settings));
  let captured;
  const ok = await qwenLiveAuth(home, {}, 'qwen3.8-max', home, async (url, options) => { captured = { url, options }; return { status: 200 }; });
  assert.equal(ok.auth, 'verified');
  assert.equal(ok.status, 'unknown'); // a model-list response verifies the key, not remaining quota
  assert.equal(captured.url, 'https://token-plan.maas.qwencloudapi.com/compatible-mode/v1/models');
  assert.equal(captured.options.headers.Authorization, 'Bearer never-return-or-log-this');
  assert.equal(JSON.stringify(ok).includes('never-return-or-log-this'), false);
  const rejected = await qwenLiveAuth(home, {}, 'qwen3.8-max', home, async () => ({ status: 401 }));
  assert.equal(rejected.status, 'auth_required');
  assert.equal(rejected.auth, 'rejected');
  const offline = await qwenLiveAuth(home, {}, 'qwen3.8-max', home, async () => { throw new Error('network'); });
  assert.equal(offline.status, 'unknown');
  assert.equal(offline.auth, 'credentials_present');
  assert.doesNotMatch(JSON.stringify(offline), /never-return-or-log-this/);
  settings.modelProviders.openai[0].baseUrl = 'http://token-plan.maas.qwencloudapi.com/compatible-mode/v1';
  settings.model.baseUrl = 'http://token-plan.maas.qwencloudapi.com/compatible-mode/v1';
  writeFileSync(path.join(home, '.qwen', 'settings.json'), JSON.stringify(settings));
  let sent = false;
  const insecure = await qwenLiveAuth(home, {}, 'qwen3.8-max', home, async () => { sent = true; return { status: 200 }; });
  assert.equal(insecure.status, 'unknown'); assert.equal(insecure.auth, 'credentials_present'); assert.equal(sent, false);
});
