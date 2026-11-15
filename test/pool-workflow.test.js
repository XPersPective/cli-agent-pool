import { workspaceSkills, readWorkspaceSkill } from '../src/skills.js';
import { rm } from 'node:fs/promises';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { configSchema } from '../src/config.js';
import { Pool } from '../src/pool.js';
import { Store } from '../src/store.js';
import { claudeCatalog, routeCatalog, mergeCatalogModels, importDiscoveredRoutes, execute } from '../src/adapters.js';
import { claudeWindows, antigravityGroupWindows, agyUsageWindows } from '../src/quotas.js';
import { browserUI, openCliLogin } from '../src/web.js';
import { ensureInitialized } from '../src/daemon.js';
import { isCategoryId } from '../web/categories.js';
import { memberships, mergeScanDraft, addMembership, quotaWindows, quotaWindowPercent, modelIssueInfo, quotaMatches, effortLabel, modelFamily, modelIdentity, modelFiltered, isSettingsFiltered, setRouteModelSettingsFilter, unhideModels, sortModels, initialTaskGroup, restoredWorkspace, cleanRouteLabel, toolGroupsForRoutes, filterHierarchy } from '../web/pool-state.js';

test('adding to an explicit target pool preserves other memberships and validates effort before mutation', () => {
  const model = { group: 'high', defaultEffort: 'high', efforts: ['low', 'medium', 'high'] };
  addMembership(model, 'medium', 'medium');
  assert.deepEqual(model.memberships, [{ group: 'high', effort: 'high' }, { group: 'medium', effort: 'medium' }]);
  assert.equal(model.group, 'high');
  const before = structuredClone(model);
  assert.throws(() => addMembership(model, 'invalid category!', 'high'));
  assert.throws(() => addMembership(model, 'low', 'unsupported'));
  assert.deepEqual(model, before);
  addMembership(model, 'medium', '');
  assert.deepEqual(model.memberships, [{ group: 'high', effort: 'high' }, { group: 'medium' }]);
  addMembership(model, 'low', 'low');
  assert.equal(model.memberships.length, 3);
  assert.equal(addMembership(model, 'low', 'low'), false);
  assert.equal(addMembership(model, 'low', 'high'), true);
  assert.equal(model.memberships.length, 3);
});

test('readable quota values preserve model scope and Turkish effort labels preserve protocol values', () => {
  const snapshot = { windows: [{ name: 'shared', remainingPercent: 72 }, { name: 'opus', remainingPercent: 0, models: ['opus'] }, { name: 'unknown', remainingPercent: null }, { name: 'bad', remainingPercent: NaN }, { name: 'bounds', remainingPercent: 120 }] };
  const before = structuredClone(snapshot);
  const sonnet = quotaWindows(snapshot, 'claude-sonnet-5-5');
  assert.deepEqual(sonnet.map(window => [window.name, window.remaining, window.used]), [['shared', 72, 28], ['bounds', 100, 0]]);
  assert.equal(quotaWindows(snapshot, 'claude-opus-5-5')[1].remaining, 0);
  assert.equal(quotaWindows(null).length, 0);
  assert.deepEqual(snapshot, before);
  assert.equal(effortLabel('low'), 'Düşük'); assert.equal(effortLabel('high'), 'Yüksek');
  assert.equal(effortLabel(''), 'CLI varsayılanı'); assert.equal(effortLabel('provider-specific'), 'provider-specific');
});

test('quota filtering uses numeric model-scoped balances, including exhausted quotas', () => {
 const scoped={windows:[{models:['opus'],remainingPercent:0},{remainingPercent:null},{remainingPercent:NaN}]};
 assert.equal(quotaMatches(scoped,'claude-opus-5-5','known'),true);
 assert.equal(quotaMatches(scoped,'claude-opus-5-5','unknown'),false);
 assert.equal(quotaMatches(scoped,'claude-sonnet-5-5','known'),false);
 assert.equal(quotaMatches(scoped,'claude-sonnet-5-5','unknown'),true);
 assert.equal(quotaMatches(null,'luna','known'),false);
 assert.equal(quotaMatches(null,'luna','all'),true);
});

test('category defaults apply only within a category; catalog selection and supported effort remain caller choices', async t => {
  const root = mkdtempSync(path.join(tmpdir(), 'pool-members-'));
  const config = configSchema.parse({ selectionMode: 'manual', workspaceRoots: [root], routes: [{ id: 'codex', adapter: 'codex', executable: process.execPath, billing: 'subscription', enabled: true, models: [{ id: 'gpt-version', alias: 'GPT', group: 'unassigned', efforts: ['low', 'medium', 'high'], defaultEffort: 'high', kinds: ['text'], memberships: [{ group: 'high', effort: 'high' }, { group: 'medium', effort: 'medium' }, { group: 'low' }] }, { id: 'outside', alias: 'Outside', group: 'unassigned', efforts: [], kinds: ['text'], memberships: [] }] }] });
  const store = new Store(':memory:'); let used;
  const pool = new Pool(config, store, { directory: root, checkAuth: async () => {}, execute: (route, model, request, python, progress) => { used = request; progress('model:resolved-gpt-version'); return { cancel() {}, done: Promise.resolve({ result: 'ok' }) }; } });
  t.after(async () => { await pool.close(); store.close(); await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });
  assert.equal(pool.select({kind:'text',routeId:'codex',modelId:'outside'}).selected.id,'outside');
  assert.throws(() => pool.select({ kind: 'text', group: 'high', modelId: 'outside' }), { code: 'NO_ROUTE' });
  assert.equal(pool.select({kind:'text',group:'high',effort:'low'}).selected.id,'gpt-version');
  assert.equal(pool.select({ kind: 'text', group: 'medium' }).selected.defaultEffort, 'medium');
  store.saveQuota('codex', { status: 'available', observedAt: new Date().toISOString(), windows: [{ remainingPercent: 15 }] });
  assert.throws(() => pool.select({ kind: 'text', group: 'medium', minRemainingPercent: 25 }), { code: 'NO_ROUTE' });
  assert.equal(pool.select({ kind: 'text', group: 'medium', minRemainingPercent: 10 }).selected.id, 'gpt-version');
  config.routes[0].minRemainingPercent = 20;
  assert.throws(() => pool.select({ kind: 'text', group: 'medium', minRemainingPercent: 0 }), { code: 'NO_ROUTE' });
  config.routes[0].minRemainingPercent = 0;
  assert.equal(pool.select({ kind: 'text', group: 'low' }).selected.defaultEffort, undefined);
  const task = pool.submit({ kind: 'text', group: 'medium', prompt: 'test', workspace: root, idempotencyKey: 'member-task-123' });
  for (let i = 0; i < 40 && pool.get(task.id).state !== 'succeeded'; i++) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(used.effort, 'medium'); assert.equal(used.group, 'medium');
  assert.equal(pool.get(task.id).reportedModel, 'resolved-gpt-version');
  assert.equal(pool.get(task.id).effort, 'medium');
  assert.equal(pool.pools({group:'medium'}).models[0].effort, 'medium');
  pool.config.selectionMode = 'auto';
  assert.equal(pool.select({ kind: 'text', modelId: 'outside' }).selected.id, 'outside');
  const invalid = structuredClone(config); invalid.routes[0].models[0].memberships.push({ group: 'high' });
  assert.throws(() => configSchema.parse(invalid));
  invalid.routes[0].models[0].memberships = [{ group: 'high', effort: 'unsupported' }];
  assert.throws(() => configSchema.parse(invalid));
});

test('Qwen quota rejection is shown without blocking other provider accounts, then cleared by success', async t => {
  const root = mkdtempSync(path.join(tmpdir(), 'pool-qwen-quota-'));
  const config = configSchema.parse({ selectionMode: 'auto', workspaceRoots: [root], routes: [{
    id: 'qwen', adapter: 'qwen', executable: process.execPath, billing: 'token_plan', enabled: true,
    models: [{ id: 'qwen3.8-max', alias: 'Qwen Cloud', group: 'medium', kinds: ['text'] }],
  }] });
  const store = new Store(':memory:'); let nextError = 'QUOTA_EXHAUSTED';
  const pool = new Pool(config, store, {
    directory: root, checkAuth: async () => {},
    execute: () => ({ cancel() {}, done: Promise.resolve(nextError ? { error: nextError } : { result: 'OK' }) }),
  });
  t.after(async () => { await pool.close(); store.close(); await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });
  const first = pool.submit({ kind: 'text', group: 'medium', routeId: 'qwen', modelId: 'qwen3.8-max', prompt: 'test', workspace: root, idempotencyKey: 'qwen-quota-fail-01' });
  for (let i = 0; i < 40 && pool.get(first.id).state !== 'failed'; i++) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(pool.get(first.id).error, 'QUOTA_EXHAUSTED');
  const rejected = store.quota('qwen');
  assert.equal(rejected.status, 'unknown'); assert.equal(rejected.auth, 'credentials_present');
  assert.equal(rejected.source, 'cli-run-rejection'); assert.deepEqual(rejected.windows, []);
  assert.equal(pool.select({ kind: 'text', group: 'medium', routeId: 'qwen' }).selected.id, 'qwen3.8-max');
  nextError = null;
  const second = pool.submit({ kind: 'text', group: 'medium', routeId: 'qwen', modelId: 'qwen3.8-max', prompt: 'test', workspace: root, idempotencyKey: 'qwen-quota-ok-01' });
  for (let i = 0; i < 40 && pool.get(second.id).state !== 'succeeded'; i++) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(pool.get(second.id).state, 'succeeded');
  assert.equal(store.quota('qwen').source, 'cli-run-success');
  assert.equal(store.quota('qwen').status, 'unknown');
});

test('MiniMax Code account credits are not blocked by an absent Token Plan', async t => {
  const root = mkdtempSync(path.join(tmpdir(), 'pool-mcode-credits-'));
  const makePool = billing => {
    const config = configSchema.parse({ selectionMode: 'auto', workspaceRoots: [root], routes: [{
      id: 'mcode', adapter: 'mcode', executable: process.execPath, billing, enabled: true, trustedSettings: true,
      models: [{ id: 'minimax/MiniMax-M3.1-Flash', alias: 'M3.1 Flash', group: 'low', kinds: ['text', 'write'] }],
    }] });
    const store = new Store(':memory:');
    store.saveQuota('mcode', { status: 'unknown', subscription: 'none', windows: [], observedAt: new Date().toISOString() });
    const pool = new Pool(config, store, { directory: root, checkAuth: async () => {} });
    return { pool, store };
  };
  const credits = makePool('free_credits');
  t.after(async () => { await credits.pool.close(); credits.store.close(); await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });
  assert.equal(credits.pool.select({ kind: 'text', group: 'low', routeId: 'mcode' }).selected.billing, 'free_credits');
  const tokenPlan = makePool('token_plan');
  t.after(async () => { await tokenPlan.pool.close(); tokenPlan.store.close(); });
  assert.throws(() => tokenPlan.pool.select({ kind: 'text', group: 'low', routeId: 'mcode' }), { code: 'NO_ROUTE' });
});

test('OpenCode live free-model labels override a paid API route only for those models', async t => {
  const route = { id: 'opencode', adapter: 'opencode', billing: 'paid_api', autoSelect: false, models: [
    { id: 'opencode/old-free', alias: 'old', group: 'low', billing: 'free', enabled: true, efforts: [], kinds: ['text'] },
    { id: 'opencode/paid', alias: 'paid', group: 'low', enabled: true, efforts: [], kinds: ['text'] },
  ] };
  mergeCatalogModels(route, { models: [
    { id: 'opencode/old-free', name: 'Formerly free', free: false, efforts: [] },
    { id: 'opencode/new-free', name: 'Free model', free: true, efforts: [] },
  ] });
  assert.equal(route.models.find(model => model.id === 'opencode/old-free').billing, undefined);
  assert.equal(route.models.find(model => model.id === 'opencode/new-free').billing, 'free');
  const root = mkdtempSync(path.join(tmpdir(), 'pool-opencode-billing-'));
  const config = configSchema.parse({ selectionMode: 'auto', workspaceRoots: [root], routes: [{ ...route, executable: process.execPath, enabled: true }] });
  const store = new Store(':memory:');
  const pool = new Pool(config, store, { directory: root });
  t.after(async () => { await pool.close(); store.close(); await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });
  const available = pool.models();
  assert.equal(available.find(model => model.id === 'opencode/new-free').billing, 'free');
  assert.equal(available.find(model => model.id === 'opencode/new-free').autoSelect, false);
  assert.equal(available.find(model => model.id === 'opencode/paid').billing, 'paid_api');
  assert.equal(available.find(model => model.id === 'opencode/paid').autoSelect, false);
  assert.equal(pool.select({kind:'text'}).selected.id,'opencode/new-free');
  assert.equal(pool.select({ kind: 'text', routeId: 'opencode' }).selected.id, 'opencode/new-free');
  delete config.routes[0].autoSelect;
  assert.equal(pool.select({ kind: 'text' }).selected.id, 'opencode/new-free');

  const manualConfig = configSchema.parse({ selectionMode: 'manual', workspaceRoots: [root], routes: [{ ...route, executable: process.execPath, enabled: true }] });
  const manualStore = new Store(':memory:');
  const manualPool = new Pool(manualConfig, manualStore, { directory: root });
  t.after(async () => { await manualPool.close(); manualStore.close(); });
  assert.equal(manualPool.select({ kind: 'text', routeId: 'opencode', modelId:'opencode/new-free' }).selected.id, 'opencode/new-free');
  assert.throws(()=>manualPool.select({kind:'text',group:'free',routeId:'opencode'}),{code:'NO_ROUTE'});
  assert.throws(() => manualPool.select({ kind: 'text', group: 'free', routeId: 'opencode', modelId: 'opencode/paid' }), { code: 'NO_ROUTE' });
});

test('Claude control catalog imports resolved versions without a user prompt and preserves pool rules', async t => {
  const root = mkdtempSync(path.join(tmpdir(), 'claude-catalog-'));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  const executable = path.join(root, 'claude.mjs');
  writeFileSync(executable, `import{createInterface}from'node:readline';if(process.argv.includes('--input-format')){createInterface({input:process.stdin}).on('line',line=>{const message=JSON.parse(line);if(message.type!=='control_request')process.exit(9);console.log(JSON.stringify({type:'control_response',response:{request_id:message.request_id,response:{models:[{value:'default',resolvedModel:'claude-opus-9-1',supportedEffortLevels:['low','high']},{value:'opus',resolvedModel:'claude-opus-9-1',supportedEffortLevels:['low','high']}]}}}));});}else{process.stdin.resume();process.stdin.on('end',()=>{console.log(JSON.stringify({type:'system',model:'claude-opus-9-1'}));console.log(JSON.stringify({type:'result',result:'done'}));});}`);
  const route = { id: 'claude', adapter: 'claude', executable, billing: 'subscription', models: [{ id: 'opus', alias: 'Opus', group: 'high', efforts: ['low', 'high'], enabled: false, kinds: ['text'], memberships: [{ group: 'high', effort: 'high' }] }] };
  const catalog = await claudeCatalog(route, root, process.platform === 'win32' ? 'python' : 'python3');
  assert.equal(catalog.models.length, 1); assert.equal(catalog.models[0].id, 'claude-opus-9-1');
  assert.deepEqual(catalog.models[0].aliases, ['default', 'opus']);
  mergeCatalogModels(route, catalog);
  assert.equal(route.models.length, 1); assert.equal(route.models[0].id, 'claude-opus-9-1');
  assert.deepEqual(route.models[0].memberships, [{ group: 'high', effort: 'high' }]);
  assert.equal(route.models[0].enabled, false);
  const events = [];
  assert.deepEqual(await execute(route, route.models[0], { kind: 'text', prompt: 'test', workspace: root, timeoutSeconds: 5 }, process.platform === 'win32' ? 'python' : 'python3', event => events.push(event), root).done, { result: 'done' });
  assert.ok(events.includes('model:claude-opus-9-1'));
});

test('scan merges new versioned models without saving or discarding unrelated draft edits', () => {
  const before = { categories:[{id:'high',name:'High'}], workspaceRoots: ['original'], routes: [{ id: 'claude', enabled: false, models: [{ id: 'opus', alias: 'Opus', group: 'claude', efforts: ['high'], memberships: [] }] }] };
  const draft = structuredClone(before); draft.categories[0].name = 'Research'; draft.routes[0].enabled = true;
  draft.routes[0].models[0].memberships = [{ group: 'high', effort: 'high' }];
  draft.routes[0].models.push({ id: 'custom-v2', alias: 'Custom', group: 'low' });
  const scanned = structuredClone(before); scanned.routes[0].models[0].id = 'claude-opus-9-1'; scanned.routes[0].models[0].alias = 'claude-opus-9-1';
  scanned.routes[0].models.push({ id: 'claude-sonnet-9-1', group: 'unassigned', memberships: [] });
  scanned.routes.push({ id: 'qwen', models: [] });
  const result = mergeScanDraft(scanned, before, draft);
  assert.equal(result.categories[0].name,'Research'); assert.equal(result.routes[0].enabled, true);
  assert.deepEqual(result.routes[0].models[0].memberships, [{ group: 'high', effort: 'high' }]);
  assert.equal(result.routes[0].models[0].id, 'claude-opus-9-1');
  assert.equal(result.routes[0].models[0].alias, 'claude-opus-9-1');
  assert.equal(result.routes[0].models.length, 3); assert.equal(result.routes.length, 2);
  assert.equal(scanned.routes[0].enabled, false);
  assert.deepEqual(memberships({ group: 'medium', defaultEffort: 'high' }), [{ group: 'medium', effort: 'high' }]);
  assert.deepEqual(memberships({ group: 'medium', memberships: [] }), []);
});

test('quota percentages are validated and model-specific limits do not block sibling models', async t => {
  const windows = claudeWindows({ five_hour: { utilization: 20 }, seven_day: { utilization: 10 }, seven_day_opus: { utilization: 100 }, invalid: {} });
  assert.equal(windows[0].remainingPercent, 80); assert.equal(windows[1].remainingPercent, 90);
  assert.deepEqual(windows[2].models, ['opus']);
  assert.deepEqual(claudeWindows({ five_hour: { utilization: 'not numeric' } }), []);
  const root = mkdtempSync(path.join(tmpdir(), 'pool-quota-ui-'));
  const config = configSchema.parse({ routes: [{ id: 'claude', adapter: 'claude', executable: process.execPath, billing: 'subscription', enabled: true, models: ['opus', 'sonnet'].map(family => ({ id: `claude-${family}-9-1`, alias: family, group: 'high', kinds: ['text'], efforts: [] })) }], workspaceRoots: [root] });
  writeFileSync(path.join(root, 'config.json'), JSON.stringify(config));
  const store = new Store(':memory:'); const pool = new Pool(config, store, { directory: root });
  t.after(async () => { await pool.close(); store.close(); await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });
  store.saveQuota('claude', { status: 'available', windows, observedAt: new Date().toISOString() });
  assert.equal(pool.select({ kind: 'text', group: 'high' }).selected.id, 'claude-sonnet-9-1');
  config.routes[0].enabled = false;
  pool.getQuota = async () => store.quota('claude');
  const result = await browserUI(pool, { directory: root, token: 'a'.repeat(64) }).operation({ operation: 'quotas' });
  assert.equal(result.quotas.claude.windows[0].remainingPercent, 80);
});


test('local model catalogs preserve actual model keys and tags instead of a fabricated default', async t => {
  const root = mkdtempSync(path.join(tmpdir(), 'local-catalog-'));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  const executable = path.join(root, 'models.mjs');
  writeFileSync(executable, `if(process.argv.includes('--json'))console.log(JSON.stringify([{modelKey:'qwen3-8b-v2'}]));else console.log('NAME ID SIZE MODIFIED\\nqwen3:8b abc123 5GB today');`);
  const python = process.platform === 'win32' ? 'python' : 'python3';
  assert.equal((await routeCatalog({ id: 'local', adapter: 'lmstudio', executable }, root, python)).models[0].id, 'qwen3-8b-v2');
  const ollama = await routeCatalog({ id: 'local', adapter: 'ollama', executable }, root, python);
  assert.equal(ollama.models[0].id, 'qwen3:8b'); assert.equal(ollama.models[0].name, 'qwen3:8b · abc123');
});


test('agent auto-start preserves owner-disabled routes and never grants trust implicitly', t => {
  const root = mkdtempSync(path.join(tmpdir(), 'pool-owner-policy-'));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  const config = configSchema.parse({ workspaceRoots: [root], selectionMode: 'manual', routes: [{ id: 'owner-disabled', adapter: 'custom', executable: process.execPath, argsTemplate: ['--version'], billing: 'free', enabled: false, trustedSettings: false, models: [] }] });
  writeFileSync(path.join(root, 'config.json'), JSON.stringify(config));
  const loaded = ensureInitialized(root);
  assert.equal(loaded.selectionMode, undefined);
  assert.equal(loaded.routes.find(route => route.id === 'owner-disabled').enabled, false);
  assert.equal(loaded.routes.find(route => route.id === 'owner-disabled').trustedSettings, false);
});

test('owner model filters survive scans and prohibit automatic and explicit agent selection', async t => {
  const root=mkdtempSync(path.join(tmpdir(),'pool-filter-'));
  const make=(id,adapter,ids)=>({id,adapter,executable:process.execPath,billing:'subscription',enabled:true,models:ids.map(id=>({id,alias:id,group:'medium',kinds:['text'],efforts:[]}))});
  const config=configSchema.parse({workspaceRoots:[root],modelFilters:[{match:'model',value:'gpt-5.6-sol',routeId:'codex'},{match:'family',value:'terra'}],routes:[make('codex','codex',['gpt-5.6-sol','gpt-6.1-sol','gpt-5.6-terra']),make('other','agy',['gpt-5.6-sol'])]});
  const store=new Store(':memory:'),pool=new Pool(config,store);
  t.after(async()=>{await pool.close();store.close();await rm(root,{recursive:true,force:true,maxRetries:10,retryDelay:100});});
  assert.deepEqual(pool.models().map(m=>[m.routeId,m.id]),[['codex','gpt-6.1-sol'],['other','gpt-5.6-sol']]);
  assert.throws(()=>pool.select({kind:'text',routeId:'codex',modelId:'gpt-5.6-sol'}),{code:'NO_ROUTE'});
  assert.equal(pool.select({kind:'text',routeId:'other'}).selected.id,'gpt-5.6-sol');
  const route=config.routes[0];mergeCatalogModels(route,{models:[{id:'gpt-9-terra',efforts:[]},{id:'gpt-5.6-sol',efforts:[]},{id:'gpt-6-astra',efforts:[]}]},config.modelFilters);
  assert(!route.models.some(m=>m.id==='gpt-9-terra'));assert(route.models.some(m=>m.id==='gpt-6-astra'));
  config.modelFilters=[];assert(pool.models().some(m=>m.id==='gpt-5.6-terra'));
  assert.equal(modelFamily('anthropic/claude-opus-5-5-high'),'opus');
  assert.equal(modelIdentity('claude-opus-5.5'),'claude-opus-5-5');
  assert(modelFiltered([{match:'model',value:'claude-opus-5.5'}],'agy','claude-opus-5-5-high'));
  assert(!modelFiltered([{match:'model',value:'claude-opus-5-5-high',routeId:'agy'}],'agy','claude-opus-5-5-medium'));
  assert(!modelFiltered([{match:'family',value:'sol'}],'codex','gpt-6-astra'));
  const entries=['model-10','model-2','model-1'].map(id=>({route:{id:'route'},model:{id}}));
  assert.deepEqual(sortModels(entries).map(e=>e.model.id),['model-1','model-2','model-10']);
  assert.deepEqual(sortModels(entries,'za').map(e=>e.model.id),['model-10','model-2','model-1']);
  assert.equal(entries[0].model.id,'model-10');
  const draft=structuredClone(config),before=structuredClone(config);draft.modelFilters=[{match:'family',value:'sol'}];
  assert.deepEqual(mergeScanDraft(config,before,draft).modelFilters,draft.modelFilters);
  assert(!configSchema.safeParse({...config,modelFilters:[{match:'regex',value:'.*'}]}).success);
});

test('manual composer initially selects a populated pool while respecting later user choice',()=>{
 const models=[{enabled:false,group:'high'},{enabled:true,group:'medium'}];
 assert.equal(initialTaskGroup(models,'manual','high'),'medium');
 assert.equal(initialTaskGroup(models,'manual','high',true),'high');
 assert.equal(initialTaskGroup(models,'auto',''),'');
});

test('Antigravity discovers exact cross-vendor model IDs without inference or fabricated fallback',async t=>{
 const root=mkdtempSync(path.join(tmpdir(),'pool-agy-'));const file=path.join(root,'agy.cjs');
 writeFileSync(file,String.raw`if(process.argv[2]!=='models')process.exit(3);console.log('Fetching available models...\nclaude-opus-5-5-high\tClaude Opus 5.5 (High)\ngemini-4-argon-low\tGemini 4 Argon (Low)\ngpt-oss-120b-medium\tGPT OSS (Medium)');`);
 t.after(()=>rm(root,{recursive:true,force:true,maxRetries:10,retryDelay:100}));
 const route={id:'agy',adapter:'agy',executable:file,billing:'subscription',models:[{id:'gemini-2.5-pro',group:'antigravity',efforts:[]}]};
 const catalog=await routeCatalog(route,root,process.platform==='win32'?'python':'python3');
 const assigned={...route,models:[{id:'gemini-2.5-pro',group:'medium',efforts:[],enabled:true}]};mergeCatalogModels(assigned,catalog);assert.equal(assigned.models[0].enabled,false);assert.equal(assigned.models[0].group,'medium');
 assert.deepEqual(catalog.models.map(m=>m.id),['claude-opus-5-5','gemini-4-argon','gpt-oss-120b']);
 assert.deepEqual(catalog.models[0].variants,{high:'claude-opus-5-5-high'});
 assert.deepEqual(catalog.models[0].efforts,['high']);mergeCatalogModels(route,catalog);assert(!route.models.some(m=>m.id==='gemini-2.5-pro'));
 writeFileSync(file,"console.log('not a catalog')");await assert.rejects(routeCatalog(route,root,process.platform==='win32'?'python':'python3'),{code:'DISCOVERY_FAILED'});
});

test('owner login opens the native CLI using a fixed platform script and data-only arguments',async()=>{
 let launched;
 const run=async(file,args,options)=>{launched={file,args,options};return{stdout:'{"opened":true}'};};
 const route={adapter:'codex',executable:process.execPath};
 assert.equal((await openCliLogin(route,{platform:'win32',run})).opened,true);
 assert.deepEqual(JSON.parse(launched.options.env.CLI_AGENT_POOL_LOGIN_ARGV),{file:process.execPath,arguments:['login']});
 for(const [adapter,arguments_] of [
  ['mcode',['login','--region','global']],
  ['mmx',['auth','login','--recommend','--region=global']],
  ['kimi',['login','--region','global']],
  ['mimo',['providers','login']],
  ['qwen',[]],
 ]) {
  await openCliLogin({...route,adapter},{platform:'win32',run});
  assert.deepEqual(JSON.parse(launched.options.env.CLI_AGENT_POOL_LOGIN_ARGV),{file:process.execPath,arguments:arguments_});
 }
 assert(!launched.args.at(-1).includes(process.execPath));assert.equal(launched.options.env.OPENAI_API_KEY,undefined);assert(launched.args.includes('-NonInteractive'));
 await assert.rejects(openCliLogin({...route,api:{}},{platform:'win32',run}),{code:'LOGIN_UNAVAILABLE'});
 await assert.rejects(openCliLogin(route,{platform:'win32',run:async()=>{throw Error('failed')}}),{code:'LOGIN_FAILED'});
 assert.equal((await openCliLogin(route,{platform:'linux',run})).opened,false);
});

test('failed Codex quota control distinguishes missing login from an unknown quota',async t=>{
 const root=mkdtempSync(path.join(tmpdir(),'pool-auth-')),file=path.join(root,'codex.cjs');writeFileSync(file,'process.exit(1)');
 const config=configSchema.parse({workspaceRoots:[root],routes:[{id:'codex',adapter:'codex',executable:file,enabled:true,billing:'subscription',models:[{id:'gpt-test',alias:'GPT',group:'medium',kinds:['text']}]}]});
 const store=new Store(':memory:'),pool=new Pool(config,store,{directory:root});
 t.after(async()=>{await pool.close();store.close();await rm(root,{recursive:true,force:true,maxRetries:10,retryDelay:100});});
 assert.equal((await pool.getQuota('codex')).status,'auth_required');
 assert.throws(()=>pool.select({kind:'text',group:'medium'}),{code:'NO_ROUTE'});
 pool.checkAuth=async()=>{};assert.equal((await pool.getQuota('codex')).status,'auth_required');assert.equal((await pool.getQuota('codex',true)).status,'unknown');
 store.saveQuota('codex',{status:'rate_limited',observedAt:new Date().toISOString(),windows:[{remainingPercent:0}]});
 assert.equal((await pool.getQuota('codex',true)).status,'rate_limited');assert.throws(()=>pool.select({kind:'text',group:'medium'}),{code:'NO_ROUTE'});
});

test('Antigravity vendor quota groups never block or display unrelated model families',()=>{
 const windows=antigravityGroupWindows({groups:[{displayName:'Gemini',buckets:[{window:'5h',remainingFraction:0.96}]},{displayName:'Claude/GPT',buckets:[{window:'5h',remainingFraction:0},{window:'weekly',remainingFraction:0.5}]},{name:'Unknown',buckets:[{window:'5h',remainingFraction:null}]}]});
 assert.deepEqual(quotaWindows({windows},'gemini-4-argon-low').map(w=>w.remaining),[96]);
 assert.deepEqual(quotaWindows({windows},'claude-opus-5-5-high').map(w=>w.remaining),[0,50]);
 assert.deepEqual(quotaWindows({windows},'gpt-oss-120b-medium').map(w=>w.remaining),[0,50]);
 assert.equal(antigravityGroupWindows({groups:[{name:'Shared',buckets:[{window:'5h',remainingFraction:1.2}]}]})[0].remainingPercent,100);
});

test('model-scoped Antigravity exhaustion blocks only the depleted model family',async t=>{
 const root=mkdtempSync(path.join(tmpdir(),'pool-agy-scoped-'));
 const config=configSchema.parse({selectionMode:'manual',workspaceRoots:[root],routes:[{id:'agy-local',adapter:'agy',executable:process.execPath,enabled:true,billing:'subscription',models:[
  {id:'gemini-3.8-flash',alias:'Gemini Flash',group:'low',memberships:[{group:'low'}],efforts:[],kinds:['text']},
  {id:'claude-sonnet-5-5',alias:'Claude Sonnet',group:'medium',memberships:[{group:'medium'}],efforts:[],kinds:['text']},
 ]}]});
 const store=new Store(':memory:');
 store.saveQuota('agy-local',{status:'rate_limited',scope:'model',observedAt:new Date().toISOString(),windows:[
  {name:'Gemini',remainingPercent:89,models:['gemini-flash']},
  {name:'Claude and GPT',remainingPercent:0,models:['claude','gpt']},
 ]});
 const pool=new Pool(config,store);
 t.after(async()=>{await pool.close();store.close();await rm(root,{recursive:true,force:true,maxRetries:10,retryDelay:100});});
 assert.equal(pool.select({kind:'text',group:'low'}).selected.id,'gemini-3.8-flash');
 assert.throws(()=>pool.select({kind:'text',group:'medium'}),{code:'NO_ROUTE'});
});

test('project skill picker confines reads to authorized project and central skill files',async t=>{
 const root=mkdtempSync(path.join(tmpdir(),'pool-skills-')),project=path.join(root,'project'),library=path.join(root,'library');mkdirSync(project);mkdirSync(library);
 const dir=path.join(project,'.agents','skills','demo');mkdirSync(dir,{recursive:true});const file=path.join(dir,'SKILL.md');writeFileSync(file,'---\nname: demo\ndescription: A local project skill\n---\nUse the local test command.');
 const central=path.join(library,'shared');mkdirSync(central);writeFileSync(path.join(central,'SKILL.md'),'---\ndescription: >-\n  Shared instructions\n  across lines\n---\nNo network.');
 const huge=path.join(library,'oversized');mkdirSync(huge);writeFileSync(path.join(huge,'SKILL.md'),'x'.repeat(65537));
 t.after(()=>rm(root,{recursive:true,force:true,maxRetries:10,retryDelay:100}));
 const skills=workspaceSkills(project,[project],library);assert.equal(skills.length,2);assert.equal(skills.find(s=>s.name==='demo').source,'Proje');assert.equal(readWorkspaceSkill(project,[project],file,library).text.includes('local test command'),true);
 assert.throws(()=>readWorkspaceSkill(project,[project],path.join(root,'secret.md'),library),{code:'INVALID_SKILL'});
 assert.equal(workspaceSkills(root,[],library).length,1);
 assert.equal(workspaceSkills('',[project],library).length,1);assert.equal(workspaceSkills('',[project],library)[0].description,'Shared instructions across lines');
 assert.equal(restoredWorkspace(project,[project]),project);assert.equal(restoredWorkspace(root,[project]),root);assert.equal(restoredWorkspace(null,[project]),'');
});

test('Argon grouping, multi-dimensional sortModels, issue highlights, UI-only __all__ guard, and selective unhideModels work consistently', () => {
  assert.equal(modelFamily('gemini-4-argon'), 'argon');
  assert.equal(modelFamily('gemini-4-argon-low'), 'argon');
  assert.equal(isCategoryId('all'), false);
  assert.equal(isCategoryId('__all__'), false);
  assert.equal(isCategoryId('high'), true);

  const authSnapshot = { status: 'auth_required', windows: [] };
  const unsubSnapshot = { status: 'available', subscription: 'none', windows: [{ name: '5h', remainingPercent: 80 }] };
  const exhaustedSnapshot = { status: 'rate_limited', windows: [{ name: '5h', remainingPercent: 0 }] };
  const unknownSnapshot = { status: 'available', windows: [] };
  const healthySnapshot = { status: 'available', windows: [{ name: 'five_hour', remainingPercent: 75 }, { name: 'weekly', remainingPercent: 40 }] };

  const subRoute = { id: 'sub-a', adapter: 'agy', billing: 'subscription', enabled: true };
  const zaiRoute = { id: 'zai-b', adapter: 'zcode', billing: 'token_plan', enabled: true };
  const disRoute = { id: 'dis-c', adapter: 'codex', billing: 'subscription', enabled: false };

  assert.equal(modelIssueInfo(subRoute, { id: 'm1', enabled: true }, authSnapshot).isError, true);
  assert.equal(modelIssueInfo(subRoute, { id: 'm1', enabled: true }, unsubSnapshot).state, 'subscription_error');
  assert.equal(modelIssueInfo(subRoute, { id: 'm1', enabled: true }, exhaustedSnapshot).state, 'quota_exhausted');
  assert.equal(modelIssueInfo(subRoute, { id: 'm1', enabled: true }, unknownSnapshot).isUnknown, true);
  assert.equal(modelIssueInfo(disRoute, { id: 'm1', enabled: true }, healthySnapshot).isDisabled, true);
  assert.equal(modelIssueInfo(subRoute, { id: 'm1', enabled: true }, healthySnapshot).level, 'ok');

  assert.equal(quotaWindowPercent(healthySnapshot, 'm1', 'min'), 40);
  assert.equal(quotaWindowPercent(healthySnapshot, 'm1', '5h'), 75);
  assert.equal(quotaWindowPercent(healthySnapshot, 'm1', 'weekly'), 40);
  assert.equal(quotaMatches(healthySnapshot, 'm1', '5h_high', subRoute), true);
  assert.equal(quotaMatches(healthySnapshot, 'm1', 'weekly_high', subRoute), false);
  assert.equal(quotaMatches(healthySnapshot, 'm1', 'healthy', subRoute), true);
  assert.equal(quotaMatches(authSnapshot, 'm1', 'auth_error', subRoute), true);
  assert.equal(quotaMatches(exhaustedSnapshot, 'm1', 'issues', subRoute), true);
  assert.equal(quotaMatches(healthySnapshot, 'm1', 'disabled', disRoute), true);

  const entries = [
    { route: zaiRoute, model: { id: 'glm-5-turbo', enabled: true, order: 2, memberships: [{ group: 'low', order: 2 }] } },
    { route: subRoute, model: { id: 'gemini-4-argon', enabled: true, order: 1, memberships: [{ group: 'high', order: 1 }] } },
    { route: { id: 'agy-acc2', adapter: 'agy', billing: 'subscription', enabled: true }, model: { id: 'claude-opus-5', enabled: true, order: 0, memberships: [{ group: 'high', order: 0 }] } },
  ];
  const ctx = {
    quotas: {
      'sub-a': healthySnapshot,
      'zai-b': { status: 'available', windows: [{ name: '5h', remainingPercent: 90 }, { name: 'weekly', remainingPercent: 90 }] },
      'agy-acc2': authSnapshot,
    },
    emails: { 'sub-a': 'z@example.com', 'zai-b': 'b@example.com', 'agy-acc2': 'a@example.com' },
    group: 'high',
    categoryNames: { high: 'Yüksek', low: 'Hafif' },
  };
  assert.deepEqual(sortModels(entries, 'manual', false, ctx).map(e => e.model.id), ['claude-opus-5', 'gemini-4-argon', 'glm-5-turbo']);
  assert.deepEqual(sortModels(entries, 'email', false, ctx).map(e => e.route.id), ['agy-acc2', 'zai-b', 'sub-a']);
  assert.deepEqual(sortModels(entries, 'provider', false, ctx).map(e => e.route.adapter), ['agy', 'agy', 'zcode']);
  assert.deepEqual(sortModels(entries, 'family', false, ctx).map(e => modelFamily(e.model.id)), ['argon', 'glm', 'opus']);
  assert.deepEqual(sortModels(entries, 'quota_desc', false, ctx).map(e => e.route.id), ['zai-b', 'sub-a', 'agy-acc2']);
  assert.deepEqual(sortModels(entries, 'quota_asc', false, ctx).map(e => e.route.id), ['sub-a', 'zai-b', 'agy-acc2']);
  assert.deepEqual(sortModels(entries, 'quota_5h', false, ctx).map(e => e.route.id), ['zai-b', 'sub-a', 'agy-acc2']);
  assert.deepEqual(sortModels(entries, 'quota_weekly', false, ctx).map(e => e.route.id), ['zai-b', 'sub-a', 'agy-acc2']);
  assert.deepEqual(sortModels(entries, 'category', false, ctx).map(e => e.model.id), ['glm-5-turbo', 'claude-opus-5', 'gemini-4-argon']);
  assert.deepEqual(sortModels(entries, 'status', false, ctx).map(e => e.route.id), ['agy-acc2', 'sub-a', 'zai-b']);

  const routesForUnhide = [
    { id: 'agy-1', models: [{ id: 'gemini-4-argon' }, { id: 'claude-opus-5-5-high' }] },
    { id: 'agy-2', models: [{ id: 'gemini-4-argon' }] },
  ];
  const nextFilters = unhideModels(
    [{ match: 'family', value: 'argon', reason: 'unknown_quota' }],
    routesForUnhide,
    [{ routeId: 'agy-1', modelId: 'gemini-4-argon' }],
  );
  assert.equal(modelFiltered(nextFilters, 'agy-1', 'gemini-4-argon'), false);
  assert.equal(modelFiltered(nextFilters, 'agy-2', 'gemini-4-argon'), true);
  assert.equal(nextFilters[0].reason, 'unknown_quota');
});

test('Pool.select uses manual order tie-breaker and browserUI supports safe shutdown and service updates', async t => {
  const root = mkdtempSync(path.join(tmpdir(), 'pool-order-shutdown-'));
  const config = configSchema.parse({
    workspaceRoots: [root],
    routes: [
      {
        id: 'route-a',
        adapter: 'custom',
        executable: process.execPath,
        argsTemplate: ['--version'],
        billing: 'free',
        priority: 100,
        enabled: true,
        models: [
          { id: 'first-added', alias: 'First', group: 'medium', memberships: [{ group: 'medium', order: 5 }], enabled: true, kinds: ['text'] },
          { id: 'prioritized', alias: 'Prioritized', group: 'medium', memberships: [{ group: 'medium', order: 1 }], enabled: true, kinds: ['text'] },
        ],
      },
    ],
  });
  writeFileSync(path.join(root, 'config.json'), JSON.stringify(config));
  const store = new Store(':memory:');
  const pool = new Pool(config, store, { directory: root });
  t.after(async () => { await pool.close(); store.close(); await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });

  assert.equal(pool.select({ kind: 'text', group: 'medium' }).selected.id, 'prioritized');

  let shutdownCalled = 0;
  let updateCalled = 0;
  pool.active.set('running-1', { cancel() {} });
  const ui = browserUI(pool, {
    directory: root,
    token: 'a'.repeat(64),
    onShutdown: () => { shutdownCalled += 1; },
    onUpdate: async () => { updateCalled += 1; return { shortcut: true, skill: true }; },
  });

  const confirmNeeded = await ui.operation({ operation: 'shutdown', payload: { force: false } });
  assert.equal(confirmNeeded.stopping, false);
  assert.equal(confirmNeeded.confirmRequired, true);
  assert.equal(confirmNeeded.activeCount, 1);

  const forced = await ui.operation({ operation: 'shutdown', payload: { force: true } });
  assert.equal(forced.stopping, true);
  await new Promise(resolve => setTimeout(resolve, 160));
  assert.equal(shutdownCalled, 1);
  pool.active.clear();

  const updated = await ui.operation({ operation: 'update_service' });
  assert.equal(updated.updated, true);
  assert.equal(updated.shortcut, true);
  assert.equal(updateCalled, 1);
});

test('Hydrogen/Fable families, Antigravity Hydrogen quota windows, live Codex scan_import, and Settings model filters work together', async t => {
  assert.equal(modelFamily('gemini-4-hydrogen'), 'hydrogen');
  assert.equal(modelFamily('gemini-4-hydrogen-xhigh'), 'hydrogen');
  assert.equal(modelFamily('claude-fable-5-2'), 'fable');

  const usageWins = agyUsageWindows({
    command: {
      data: {
        groups: [
          {
            name: 'Gemini Models',
            description: 'Models within this group: Gemini 4 Hydrogen, Gemini 3.8 Flash',
            buckets: [
              { window: 'weekly', remaining_fraction: 0.68 },
              { window: '5h', remaining_fraction: 0.75 },
            ],
          },
          {
            name: 'Gemini 4 Argon',
            buckets: [{ window: 'weekly', remaining_fraction: 0.82 }],
          },
        ],
      },
    },
  });
  assert.deepEqual(quotaWindows({ windows: usageWins }, 'gemini-4-hydrogen').map(w => w.remaining), [68, 75]);
  assert.deepEqual(quotaWindows({ windows: usageWins }, 'gemini-4-argon').map(w => w.remaining), [82]);

  const groupWins = antigravityGroupWindows({
    groups: [
      { displayName: 'Gemini Models', description: 'Gemini 4 Hydrogen, Gemini 3.8 Flash', buckets: [{ window: '5h', remainingFraction: 0.9 }] },
      { displayName: 'Gemini 4 Argon', buckets: [{ window: 'weekly', remainingFraction: 0.4 }] },
    ],
  });
  assert.deepEqual(quotaWindows({ windows: groupWins }, 'gemini-4-hydrogen').map(w => w.remaining), [90]);
  assert.deepEqual(quotaWindows({ windows: groupWins }, 'gemini-4-argon').map(w => w.remaining), [40]);

  const root = mkdtempSync(path.join(tmpdir(), 'pool-sync-settings-'));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  const codexStub = path.join(root, 'codex-stub.mjs');
  writeFileSync(codexStub, `import { createInterface } from 'node:readline';
const rl = createInterface({ input: process.stdin });
rl.on('line', line => {
  const msg = JSON.parse(line);
  if (msg.method === 'initialize') console.log(JSON.stringify({ id: msg.id, result: { ok: true } }));
  else if (msg.method === 'model/list') console.log(JSON.stringify({ id: msg.id, result: { data: [
    { id: 'gpt-6.1-sol', displayName: 'GPT-6.1-Sol', supportedReasoningEfforts: [{ reasoningEffort: 'high' }] },
    { id: 'gpt-6.2-nova', displayName: 'GPT-6.2-Nova', supportedReasoningEfforts: [{ reasoningEffort: 'medium' }] },
  ] } }));
});`);

  const initialConfig = configSchema.parse({
    workspaceRoots: [root],
    modelFilters: [{ match: 'model', value: 'gpt-6.1-sol', routeId: 'codex-test', reason: 'settings' }],
    routes: [{
      id: 'codex-test',
      adapter: 'codex',
      executable: codexStub,
      billing: 'subscription',
      enabled: true,
      models: [{ id: 'gpt-6.1-sol', alias: 'GPT-6.1-Sol', group: 'high', memberships: [{ group: 'high' }], enabled: true, kinds: ['text'] }],
    }],
  });
  writeFileSync(path.join(root, 'config.json'), JSON.stringify(initialConfig, null, 2));

  const store = new Store(':memory:');
  const pool = new Pool(initialConfig, store, { directory: root });
  t.after(async () => { await pool.close(); store.close(); });

  const ui = browserUI(pool, { directory: root, token: 'b'.repeat(64) });
  const scanned = await ui.operation({ operation: 'scan_import', payload: { routeId: 'codex-test' } });
  const codexRoute = scanned.config.routes.find(r => r.id === 'codex-test');
  assert.ok(codexRoute.models.some(m => m.id === 'gpt-6.1-sol'), 'Settings route retains filtered model');
  assert.ok(codexRoute.models.some(m => m.id === 'gpt-6.2-nova'), 'Live Codex scan imports newly released model');

  assert.equal(isSettingsFiltered(scanned.config.modelFilters, 'codex-test', 'gpt-6.1-sol'), true);
  assert.equal(pool.models().some(m => m.routeId === 'codex-test' && m.id === 'gpt-6.1-sol'), false);
  assert.equal(pool.models().some(m => m.routeId === 'codex-test' && m.id === 'gpt-6.2-nova'), true);
  assert.throws(() => pool.select({ kind: 'text', routeId: 'codex-test', modelId: 'gpt-6.1-sol' }), { code: 'NO_ROUTE' });
  assert.equal(pool.select({ kind: 'text', routeId: 'codex-test', modelId: 'gpt-6.2-nova' }).selected.id, 'gpt-6.2-nova');

  const unhidden = setRouteModelSettingsFilter(scanned.config.modelFilters, 'codex-test', 'gpt-6.1-sol', false, scanned.config.routes);
  assert.equal(isSettingsFiltered(unhidden, 'codex-test', 'gpt-6.1-sol'), false);
  const rehidden = setRouteModelSettingsFilter(unhidden, 'codex-test', 'gpt-6.2-nova', true, scanned.config.routes);
  assert.equal(isSettingsFiltered(rehidden, 'codex-test', 'gpt-6.2-nova'), true);

  assert.equal(typeof importDiscoveredRoutes, 'function');
});

test('cleanRouteLabel, toolGroupsForRoutes, and filterHierarchy group tools alphabetically with subscription sub-tabs and family filters', () => {
  assert.equal(cleanRouteLabel({ id: 'zcode-local', adapter: 'zcode' }), 'Varsayılan abonelik');
  assert.equal(cleanRouteLabel({ id: 'zcode-local', adapter: 'zcode' }, '', 2), 'Abonelik #2');
  assert.equal(cleanRouteLabel({ id: 'agy-local', adapter: 'agy' }, 'alpha@example.com'), 'alpha@example.com');
  assert.equal(cleanRouteLabel({ id: 'agy-acc4', adapter: 'agy', profile: 'acc4' }), 'Abonelik #4');
  assert.equal(cleanRouteLabel({ id: 'qwen-api', adapter: 'claude', api: { baseUrl: 'https://api.example.com' } }), 'qwen-api · API');

  const routes = [
    { id: 'zcode-local', adapter: 'zcode', enabled: true, models: [{ id: 'glm-5.3' }] },
    { id: 'claude-api', adapter: 'claude', enabled: true, api: { baseUrl: 'https://x.test' }, models: [{ id: 'claude-opus-5-5' }] },
    { id: 'agy-acc2', adapter: 'agy', profile: 'acc2', enabled: true, models: [{ id: 'gemini-4-hydrogen' }, { id: 'gemini-4-argon' }] },
    { id: 'agy-local', adapter: 'agy', enabled: true, models: [{ id: 'gemini-4-hydrogen' }, { id: 'claude-opus-5-5' }] },
    { id: 'claude-local', adapter: 'claude', enabled: true, models: [{ id: 'claude-sonnet-5-5' }, { id: 'claude-fable-5-2' }] },
  ];
  const emails = { 'agy-local': 'b-user@example.com', 'agy-acc2': 'a-user@example.com', 'claude-local': 'claude@example.com' };
  const labels = { agy: 'Antigravity', claude: 'Claude', zcode: 'ZCode' };

  const grouped = toolGroupsForRoutes(routes, emails, labels);
  assert.deepEqual(grouped.map(g => g.label), ['Antigravity', 'Claude', 'ZCode']);
  assert.deepEqual(grouped[0].routes.map(r => r.subscriptionLabel), ['a-user@example.com', 'b-user@example.com']);
  assert.deepEqual(grouped[1].routes.map(r => r.subscriptionLabel), ['claude@example.com', 'claude-api · API']);
  assert.deepEqual(grouped[2].routes.map(r => r.subscriptionLabel), ['Varsayılan abonelik']);

  const entries = routes.flatMap(route => route.models.map(model => ({ route, model })));
  const toolAll = filterHierarchy(entries, { tool: 'agy' }, emails, labels);
  assert.equal(toolAll.tool, 'agy');
  assert.equal(toolAll.routeId, '__all__');
  assert.deepEqual(toolAll.tools.map(t => t.label), ['Tümü', 'Antigravity', 'Claude', 'ZCode']);
  assert.deepEqual(toolAll.subscriptions.map(s => s.label), ['Tümü', 'a-user@example.com', 'b-user@example.com']);
  assert.equal(toolAll.filtered.length, 4);

  const subOnly = filterHierarchy(entries, { tool: 'agy', routeId: 'agy-acc2' }, emails, labels);
  assert.equal(subOnly.routeId, 'agy-acc2');
  assert.equal(subOnly.filtered.length, 2);

  const subAndFamily = filterHierarchy(entries, { tool: 'agy', routeId: 'agy-acc2', family: 'hydrogen' }, emails, labels);
  assert.deepEqual(subAndFamily.filtered.map(e => e.model.id), ['gemini-4-hydrogen']);

  const normalized = filterHierarchy(entries, { tool: 'missing', routeId: 'agy-acc2', family: 'hydrogen' }, emails, labels);
  assert.equal(normalized.tool, '__all__');
  assert.equal(normalized.routeId, '__all__');
  assert.equal(normalized.family, 'hydrogen');
  assert.equal(normalized.filtered.length, 2);
});
