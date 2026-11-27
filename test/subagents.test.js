import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,readFileSync} from 'node:fs';
import {rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {Store} from '../src/store.js';
import {Pool} from '../src/pool.js';
import {configSchema} from '../src/config.js';
import {buildArguments,execute} from '../src/adapters.js';
import {waitForTask,compactTask,taskPrompt} from '../src/task-protocol.js';
// These fixtures model workers that changed files: each fingerprint differs.
const changedWorkspace = () => { let n = 0; return async () => `changed:${++n}`; };

async function fixture(t, executeTask) {
 const root=mkdtempSync(path.join(tmpdir(),'pool-subagents-'));
 const config=configSchema.parse({concurrency:32,routes:[{id:'test',adapter:'codex',executable:process.execPath,enabled:true,billing:'subscription',models:[{id:'model',alias:'Model',group:'medium',kinds:['text','read','write']}]}]});
 const store=new Store(':memory:');
 const pool=new Pool(config,store,{directory:root,checkAuth:async()=>{},execute:executeTask,fingerprint:changedWorkspace()});
 t.after(async()=>{await pool.close();store.close();await rm(root,{recursive:true,force:true,maxRetries:10,retryDelay:100});});
 const submit=(key,kind='read',extra={})=>pool.submit({prompt:'implement',workspace:root,kind,idempotencyKey:`subagent-${key}`, ...extra});
 return {root,pool,store,submit};
}

test('readers and writers share a project concurrently with zero workspace queueing',async t=>{
 const pending=[];
 const {pool,submit}=await fixture(t,()=>({cancel(){},done:new Promise(resolve=>pending.push(resolve))}));
 const readers=Array.from({length:64},(_,i)=>submit(`reader-${i}`));
 const writer=submit('writer','write');
 const writer2=submit('writer2','write');
 const late=submit('late-reader');
 await delay(40);
 assert.equal(pending.length,67);
 assert.equal(pool.get(writer.id).state,'running');
 assert.equal(pool.get(writer2.id).state,'running');
 assert.equal(pool.get(late.id).state,'running');
 assert.equal(pool.get(late.id).blockedBy,null);
 for(const resolve of pending.splice(0))resolve({result:'done'});
 await Promise.all([...readers,writer,writer2,late].map(async item=>{for(let i=0;i<100&&pool.get(item.id).state!=='succeeded';i++)await delay(10);assert.equal(pool.get(item.id).state,'succeeded');}));
});

test('execute requires write and a tool capable adapter; write errors end in failed without quarantine',async t=>{
 const {pool,submit}=await fixture(t,()=>({cancel(){},done:Promise.reject(new Error('worker lost'))}));
 assert.throws(()=>submit('bad-mode','read',{mode:'execute'}),{code:'INVALID_REQUEST'});
 assert.deepEqual(pool.models()[0].executionModes,['execute']);
 const task=submit('write','write',{mode:'execute'});await delay(40);
 assert.equal(pool.get(task.id).state,'failed');
 const later=submit('not-blocked');await delay(40);
 assert.equal(pool.get(later.id).queueReason,null);
 assert.equal(pool.get(later.id).state,'failed');
 pool.config.routes[0].adapter='ollama';
 assert.throws(()=>submit('no-tools','write',{mode:'execute'}),{code:'NO_ROUTE'});
});

test('queue wait is independent of worker timeout and returns resumable state instead of false failure',async()=>{
 let clock=0,call=0;
 const result=await waitForTask(async()=>({id:'one',state:++call<4?'queued':'succeeded',result:'done'}),'one',{waitSeconds:20,now:()=>clock,sleep:async()=>{clock+=5000;}});
 assert.equal(result.state,'succeeded');
 const waiting=await waitForTask(async()=>({id:'two',state:'queued'}),'two',{waitSeconds:1,now:()=>clock,sleep:async()=>{clock+=1000;}});
 assert.equal(waiting.state,'queued');assert.equal(waiting.waitExpired,true);assert.equal(waiting.resume.arguments.taskId,'two');
});

test('execution exposes commands without bypass flags and compact response omits duplicated prompt/events',()=>{
 const task={prompt:'fix',workspace:tmpdir(),kind:'write',mode:'execute'};
 const claude=buildArguments({adapter:'claude',executable:process.execPath},{id:'model'},task);
 assert(claude.includes('default'));assert(!claude.includes('--dangerously-skip-permissions'));
 const codex=buildArguments({adapter:'codex',executable:process.execPath},{id:'model'},task);
 assert(codex.includes('workspace-write'));assert(!codex.includes('danger-full-access'));
 const zcode=buildArguments({adapter:'zcode',executable:process.execPath},{id:'zcode-default'},task);
 assert(!zcode.includes('--disallowed-tools'));assert(taskPrompt(task).includes('actual pass/fail'));
 const compact=compactTask({id:'task',prompt:'private',events:[{}],result:'x'.repeat(7000),error:null});
 assert(!('prompt' in compact));assert(!('events' in compact));assert.equal(compact.reportTruncated,false);assert.equal(compact.result.length,7000);
});

test('execution protocol reaches a supervised CLI that really edits a file and runs a check',async t=>{
 const root=mkdtempSync(path.join(tmpdir(),'pool-real-edit-'));
 t.after(()=>rm(root,{recursive:true,force:true,maxRetries:10,retryDelay:100}));
 const cli=path.join(root,'worker.cjs');
 writeFileSync(cli,`const fs=require('node:fs');let input='';process.stdin.on('data',c=>input+=c).on('end',()=>{if(!input.includes('[CLI Agent Pool subagent protocol v1]'))process.exit(2);fs.writeFileSync('output.txt','implemented');require('node:assert/strict').equal(fs.readFileSync('output.txt','utf8'),'implemented');console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:JSON.stringify({status:'completed',summary:'Implemented output',files:[{path:'output.txt',change:'Created'}],checks:[{command:'content check',outcome:'passed'}],research:[],blockers:[]})}}));console.log(JSON.stringify({type:'turn.completed'}));});`);
 const outcome=await execute({adapter:'codex',executable:cli},{id:'model'},{prompt:'Write output.txt',workspace:root,kind:'write',mode:'execute',timeoutSeconds:10},process.platform==='win32'?'python':'python3',()=>{}).done;
 assert.equal(outcome.error,undefined);assert.equal(readFileSync(path.join(root,'output.txt'),'utf8'),'implemented');assert(outcome.result.includes('passed'));
});


test('structured execution report distinguishes completed, blocked and missing report without losing output',async t=>{
 const report={status:'completed',summary:'Changed one file',files:[{path:'a.txt',change:'Updated'}],checks:[{command:'node --test',outcome:'passed'}],research:[{source:'https://example.test/doc',finding:'Checked API'}],blockers:[]};
 let answer=JSON.stringify(report);
 const {pool,submit}=await fixture(t,()=>({cancel(){},done:Promise.resolve({result:answer})}));
 const complete=submit('report-complete','write',{mode:'execute'});await delay(40);
 assert.equal(pool.get(complete.id).state,'succeeded');assert.deepEqual(pool.get(complete.id).report,report);
 const compact=compactTask(pool.get(complete.id));assert(!('result' in compact));assert.deepEqual(compact.report.files,report.files);
 assert.throws(()=>submit('response-write','write',{mode:'response'}),{code:'INVALID_REQUEST'});
 answer=JSON.stringify({...report,status:'blocked',blockers:['Permission required']});
 const blocked=submit('report-blocked','write',{mode:'execute'});await delay(40);
 assert.equal(pool.get(blocked.id).error,'WORK_INCOMPLETE');assert.equal(pool.get(blocked.id).state,'failed');assert.equal(pool.get(blocked.id).report.blockers[0],'Permission required');
 answer='I did it';const invalid=submit('report-invalid','write',{mode:'execute'});await delay(40);
 assert.equal(pool.get(invalid.id).error,'INVALID_REPORT');assert.equal(pool.get(invalid.id).result,'I did it');assert.equal(pool.get(invalid.id).state,'failed');
});

test('cancelling one concurrent task does not disrupt other tasks in the same workspace',async t=>{
 const pending=[];
 const {pool,submit}=await fixture(t,()=>({cancel(){},done:new Promise(resolve=>pending.push(resolve))}));
 const first=submit('first-reader');
 const writer=submit('cancelled-writer','write');
 const later=submit('later-reader');
 await delay(30);
 assert.equal(pool.get(first.id).state,'running');
 assert.equal(pool.get(writer.id).state,'running');
 assert.equal(pool.get(later.id).state,'running');
 pool.cancel(writer.id);
 pending[1]({error:'CANCELLED'});
 pending[0]({result:'read'});
 pending[2]({result:'read'});
 await delay(30);
 assert.equal(pool.get(writer.id).state,'cancelled');
 assert.equal(pool.get(later.id).state,'succeeded');
});

test('permission diagnostics survive compact polling without blocking subsequent writers', async t => {
 const report=JSON.stringify({status:'blocked',summary:'Denied',files:[],checks:[],research:[],blockers:['run_command git status denied']});
 const {pool,submit}=await fixture(t,()=>({cancel(){},done:Promise.resolve({error:'PERMISSION_REQUIRED',detail:'run_command: git status denied by owner rule',result:report})}));
 const first=submit('denied','write',{mode:'execute'});await delay(40);
 const blocked=compactTask(pool.get(first.id,999999));
 assert.equal(blocked.errorDetail,'run_command: git status denied by owner rule');
 assert.equal(blocked.report.status,'blocked');assert.equal(blocked.state,'failed');
 const later=submit('later','write',{mode:'execute'});await delay(40);
 assert.equal(pool.get(later.id).blockedBy,null);
 assert.equal(pool.get(later.id).state,'failed');
});
