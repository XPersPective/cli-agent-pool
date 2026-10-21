import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { zaiWindows, zaiKeys, kimiWindows, minimaxWindows, antigravityModelWindows, antigravityGroupWindows, openrouterNote, claudeWindows } from '../src/quotas.js';
import { classifyFailure, buildArguments, execute, zcodeEnvironment, localModelsFor } from '../src/adapters.js';
import { quotaWindows } from '../web/pool-state.js';

const py = process.platform === 'win32' ? 'python' : 'python3';

test('Z.AI monitor limits become 5h and weekly windows; MCP allowance is ignored', () => {
  const windows = zaiWindows({ data: { level: 'lite', limits: [
    { type: 'TOKENS_LIMIT', unit: 3, number: 5, percentage: 1 },
    { type: 'TOKENS_LIMIT', unit: 6, number: 1, percentage: 3, nextResetTime: 1792660000000 },
    { type: 'TIME_LIMIT', unit: 5, number: 1, percentage: 90 },
    { type: 'TOKENS_LIMIT', unit: 3, number: 5, percentage: 'bad' },
  ] } });
  assert.deepEqual(windows.map(w => [w.windowMinutes, w.remainingPercent]), [[300, 99], [10080, 97]]);
  assert.match(windows[1].resetsAt, /^2026-/);
});

test('the key ZCode CLI really uses wins over the legacy desktop entry', async t => {
  const home = mkdtempSync(path.join(tmpdir(), 'pool-zai-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  mkdirSync(path.join(home, '.zcode', 'v2'), { recursive: true });
  writeFileSync(path.join(home, '.zcode', 'v2', 'provider_config.json'), JSON.stringify({ config: { providerConfigRules: { providerRules: [{ providerId: 'zai-api', config: { access: { apiKey: 'cli-key' } } }] } } }));
  writeFileSync(path.join(home, '.zcode', 'v2', 'config.json'), JSON.stringify({ provider: { 'builtin:zai-coding-plan': { enabled: true, options: { baseURL: 'https://api.z.ai/api/anthropic', apiKey: 'legacy-key' } } } }));
  assert.deepEqual(zaiKeys(home), ['cli-key', 'legacy-key']);
});

test('Kimi, MiniMax and Claude usage payloads are validated', () => {
  assert.deepEqual(kimiWindows({ usages: { '5h': { used_ratio: 0.25 }, weekly: { used_ratio: 'x' } } }).map(w => [w.name, w.remainingPercent]), [['5h', 75]]);
  assert.deepEqual(kimiWindows({ usage: { limit: 200, remaining: 50 } }).map(w => w.remainingPercent), [25]);
  assert.deepEqual(kimiWindows({}), []);
  const mm = minimaxWindows({ model_remains: [{ model_name: 'MiniMax-M3', current_interval_remaining_percent: 40, current_weekly_status: 3, end_time: 1792660000000 }, { current_interval_total_count: 100, current_interval_usage_count: 80 }] });
  assert.deepEqual(mm.map(w => [w.name, w.remainingPercent, w.windowMinutes]), [['MiniMax-M3:5h', 40, 300], ['model_1:5h', 80, 300]]);
  assert.deepEqual(claudeWindows({ seven_day_opus: { utilization: 100 } })[0].models, ['opus']);
});

test('Antigravity per-model quota drops IDE internals and keeps the tightest effort', () => {
  const windows = antigravityModelWindows({ models: {
    'claude-opus-5-5-high': { quotaInfo: { remainingFraction: 0.5 } },
    'claude-opus-5-5-low': { quotaInfo: { remainingFraction: 0.4 } },
    tab_flash_lite_preview: { quotaInfo: { remainingFraction: 1 } },
    chat_123: { quotaInfo: { remainingFraction: 1 } },
  } });
  assert.deepEqual(windows.map(w => [w.name, w.remainingPercent]), [['claude-opus-5-5', 40]]);
  const groups = antigravityGroupWindows({ groups: [{ displayName: 'Claude and GPT models', buckets: [{ window: 'weekly', remainingFraction: 0.5 }] }] });
  assert.deepEqual(quotaWindows({ windows: groups }, 'claude-sonnet-5-5').map(w => w.remaining), [50]);
  assert.deepEqual(quotaWindows({ windows: groups }, 'gemini-4-argon'), []);
});

test('OpenRouter note reports balance and the documented free-model daily limit', () => {
  assert.equal(openrouterNote({ limit: null }, { total_credits: 0, total_usage: 0.11 }), 'OpenRouter bakiye: $-0.11 · ücretsiz modeller: günlük 50 istek');
  assert.match(openrouterNote({ limit: 5, limit_remaining: 4 }, { total_credits: 20, total_usage: 1 }), /\$19\.00 .*kalan: \$4\.00 .*1000 istek/);
});

test('vendor failures map to actionable codes', () => {
  assert.equal(classifyFailure('[1113][Insufficient balance or no resource package. Please recharge.]'), 'SUBSCRIPTION_REQUIRED');
  assert.equal(classifyFailure('MiMo free API service has ended. Sign in or configure a third-party API.'), 'CLI_FAILED');
  assert.equal(classifyFailure('Error: Select a model before sending a message'), 'MODEL_UNAVAILABLE');
  assert.equal(classifyFailure('insufficient balance (1008)'), 'QUOTA_EXHAUSTED');
});

test('ZCode headless runs use --json, its bundled provider catalog and its default model', async t => {
  const root = mkdtempSync(path.join(tmpdir(), 'pool-zcode-'));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  const glm = path.join(root, 'resources', 'glm'); mkdirSync(glm, { recursive: true });
  mkdirSync(path.join(root, 'resources', 'config', 'provider'), { recursive: true });
  writeFileSync(path.join(root, 'resources', 'config', 'provider', 'zcode-builtin.json'), '{}');
  const exe = path.join(glm, 'zcode.cjs');
  writeFileSync(exe, `const e=process.env;if(!e.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE)process.exit(3);console.log(JSON.stringify({sessionId:'s',response:'GLM:'+process.argv.at(-1)},null,2))`);
  assert.equal(zcodeEnvironment(exe, root).ZCODE_BUILTIN_PROVIDER_CONFIG_FILE, path.join(root, 'resources', 'config', 'provider', 'zcode-builtin.json'));
  const route = { id: 'z', adapter: 'zcode', executable: exe };
  const args = buildArguments(route, { id: 'zcode-default' }, { kind: 'read', workspace: root, prompt: 'hi' });
  assert.ok(args.includes('--json') && !args.includes('--output-format') && args.includes('plan'));
  assert.deepEqual(await execute(route, { id: 'zcode-default' }, { kind: 'text', workspace: root, prompt: 'hi', timeoutSeconds: 10 }, py, () => {}).done, { result: 'GLM:hi' });
  assert.deepEqual(localModelsFor('zcode').map(m => m.id), ['zcode-default']);
});

test('MiniMax Code exec events yield the agent message, failures stay failures', async t => {
  const root = mkdtempSync(path.join(tmpdir(), 'pool-mcode-'));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  const script = (name, events) => { const file = path.join(root, `${name}.js`); writeFileSync(file, `process.stdin.resume();process.stdin.on('end',()=>{for(const e of ${JSON.stringify(events)})console.log(JSON.stringify(e))})`); return file; };
  const run = file => execute({ id: 'm', adapter: 'mcode', executable: file }, { id: 'minimax/MiniMax-M3' }, { kind: 'text', workspace: root, prompt: 'x', timeoutSeconds: 10 }, py, () => {}).done;
  const ok = script('ok', [{ type: 'turn.started' }, { type: 'item.completed', item: { type: 'reasoning', content: 'think' } }, { type: 'item.completed', item: { type: 'agent_message', content: 'OK' } }, { type: 'exec.completed', result: { status: 'succeeded', output: 'OK' } }]);
  assert.deepEqual(await run(ok), { result: 'OK' });
  const bad = script('bad', [{ type: 'turn.failed', error: { message: 'insufficient balance' } }, { type: 'exec.completed', result: { status: 'failed' } }]);
  assert.equal((await run(bad)).error, 'QUOTA_EXHAUSTED');
});

test('only documented key-based usage endpoints are queried for user API routes', async () => {
  const { apiQuotaVendor, apiRouteQuota } = await import('../src/quotas.js');
  assert.equal(apiQuotaVendor('https://api.z.ai/api/anthropic'), 'zai');
  assert.equal(apiQuotaVendor('https://openrouter.ai/api/v1'), 'openrouter');
  assert.equal(apiQuotaVendor('https://api.minimax.io/anthropic'), 'minimax');
  assert.equal(apiQuotaVendor('https://api.deepseek.com/anthropic'), null);
  assert.equal(apiQuotaVendor('not a url'), null);
  assert.equal(await apiRouteQuota('https://api.deepseek.com/anthropic', 'k'), null);
});
