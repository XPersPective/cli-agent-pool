import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { taskKinds, toolSupport, capabilityLabel } from '../web/capabilities.js';
import { configSchema } from '../src/config.js';
import { Pool } from '../src/pool.js';
import { Store } from '../src/store.js';
import { buildArguments, execute } from '../src/adapters.js';

test('native CLI capability is independent of stale text-only model inventory; explicit limits still apply',async t=>{
 const model={id:'m',alias:'Model',group:'low',kinds:['text']};
 for(const adapter of ['codex','claude','qwen','agy','mcode','kimi','opencode','mimo','zcode']){
  const route={adapter};assert.deepEqual(taskKinds(route,model),['text','read','write']);
  assert.deepEqual(taskKinds({...route,toolPolicy:'configured'},model),['text']);
  assert.match(capabilityLabel(route,model),/okuma \/ yazma/);
 }
 for(const adapter of ['mmx','ollama','lmstudio','omniroute']){
  assert.equal(toolSupport({adapter}),'chat-cli');assert.deepEqual(taskKinds({adapter},{kinds:['text','read','write']}),['text']);
 }
 const config=configSchema.parse({routes:[{id:'q',adapter:'qwen',enabled:true,billing:'subscription',executable:process.execPath,models:[model]}]});
 const store=new Store(':memory:');const pool=new Pool(config,store);
 t.after(async()=>{await pool.close();store.close();});
 assert.equal(pool.select({kind:'write',mode:'execute',group:'low'}).selected.id,'m');
 assert.deepEqual(pool.models()[0].configuredKinds,['text']);
 config.routes[0].toolPolicy='configured';assert.throws(()=>pool.select({kind:'write',mode:'execute'}),{code:'NO_ROUTE'});
});

test('Qwen runs native file tools in write mode and Antigravity retains plan/accept-edits without disabling workspace skills',async t=>{
 const root=mkdtempSync(path.join(tmpdir(),'pool-qwen-write-'));t.after(()=>rm(root,{recursive:true,force:true,maxRetries:10,retryDelay:100}));
 const cli=path.join(root,'qwen.cjs');
 writeFileSync(path.join(root,'input.txt'),'read value');
 writeFileSync(cli,`const fs=require('node:fs');let input='';process.stdin.on('data',c=>input+=c).on('end',()=>{const a=process.argv;if(a[a.indexOf('--approval-mode')+1]!=='auto-edit'||!input.includes('subagent protocol v1'))process.exit(2);fs.writeFileSync('output.txt',fs.readFileSync('input.txt','utf8')+' edited');const r={status:'completed',summary:'Edited',files:[{path:'output.txt',change:'Created'}],checks:[],research:[],blockers:[]};console.log(JSON.stringify({type:'result',is_error:false,result:JSON.stringify(r)}));});`);
 const task={kind:'write',mode:'execute',prompt:'Read and edit',workspace:root,timeoutSeconds:5};
 const result=await execute({adapter:'qwen',executable:cli},{id:'m'},task,process.platform==='win32'?'python':'python3',()=>{}).done;
 assert(!result.error);assert.equal(readFileSync(path.join(root,'output.txt'),'utf8'),'read value edited');
 for(const kind of ['read','write']){
  const args=buildArguments({adapter:'agy',executable:process.execPath},{id:'m'},{...task,kind});
  assert(args.includes(kind==='write'?'accept-edits':'plan'));assert(!args.includes('--disable-slash-commands'));assert(!args.includes('--dangerously-skip-permissions'));
 }
 const qRead=buildArguments({adapter:'qwen',executable:process.execPath},{id:'m'},{...task,kind:'read'});assert(qRead.includes('plan'));
});
