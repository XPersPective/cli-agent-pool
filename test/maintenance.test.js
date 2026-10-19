import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { configSchema } from '../src/config.js';
import { mergeCatalogModels, buildArguments, execute, antigravityQuotaWindows, routeCatalog } from '../src/adapters.js';
import { quotaWindows } from '../web/pool-state.js';
import { Pool } from '../src/pool.js';
import { Store } from '../src/store.js';

test('native effort variants migrate atomically and keep the actual CLI ID and prompt', async t=>{
 const root=mkdtempSync(path.join(tmpdir(),'pool-variants-')),file=path.join(root,'agy.cjs');
 t.after(()=>rm(root,{recursive:true,force:true,maxRetries:10,retryDelay:100}));
 writeFileSync(file,`const a=process.argv.slice(2);if(a[0]==='models'){console.log('gemini-3.8-flash-high\\tFlash High\\ngemini-3.8-flash-low\\tFlash Low');process.exit(0)} const prompt=a.find(v=>v.startsWith('--print='));if(!prompt || a.includes('-p'))process.exit(2);console.log(JSON.stringify({type:'result',result:prompt.slice(8)}));`);
 const route={id:'agy',adapter:'agy',executable:file,models:[{id:'gemini-3.8-flash-high',alias:'High',group:'high',enabled:true,efforts:['high']},{id:'gemini-3.8-flash-low',alias:'Low',group:'low',enabled:true,efforts:['low']}]};
 const catalog=await routeCatalog(route,root,process.platform==='win32'?'python':'python3');
 assert.equal(catalog.models.length,1);assert.deepEqual(catalog.models[0].efforts,['high','low']);
 mergeCatalogModels(route,catalog);assert.equal(route.models.length,1);
 assert.deepEqual(route.models[0].memberships,[{group:'high',effort:'high'},{group:'low',effort:'low'}]);
 const task={kind:'text',workspace:root,prompt:'--output-format is literal; Türkçe',effort:'low',timeoutSeconds:5};
 const args=buildArguments(route,route.models[0],task);assert.equal(args[args.indexOf('--model')+1],'gemini-3.8-flash-low');
 assert.deepEqual(await execute(route,route.models[0],task,process.platform==='win32'?'python':'python3',()=>{}).done,{result:task.prompt});
 const conflict={...route,models:[{...route.models[0],id:'gemini-3.8-flash-high',memberships:[{group:'low',effort:'high'}]},{...route.models[0],id:'gemini-3.8-flash-low',memberships:[{group:'low',effort:'low'}]}]};
 const before=structuredClone(conflict);assert.throws(()=>mergeCatalogModels(conflict,catalog),{code:'MODEL_VARIANT_CONFLICT'});assert.deepEqual(conflict,before);
 const filters=[{match:'model',value:'gemini-3.8-flash-high',routeId:'agy'}];mergeCatalogModels(route,catalog,filters);assert.equal(filters[0].value,'gemini-3.8-flash');
});

test('provider family quota scopes do not invent an Argon weekly balance',()=>{
 const windows=antigravityQuotaWindows([{name:'Gemini Models',short_name:'Gemini',description:'Models within this group: Gemini Flash, Gemini Pro',buckets:{weekly:{remaining_pct:23}}},{name:'Argon',short_name:'Gemini',buckets:{weekly:{remaining_pct:71}}}]);
 assert.deepEqual(quotaWindows({windows},'gemini-4-argon').map(w=>w.remaining),[71]);
 assert.deepEqual(quotaWindows({windows},'gemini-3.8-flash').map(w=>w.remaining),[23]);
 assert.deepEqual(quotaWindows({windows:windows.slice(0,1)},'gemini-4-argon'),[]);
});

test('card probes preserve owner policy and use an isolated runtime workspace',async t=>{
 const root=mkdtempSync(path.join(tmpdir(),'pool-probe-'));let ran;
 const config=configSchema.parse({workspaceRoots:[],selectionMode:'manual',routes:[{id:'test',adapter:'custom',executable:process.execPath,argsTemplate:['--version'],billing:'free',enabled:true,models:[{id:'tiny',alias:'Tiny',group:'unassigned',memberships:[{group:'low',effort:'low'}],efforts:['low'],kinds:['text']}]}]});
 const store=new Store(':memory:'),pool=new Pool(config,store,{directory:root,checkAuth:async()=>{},execute:(route,model,task)=>{ran=task;return{cancel(){},done:Promise.resolve({result:'OK'})};}});
 pool.getQuota=async()=>({status:'unknown',windows:[],observedAt:new Date().toISOString()});
 t.after(async()=>{await pool.close();store.close();await rm(root,{recursive:true,force:true,maxRetries:10,retryDelay:100});});
 await assert.rejects(pool.probeModel({routeId:'test',modelId:'tiny'}),{code:'POOL_REQUIRED'});
 await assert.rejects(pool.probeModel({routeId:'test',modelId:'tiny',prompt:'unsafe'}),{code:'INVALID_REQUEST'});
 const task=await pool.probeModel({routeId:'test',modelId:'tiny',group:'low'});
 for(let i=0;i<50 && !ran;i++)await new Promise(resolve=>setTimeout(resolve,10));
 assert(ran);assert.equal(ran.kind,'text');assert.equal(ran.effort,'low');assert.equal(config.workspaceRoots.length,0);assert(ran.workspace.startsWith(path.join(root,'probes')));assert.equal(pool.get(task.id).clientLabel,'Model testi');
 assert.throws(()=>pool.submit({...ran,idempotencyKey:'forged-probe'}));
 config.routes[0].enabled=false;await assert.rejects(pool.probeModel({routeId:'test',modelId:'tiny',group:'low'}),{code:'NO_ROUTE'});
});

test('history expiration keeps admission keys, active writes and review quarantine',()=>{
 const store=new Store(':memory:');
 try{
  for(const [id,state]of [['done','succeeded'],['held','needs_review'],['active','running']]){store.insert({id,key:`key-${id}`,fingerprint:'same',workspace:'project',request:{prompt:'private request',routeId:'route'}});store.update(id,state,'private result');}
  store.pruneHistory('9999-01-01');
  assert.equal(store.byKey('key-done').fingerprint,'same');assert.equal(JSON.parse(store.get('done').request).prompt,undefined);assert.equal(store.get('done').result,null);assert.equal(store.events('done').length,0);
  assert.equal(JSON.parse(store.get('held').request).prompt,'private request');assert.equal(store.get('active').result,'private result');assert.equal(store.held().length,2);
 }finally{store.close();}
});

