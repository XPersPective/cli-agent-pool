import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { randomBytes } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { configSchema } from '../src/config.js';
import { Store } from '../src/store.js';
import { Pool } from '../src/pool.js';
import { createServer } from '../src/server.js';
import { preflightScope } from '../src/director.js';
import { taskHeader } from '../src/task-header.js';

const report = JSON.stringify({ status: 'completed', summary: 'ok', files: [], checks: [], research: [], blockers: [] });
async function until(check) { for(let i=0;i<300;i++){const value=check();if(value)return value;await delay(10);}assert.fail('condition did not settle'); }
function setup(t, options = {}) {
  const root = mkdtempSync(path.join(tmpdir(), 'pool-lifecycle-'));
  const workspace = path.join(root,'work'); mkdirSync(workspace);
  const config = configSchema.parse({ routes: [{ id:'native',adapter:'codex',executable:process.execPath,enabled:true,billing:'subscription',models:[{id:'m',alias:'m',kinds:['text','read','write'],group:'high'}] }] });
  const store = new Store(':memory:');
  let now=Date.now();
  const runs=[];
  const pool=new Pool(config,store,{directory:root,checkAuth:async()=>{},fingerprint:async()=> 'same',settleMs:0,
    watchdog:{autoTick:false,now:()=>now,...options.watchdog},
    execute:(route,model,task,python,progress,directory,context)=>{let finish;const done=new Promise(resolve=>{finish=resolve;});runs.push({task,progress,context,finish});return{cancel:reason=>finish({error:reason}),done};},...options.dependencies});
  t.after(async()=>{await pool.close();store.close();await rm(root,{recursive:true,force:true,maxRetries:10,retryDelay:100});});
  const submit=(key,extra={})=>pool.submit({prompt:'direct',workspace,kind:'write',mode:'execute',profile:'director',routeId:'native',idempotencyKey:key,...extra},false,{owner:true});
  return{root,workspace,config,store,pool,runs,submit,advance:ms=>{now+=ms;}};
}

test('secrets are memory-only, idempotent, injected and redacted; lost secrets fail before execution',async t=>{
 const f=setup(t); const secret='private-baton-0123456789';
 const task=f.submit('secret-test-1',{secretEnv:{PB_RELAY_TOKEN:secret}});
 assert.ok(!f.store.get(task.id).request.includes(secret));
 assert.equal(f.submit('secret-test-1',{secretEnv:{PB_RELAY_TOKEN:'different-value'}}).id,task.id);
 assert.equal(f.submit('secret-test-1').id,task.id,'secret field is excluded from fingerprint');
 await until(()=>f.runs.length===1);
 assert.equal(f.runs[0].context.secretEnv.PB_RELAY_TOKEN,secret);
 assert.equal(f.runs[0].context.taskId,task.id);
 f.runs[0].progress('sensitive '+secret);
 f.runs[0].finish({error:'CLI_FAILED',detail:secret,result:secret});
 await until(()=>f.pool.get(task.id).state==='failed');
 assert.ok(!JSON.stringify(f.pool.get(task.id)).includes(secret));
 assert.throws(()=>f.submit('secret-bad-name',{secretEnv:{PATH:'bad'}}));
 f.pool.pumping=true;
 const lost=f.submit('lost-secret-test',{secretEnv:{PB_RELAY_TOKEN:secret}});
 f.pool.secrets.delete(lost.id); f.pool.pumping=false; f.pool.schedule();
 await until(()=>f.pool.get(lost.id).error==='SECRET_LOST');
 assert.equal(f.runs.length,1);
});

test('queued/start, running/ack and idle deadlines cancel before final lock decision; linked workers are liveness',async t=>{
 const f=setup(t);
 const first=f.submit('timer-parent-1',{ackDeadlineSeconds:60}); await until(()=>f.runs.length===1);
 const queued=f.submit('timer-queued-1',{startDeadlineSeconds:60});
 f.advance(61000);await f.pool.watchdog.tick();
 await until(()=>f.pool.get(first.id).state==='cancelled');
 assert.equal(f.pool.get(first.id).error,'ACK_TIMEOUT'); assert.equal(f.pool.get(queued.id).error,'START_TIMEOUT');
 const live=f.submit('timer-live-1',{ackDeadlineSeconds:60,idleTimeoutSeconds:300}); await until(()=>f.runs.length===2);
 f.pool.watchdog.ack(live.id);f.pool.watchdog.ack(live.id);
 f.advance(61000);await f.pool.watchdog.tick();assert.equal(f.pool.get(live.id).state,'running');
 const outside=path.join(f.root,'worker');mkdirSync(outside);
 const child=f.pool.submit({prompt:'read',kind:'read',workspace:outside,routeId:'native',idempotencyKey:'linked-worker-1'},false,{taskToken:f.runs[1].context.token});
 await until(()=>f.runs.length===3);assert.equal(f.pool.get(child.id).parentTaskId,live.id);
 assert.throws(()=>f.pool.submit({prompt:'x',workspace:f.workspace,kind:'read',idempotencyKey:'overlapping-child'},false,{taskToken:f.runs[1].context.token}),{code:'WORKSPACE_HELD_BY_PARENT'});
 f.advance(400000);await f.pool.watchdog.tick();assert.equal(f.pool.get(live.id).state,'running');
 f.runs[2].finish({result:'read'});await until(()=>f.pool.get(child.id).state==='succeeded');
 f.advance(301000);await f.pool.watchdog.tick();await until(()=>f.pool.get(live.id).state==='cancelled');
 assert.equal(f.pool.get(live.id).error,'IDLE_TIMEOUT');
 assert.throws(()=>f.pool.watchdog.ack(live.id),{code:'INVALID_STATE'});
});

test('exit hook runs after active handle and lock settle, with owner env, closed input and visible notifications',async t=>{
 const f=setup(t);const output=path.join(f.root,'hook.json');
 const script=path.join(f.root,'hook.js');
 writeFileSync(script,`const fs=require('node:fs');fs.writeFileSync(process.argv[2],JSON.stringify({id:process.env.CAP_TASK_ID,state:process.env.CAP_TASK_STATE,worker:process.env.CLI_AGENT_POOL_WORKER,secret:process.env.PB_RELAY_TOKEN,token:process.env.CLI_AGENT_POOL_TASK_TOKEN}));console.log('CAP_NOTIFY recovered');`);
 const task=f.submit('hook-native-test',{secretEnv:{PB_RELAY_TOKEN:'super-secret'},onExit:{argv:[process.execPath,script,output],timeoutSeconds:10}});
 await until(()=>f.runs.length===1);f.runs[0].finish({error:'CLI_FAILED'});
 await until(()=>f.store.hook(task.id)?.state==='done');
 assert.equal(f.pool.active.has(task.id),false);assert.equal(f.store.held().length,0);
 assert.deepEqual(JSON.parse(readFileSync(output,'utf8')),{id:task.id,state:'failed'});
 assert.ok(f.pool.get(task.id).events.some(e=>e.kind==='notification'&&e.detail==='recovered'));
 assert.throws(()=>f.submit('bad-hook-path',{onExit:{argv:['node','x.js']}}),{code:'INVALID_REQUEST'});
});

test('hook exit 75 retries 3 times at 30s intervals; other codes final; pending startup hooks recover',async t=>{
 let count=0; const f=setup(t,{watchdog:{runHook:()=>({done:Promise.resolve({code:75,output:'temporary'})})}});
 const task=f.submit('hook-retry-test',{onExit:{argv:[process.execPath],timeoutSeconds:1}});
 await until(()=>f.runs.length===1);f.runs[0].finish({result:report});
 await until(()=>f.store.hook(task.id)?.attempts===1&&f.store.hook(task.id)?.state==='pending');
 for(let i=2;i<=4;i++){await f.pool.watchdog.tick();assert.equal(f.store.hook(task.id).attempts,i-1);f.advance(30001);await f.pool.watchdog.tick();await until(()=>f.store.hook(task.id)?.attempts===i&&f.store.hook(task.id)?.state!=='running');count++;}
 assert.equal(count,3);assert.equal(f.store.hook(task.id).state,'done');
 const interrupted=f.submit('hook-interrupted-test',{onExit:{argv:[process.execPath],timeoutSeconds:1}});
 await until(()=>f.runs.length===2);f.runs[1].finish({result:report});await until(()=>f.store.hook(interrupted.id)?.attempts===1);
 f.store.finishHook(interrupted.id,0);await f.pool.watchdog.tick();await until(()=>f.store.hook(interrupted.id)?.attempts===2);
});

test('MCP capability discovery and owner/worker/director authority, self ack and successor submit',async t=>{
 const f=setup(t);const token=randomBytes(32).toString('hex');const app=createServer(f.pool,token,0);
 const address=await app.listen();f.config.port=address.port;t.after(()=>{app.server.close();app.server.closeAllConnections();});
 async function client(headers={}){const c=new Client({name:'contract-test',version:'1'});await c.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${address.port}/mcp`),{requestInit:{headers:{Authorization:'Bearer '+token,...headers}}}));t.after(()=>c.close());return c;}
 const owner=await client();const caps=(await owner.callTool({name:'pool_capabilities',arguments:{}})).structuredContent.data;assert.ok(caps.features.includes('directorProfile'));assert.ok(caps.contracts.includes('pb-director/1'));
 const task=f.submit('mcp-director-auth');await until(()=>f.runs.length===1);
 const director=await client(taskHeader({CLI_AGENT_POOL_TASK_TOKEN:f.runs[0].context.token,CLI_AGENT_POOL_WORKER:'1'}));
 assert.equal((await director.callTool({name:'pool_ack_task',arguments:{taskId:task.id}})).isError,undefined);
 const denied=await director.callTool({name:'pool_preflight',arguments:{routeId:'native',workspace:f.workspace}});assert.equal(denied.isError,true);assert.match(denied.content[0].text,/OWNER_ONLY/);
 const scope=await preflightScope(f.pool,{routeId:'native',workspace:f.workspace});
 f.store.savePreflight(scope.scope,{key:scope.key,status:'ready',capabilities:{},observedAt:new Date().toISOString()});
 const successorResult=await director.callTool({name:'pool_submit',arguments:{prompt:'continue',workspace:f.workspace,kind:'write',mode:'execute',profile:'director',routeId:'native',idempotencyKey:'director-successor-auth'}});
 assert.equal(successorResult.isError,undefined,JSON.stringify(successorResult));
 const successor=successorResult.structuredContent.data;
 assert.equal(successor.state,'queued');assert.equal(successor.parentTaskId,null);
 const outside=path.join(f.root,'ordinary');mkdirSync(outside);
 const child=f.pool.submit({prompt:'read',workspace:outside,kind:'read',routeId:'native',idempotencyKey:'ordinary-worker-auth'},false,{taskToken:f.runs[0].context.token});
 await until(()=>f.runs.length===2);
 const worker=await client(taskHeader({CLI_AGENT_POOL_TASK_TOKEN:f.runs[1].context.token,CLI_AGENT_POOL_WORKER:'1'}));
 const forbidden=await worker.callTool({name:'pool_submit',arguments:{prompt:'continue',workspace:f.workspace,kind:'write',mode:'execute',profile:'director',routeId:'native',idempotencyKey:'worker-successor-denied'}});
 assert.equal(forbidden.isError,true);assert.match(forbidden.content[0].text,/OWNER_ONLY/);
 assert.equal((await worker.callTool({name:'pool_ack_task',arguments:{taskId:task.id}})).isError,true);
 const markerWorker=await client({'X-Pool-Worker':'1'});
 const blocked=await markerWorker.callTool({name:'pool_submit',arguments:{prompt:'x',workspace:f.workspace,kind:'write',mode:'execute',profile:'director',routeId:'native',idempotencyKey:'worker-owner-denied'}});
 assert.equal(blocked.isError,true);assert.match(blocked.content[0].text,/OWNER_ONLY/);
 const stale=await client({'X-Pool-Task':'f'.repeat(64)});
 const staleResult=await stale.callTool({name:'pool_submit',arguments:{prompt:'x',workspace:f.workspace,kind:'read',idempotencyKey:'stale-token-denied'}});
 assert.equal(staleResult.isError,true);assert.match(staleResult.content[0].text,/TASK_TOKEN_LOST/);
});


test('pending exit hooks survive real Store restart and queued secret tasks fail SECRET_LOST',async t=>{
 const root=mkdtempSync(path.join(tmpdir(),'pool-restart-lifecycle-'));const workspace=path.join(root,'work');mkdirSync(workspace);
 const filename=path.join(root,'pool.sqlite');let store=new Store(filename);
 const config=configSchema.parse({routes:[{id:'native',adapter:'codex',executable:process.execPath,enabled:true,billing:'subscription',models:[{id:'m',alias:'m',group:'high',kinds:['write']}]}]});
 const id='00000000-0000-4000-8000-000000000005';
 store.insert({id,key:'restart-hook-test',fingerprint:'x',workspace,request:{prompt:'p',kind:'write',workspace,routeId:'native',onExit:{argv:[process.execPath],timeoutSeconds:1}}});
 store.update(id,'running');store.event(id,'workspace_snapshot','same');
 const secretId='00000000-0000-4000-8000-000000000006';
 store.insert({id:secretId,key:'restart-secret-test',fingerprint:'x',workspace,request:{prompt:'p',kind:'write',workspace,routeId:'native',requiresSecrets:true}});
 store.close();store=new Store(filename);
 let hooks=0;
 const pool=new Pool(config,store,{directory:root,settleMs:0,fingerprint:async()=> 'same',checkAuth:async()=>{},execute:()=>{assert.fail('lost secret task must never execute');},watchdog:{autoTick:false,runHook:()=>{hooks++;assert.equal(store.get(id).state,'failed');return{done:Promise.resolve({code:0,output:'recovered'})};}}});
 t.after(async()=>{await pool.close();store.close();await rm(root,{recursive:true,force:true,maxRetries:10,retryDelay:100});});
 await pool.reconciled;pool.schedule();await until(()=>store.get(secretId).error==='SECRET_LOST');await pool.watchdog.tick();await until(()=>store.hook(id).state==='done');
 assert.equal(hooks,1);assert.equal(store.get(id).error,'INTERRUPTED');
 await pool.watchdog.tick();assert.equal(hooks,1);
});


test('director idempotent replay survives exhausted quota and changed native settings',async t=>{
 const f=setup(t);
 const input={prompt:'direct',workspace:f.workspace,kind:'write',mode:'execute',profile:'director',routeId:'native',idempotencyKey:'director-replay-state',secretEnv:{PB_RELAY_TOKEN:'baton-original'}};
 const scope=await preflightScope(f.pool,{routeId:'native',workspace:f.workspace});
 f.store.savePreflight(scope.scope,{key:scope.key,status:'ready',capabilities:{},observedAt:new Date().toISOString()});
 const task=await f.pool.submitDirector(input);await until(()=>f.runs.length===1);
 f.config.routes[0].enabled=false;
 f.store.savePreflight(scope.scope,{key:'invalidated',status:'failed',capabilities:{},observedAt:new Date().toISOString()});
 const replay=await f.pool.submitDirector({...input,secretEnv:{PB_RELAY_TOKEN:'changed-secret'}});
 assert.equal(replay.id,task.id);assert.equal(f.runs.length,1);
 await assert.rejects(f.pool.submitDirector({...input,prompt:'different'}),{code:'IDEMPOTENCY_CONFLICT'});
});

test('task and exit hook insert atomically; hook failure never leaves a runnable orphan',async t=>{
 const f=setup(t);
 f.store.db.exec("CREATE TRIGGER reject_test_hook BEFORE INSERT ON exit_hooks BEGIN SELECT RAISE(ABORT, 'synthetic hook insert failure'); END");
 assert.throws(()=>f.submit('atomic-hook-test',{onExit:{argv:[process.execPath],timeoutSeconds:1}}),/synthetic hook insert failure/);
 assert.equal(f.store.byKey('atomic-hook-test'),undefined);assert.equal(f.store.queued().length,0);
});

test('cancelled/disabled queued preflight cleans nonces and permits a new forced probe',async t=>{
 const f=setup(t);
 const parent=f.submit('preflight-blocking-task');await until(()=>f.runs.length===1);
 const request={routeId:'native',workspace:f.workspace,capabilities:['poolMcp']};
 const [first,duplicate]=await Promise.all([f.pool.preflight(request),f.pool.preflight(request)]);
 assert.equal(first.id,duplicate.id,'concurrent discovery creates one probe');
 assert.equal(f.pool.get(first.id).state,'queued');
 f.pool.cancel(first.id);
 assert.equal(f.pool.probes.size,0);assert.equal(f.pool.nonces.size,0);
 assert.equal(f.pool.get(first.id).preflight.ready,false);
 const second=await f.pool.preflight({...request,force:true});assert.notEqual(first.id,second.id);
 f.config.routes[0].enabled=false;f.pool.schedule();await until(()=>f.pool.get(second.id).error==='ROUTE_DISABLED');
 assert.equal(f.pool.probes.size,0);assert.equal(f.pool.nonces.size,0);
 f.pool.cancel(parent.id);
});

test('stopOnQuotaBarrierPercent triggers QUOTA_BARRIER cancellation when route quota reaches barrier', async t => {
 const f = setup(t);
 f.store.saveQuota('native', { status: 'available', observedAt: new Date().toISOString(), windows: [{ remainingPercent: 12 }] });
 const task = f.submit('quota-barrier-test', { stopOnQuotaBarrierPercent: 10 });
 await until(() => f.runs.length === 1);
 f.advance(1000); await f.pool.watchdog.tick();
 assert.equal(f.pool.get(task.id).state, 'running');
 f.store.saveQuota('native', { status: 'available', observedAt: new Date().toISOString(), windows: [{ remainingPercent: 9 }] });
 f.advance(1000); await f.pool.watchdog.tick();
 await until(() => f.pool.get(task.id).state === 'cancelled');
 assert.equal(f.pool.get(task.id).error, 'QUOTA_BARRIER');
 assert.ok(f.pool.get(task.id).events.some(e => e.kind === 'quota_barrier'));
});

test('supersedesTaskId cancels predecessor director when successor is queued past deadline', async t => {
 const f = setup(t);
 const first = f.submit('pred-task-1');
 await until(() => f.runs.length === 1);
 const second = f.submit('succ-task-1', { supersedesTaskId: first.id });
 assert.equal(f.pool.get(second.id).state, 'queued');
 f.advance(95000); await f.pool.watchdog.tick();
 await until(() => f.pool.get(first.id).state === 'cancelled');
 assert.equal(f.pool.get(first.id).error, 'SUPERSEDED_BY_HANDOFF');
});

test('hook parses CAP_WAKE_AT and CAP_RETRY_AFTER on exit 75 for extended schedule', async t => {
 const wake = new Date(Date.now() + 120_000).toISOString();
 const f = setup(t, { watchdog: { runHook: () => ({ done: Promise.resolve({ code: 75, output: `CAP_WAKE_AT ${wake}\nCAP_RETRY_AFTER 120` }) }) } });
 const task = f.submit('hook-wake-test', { onExit: { argv: [process.execPath], timeoutSeconds: 1 } });
 await until(() => f.runs.length === 1);
 f.runs[0].finish({ result: report });
 await until(() => f.store.hook(task.id)?.attempts === 1);
 const hook = f.store.hook(task.id);
 assert.equal(hook.state, 'pending');
 assert.ok(hook.next_at >= Date.now() + 60_000);
});
