import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { configSchema } from '../src/config.js';
import { mergeCatalogModels, buildArguments, execute, routeCatalog } from '../src/adapters.js';
import { antigravityGroupWindows } from '../src/quotas.js';
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
 const windows=antigravityGroupWindows({groups:[{displayName:'Gemini Models',description:'Models within this group: Gemini Flash, Gemini Pro',buckets:[{window:'weekly',remainingFraction:0.23}]},{displayName:'Argon',buckets:[{window:'weekly',remainingFraction:0.71}]}]});
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


test('Antigravity native stream parses the terminal response and retains permission failures',async t=>{
 const root=mkdtempSync(path.join(tmpdir(),'pool-agy-native-')),file=path.join(root,'agy.cjs');
 t.after(()=>rm(root,{recursive:true,force:true,maxRetries:10,retryDelay:100}));
 const route={id:'agy',adapter:'agy',executable:file},model={id:'sonnet',efforts:[]};
 const run=async(events)=>{writeFileSync(file,'for(const e of '+JSON.stringify(events)+')console.log(JSON.stringify(e));');return execute(route,model,{kind:'write',workspace:root,prompt:'fixture',timeoutSeconds:5},process.platform==='win32'?'python':'python3',()=>{}).done;};
 const complete={event:'result',result:{status:'SUCCESS',response:'OK'}};
 assert.deepEqual(await run([{event:'init',init:{model:'sonnet'}},complete]),{result:'OK'});
 const denied={event:'step_update',step_update:{state:'ERROR',step_type:'tool',tool_name:'edit_file',tool_info:{error:{type:'TOOL_ERROR',message:'permission check failed: Matches user-configured deny rule.'}}}};
 assert.deepEqual(await run([denied,complete]),{error:'PERMISSION_REQUIRED'});
 assert.deepEqual(await run([{...denied,step_update:{...denied.step_update,tool_info:{error:{message:'File not found'}}}},complete]),{result:'OK'});
 assert.deepEqual(await run([{event:'step_update',step_update:{state:'DONE',step_type:'agent_response'}}]),{error:'INVALID_RESULT'});
 assert.equal((await run([{event:'result',result:{status:'ERROR',response:'Failed'}}])).error,'CLI_FAILED');
});

test('unverified non-paid routes are excluded from automatic selection and queue exposes review locks',async t=>{
 const route=(id,autoSelect)=>({id,adapter:'custom',executable:process.execPath,argsTemplate:['--version'],enabled:true,billing:'free',autoSelect,models:[{id:'model',alias:id,group:'medium',kinds:['read']}]});
 const config=configSchema.parse({routes:[route('first',false),route('second',true)]}),store=new Store(':memory:'),pool=new Pool(config,store);
 t.after(async()=>{await pool.close();store.close();});
 assert.equal(pool.select({kind:'read',group:'medium'}).selected.routeId,'second');
 assert.equal(pool.select({kind:'read',group:'medium',routeId:'first'}).selected.routeId,'first');
 const queried=[];pool.getQuota=async id=>{queried.push(id);return {};};
 assert.equal((await pool.selectLive({kind:'read',group:'medium'})).selected.routeId,'second');assert.deepEqual(queried,['second']);
 for(const id of ['held','waiting'])store.insert({id,key:id,fingerprint:id,workspace:process.cwd(),request:{routeId:'first',kind:'write'}});
 store.update('held','needs_review',null,'CLI_FAILED');
 assert.equal(pool.get('waiting').queueReason,'WORKSPACE_REVIEW_REQUIRED');assert.equal(pool.get('waiting').blockedBy,'held');
});

test('Kimi provider subscription refusal is not reported as a generic CLI failure',async t=>{
 const root=mkdtempSync(path.join(tmpdir(),'pool-kimi-plan-')),file=path.join(root,'kimi.cjs');t.after(()=>rm(root,{recursive:true,force:true,maxRetries:10,retryDelay:100}));
 writeFileSync(file,"console.error('provider.auth_error: 403 Your current subscription does not have access to Kimi Code right now.');process.exit(1)");
 assert.equal(await execute({id:'kimi',adapter:'kimi',executable:file},{id:'model'},{kind:'text',workspace:root,prompt:'fixture',timeoutSeconds:5},process.platform==='win32'?'python':'python3',()=>{}).done.then(r=>r.error),'SUBSCRIPTION_REQUIRED');
});
