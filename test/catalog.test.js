import test from 'node:test';
import assert from 'node:assert/strict';
import { compactCatalog, categoryPage } from '../src/catalog.js';
import { configSchema } from '../src/config.js';
import { Pool } from '../src/pool.js';
import { Store } from '../src/store.js';
import { removeCategory } from '../web/categories.js';

test('agent catalog is pool-only and category-strict while owner catalogModels retains unassigned entries', t => {
  const store=new Store(':memory:');
  const config=configSchema.parse({selectionMode:'manual',groupingMode:'manual',modelFilters:[{match:'model',value:'hidden',routeId:'native'}],routes:[
    {id:'native',adapter:'agy',executable:process.execPath,billing:'subscription',enabled:true,autoSelect:false,models:[
      {id:'flash',alias:'Gemini Flash',group:'medium',kinds:['text'],efforts:['low','high'],memberships:[{group:'medium',effort:'high'},{group:'low',effort:'low'}]},
      {id:'outside',alias:'Outside',group:'unassigned',kinds:['text'],memberships:[]},
      {id:'hidden',alias:'Hidden',group:'low',kinds:['text']},
    ]},
    {id:'disabled',adapter:'agy',executable:process.execPath,billing:'subscription',enabled:false,models:[{id:'flash',alias:'Gemini',group:'low',kinds:['text']}]},
  ]});
  const pool=new Pool(config,store);t.after(()=>{clearInterval(pool.historyTimer);store.close();});pool.getQuota=()=>{throw Error('Discovery must not contact providers');};
  const overview=compactCatalog(pool);assert.equal(overview.total,1);assert(!('models' in overview));assert(overview.sources.length===1);
  const first=compactCatalog(pool,{view:'models',kind:'write',limit:1});assert.equal(first.total,1);assert.equal(first.nextOffset,null);assert.deepEqual(first.models[0].kinds,['text','read','write']);assert.equal(first.models[0].effort,undefined);assert.deepEqual(first.models[0].categories,['medium','low']);assert.equal(first.models[0].quota.status,'unknown');
  assert.equal(compactCatalog(pool,{query:'outside'}).total,0);
  assert.equal(pool.catalogModels().some(m=>m.id==='outside'),true);
  assert.equal(pool.pooledModels().some(m=>m.id==='outside'),false);
  assert(!('models' in categoryPage(pool)));assert.equal(categoryPage(pool,{group:'low'}).models[0].effort,'low');assert.equal(categoryPage(pool,{group:'medium'}).models[0].effort,'high');
  assert.throws(()=>pool.select({kind:'text',modelId:'outside'}),{code:'MODEL_NOT_IN_POOL'});
  assert.throws(()=>pool.select({kind:'text',routeId:'native',modelId:'outside'}),{code:'MODEL_NOT_IN_POOL'});
  assert.equal(pool.select({kind:'text',group:'medium',effort:'low'}).selected.id,'flash');
  assert.equal(compactCatalog(pool,{routeId:'disabled'}).total,0);assert.equal(compactCatalog(pool,{query:'hidden'}).total,0);assert.throws(()=>compactCatalog(pool,{limit:100}));
  assert.throws(()=>categoryPage(pool,{group:'absent'}),{code:'CATEGORY_NOT_FOUND'});
  store.saveQuota('native',{status:'available',scope:'model',observedAt:new Date().toISOString(),windows:[{models:['opus'],remainingPercent:0},{models:['flash'],remainingPercent:25,resetsAt:'soon'},{remainingPercent:80}]});
  assert.equal(compactCatalog(pool,{query:'flash'}).models[0].quota.remainingPercent,25);
  removeCategory(pool.config,'low');assert.equal(pool.config.categories.some(c=>c.id==='low'),false);assert.equal(pool.select({kind:'text',modelId:'flash'}).selected.id,'flash');assert.deepEqual(compactCatalog(pool,{query:'flash'}).models[0].categories,['medium']);
  assert.throws(()=>pool.select({kind:'text',group:'low'}),{code:'CATEGORY_NOT_FOUND'});
  removeCategory(pool.config,'medium');
  assert.equal(pool.catalogModels().some(m=>m.id==='flash'),true);
  assert.equal(pool.pooledModels().length,0);
  assert.throws(()=>pool.select({kind:'text',modelId:'flash'}),{code:'MODEL_NOT_IN_POOL'});
});

test('arbitrary named categories persist while removing a free membership blocks agent access but preserves owner catalog',t=>{
  const config=configSchema.parse({categories:[{id:'research',name:'Araştırma'},{id:'free',name:'Free'}],routes:[{id:'r',adapter:'custom',argsTemplate:['--version'],executable:process.execPath,billing:'free',enabled:true,models:Array.from({length:30},(_,i)=>({id:'m'+i,alias:'M'+i,group:'research',memberships:[{group:'research'}],kinds:['text']}))}]});
  const store=new Store(':memory:'),pool=new Pool(config,store);t.after(()=>{clearInterval(pool.historyTimer);store.close();});
  assert.equal(categoryPage(pool,{group:'free'}).total,0);assert.equal(categoryPage(pool,{group:'research'}).total,30);assert.equal(categoryPage(pool,{group:'research'}).models.length,12);
  const a=compactCatalog(pool,{billing:'free'}),b=compactCatalog(pool,{billing:'free',offset:a.nextOffset});assert.equal(a.models.length,12);assert.equal(b.models[0].modelId,'m12');assert.equal(new Set([...a.models,...b.models].map(m=>m.modelId)).size,24);
  assert(JSON.stringify(compactCatalog(pool)).length<1000);
  removeCategory(config,'research');assert.equal(pool.catalogModels().length,30);assert.equal(pool.pooledModels().length,0);assert.equal(config.routes[0].models[0].memberships.length,0);
  assert.throws(()=>pool.select({kind:'text',modelId:'m0'}),{code:'MODEL_NOT_IN_POOL'});
});

test('legacy provider labels do not become owner categories during migration',()=>{
 const config=configSchema.parse({selectionMode:'manual',routes:[{id:'r',adapter:'custom',argsTemplate:['--version'],executable:process.execPath,enabled:true,billing:'free',models:[{id:'m',alias:'M',group:'vendor-label',kinds:['text']}]}]});
 assert.deepEqual(config.categories.map(c=>c.id),['high','medium','low','free']);assert.deepEqual(config.routes[0].models[0].memberships,[]);assert(!('selectionMode' in config));
});
