import {test} from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {pipelineStore,type SourcePipeline} from '../src/superagent/pipelines';

test('legacy source configuration migrates once; deleting it does not recreate it after reload',()=>{
  const db=new DatabaseSync(':memory:');try{
    db.exec('CREATE TABLE source_policies(id TEXT PRIMARY KEY,value TEXT NOT NULL)');
    const legacy={enabled:true,projectId:'project',coordinatorId:'coord',executorId:'exec',allowedActors:[],autoApprove:false,isolated:true,version:'old'};
    db.prepare('INSERT INTO source_policies VALUES (?,?)').run('plugin/source',JSON.stringify(legacy));
    const store=pipelineStore(db);assert.equal(store.list().length,1);assert.deepEqual(store.list()[0].allowedActors,[]);assert.equal(store.list()[0].sourceId,'plugin/source');assert.equal(store.list()[0].version,'old');
    store.delete(store.list()[0].id);assert.equal(pipelineStore(db).list().length,0);
  }finally{db.close();}
});
test('pipelines accept multiple sources and intentional fanout, with independent source scopes and actor filters',()=>{
  const db=new DatabaseSync(':memory:');try{
    db.exec('CREATE TABLE source_policies(id TEXT PRIMARY KEY,value TEXT NOT NULL)');const store=pipelineStore(db),base:SourcePipeline={id:'a',name:'A',sourceId:'source',enabled:true,projectId:'p',coordinatorId:'c',executorId:'e',allowedActors:['alice'],threadIds:['thread-a'],autoApprove:false,isolated:true,version:'v',createdAt:'now',updatedAt:'now'};
    store.save(base);store.save({...base,id:'b',name:'B',inputs:[{sourceId:'source',threadIds:['thread-a']},{sourceId:'second',threadIds:['thread-b']}]});store.save({...base,id:'draft',enabled:false});
    const event={id:'x',title:'x',text:'x',threadId:'thread-a',actorId:'alice'};assert.deepEqual(store.match('source',event).pipelines.map(item=>item.id),['a','b']);assert.deepEqual(store.match('second',{...event,threadId:'thread-b'}).pipelines.map(item=>item.id),['b']);assert.equal(store.match('source',{...event,actorId:'carol'}).reason,'actor_not_allowed');assert.equal(store.match('source',{...event,threadId:'elsewhere'}).reason,'no_matching_pipeline');
    store.save({...base,workspacePath:'/owned'});store.save({...base,name:'Renamed'});assert.equal(store.get(base.id)?.workspacePath,'/owned');assert.throws(()=>store.save({...base,projectId:'other'}),/不能更换项目/);
  }finally{db.close();}
});

test('fanout admission retries only failed frozen subscribers, survives reload and strips event bodies from receipts',async()=>{
  const {sourceAdmission,receiptView}=await import('../src/superagent/admission');const db=new DatabaseSync(':memory:');try{
    db.exec('CREATE TABLE source_policies(id TEXT PRIMARY KEY,value TEXT NOT NULL);CREATE TABLE source_events(source TEXT,eventId TEXT,value TEXT,PRIMARY KEY(source,eventId))');const store=pipelineStore(db);
    const base:SourcePipeline={id:'a',name:'A',sourceId:'source',enabled:true,projectId:'p',coordinatorId:'c',executorId:'e',allowedActors:[],threadIds:[],autoApprove:false,isolated:true,version:'v',createdAt:'now',updatedAt:'now'};store.save(base);store.save({...base,id:'b',name:'B'});
    const calls:string[]=[],tasks=new Map<string,string>();let fail=true;
    const create=async(policy:SourcePipeline)=>{calls.push(policy.id);if(policy.id==='b'&&fail)throw new Error('Missing Agent');if(!tasks.has(policy.id))tasks.set(policy.id,'ticket-'+policy.id);return {id:tasks.get(policy.id)!,duplicate:false};};
    const event={id:'event',title:'Request',text:'private body',threadId:'thread',actorId:'alice'},admission=sourceAdmission(db,store,create,()=>true);
    const results=await Promise.allSettled([admission.emit('source',event),admission.emit('source',event)]);assert.ok(results.every(item=>item.status==='rejected'));assert.deepEqual(calls,['a','b']);
    const saved=JSON.parse(String(db.prepare('SELECT value FROM source_events').get()!.value));assert.equal(saved.receipt.deliveries[0].ticketId,'ticket-a');assert.equal(JSON.stringify(receiptView(saved)).includes('private body'),false);assert.equal(JSON.stringify(receiptView(saved)).includes('coordinatorId'),false);
    store.save({...base,id:'new'});fail=false;const reloaded=sourceAdmission(db,store,create,()=>true),receipt=await reloaded.retry('source',event.id);assert.deepEqual(calls,['a','b','b']);assert.deepEqual(receipt.ticketIds,['ticket-a','ticket-b']);assert.equal(receipt.duplicate,true);assert.equal(JSON.parse(String(db.prepare('SELECT value FROM source_events').get()!.value)).event,undefined);
    await reloaded.emit('source',{...event,text:'changed'});assert.deepEqual(calls,['a','b','b']);
  }finally{db.close();}
});

test('source discovery supplies bounded named scopes and stops when its plugin is disposed',async()=>{
  const {SuperagentSources}=await import('../src/superagent/sources');const controller=new AbortController(),sources=new SuperagentSources('superagent',async()=>({accepted:false,duplicate:false}));
  const handle=sources.register('custom',{id:'inbox',name:'Inbox',listThreads:async()=>[{id:'room-a',name:'产品群'},{id:'room-a',name:'产品群'}]},controller.signal);
  assert.equal(sources.snapshot()[0].canListThreads,true);assert.deepEqual(await sources.listThreads('custom/inbox'),{available:true,threads:[{id:'room-a',name:'产品群'}]});handle.dispose();await assert.rejects(sources.listThreads('custom/inbox'),/未启用/);
  sources.register('custom',{id:'invalid',name:'Invalid',listThreads:async()=>[{id:'',name:'invalid'}]},controller.signal);await assert.rejects(sources.listThreads('custom/invalid'));
  controller.abort();await assert.rejects(sources.listThreads('custom/invalid'),/未启用/);
});

test('pipeline keyword rules persist independently, honor exclusion priority and preserve unfiltered legacy routes',()=>{
  const db=new DatabaseSync(':memory:');try{
    db.exec('CREATE TABLE source_policies(id TEXT PRIMARY KEY,value TEXT NOT NULL)');const store=pipelineStore(db);
    const base:SourcePipeline={id:'any',name:'Any',sourceId:'source',threadIds:[],enabled:true,projectId:'p',coordinatorId:'c',executorId:'e',allowedActors:[],autoApprove:false,isolated:true,version:'v',createdAt:'now',updatedAt:'now'};
    store.save({...base,filter:{includeKeywords:['BUG','修复'],excludeKeywords:['草稿'],mode:'any',caseSensitive:false}});
    store.save({...base,id:'all',filter:{includeKeywords:['bug','修复'],excludeKeywords:[],mode:'all',caseSensitive:true}});store.save({...base,id:'legacy'});
    const event={id:'x',title:'bug',text:'修复问题',threadId:'room',actorId:'alice'};
    assert.deepEqual(store.match('source',event).pipelines.map(item=>item.id),['any','all','legacy']);
    assert.deepEqual(store.match('source',{...event,text:'草稿：修复'}).pipelines.map(item=>item.id),['all','legacy']);
    assert.deepEqual(store.match('source',{...event,title:'BUG',text:'other'}).pipelines.map(item=>item.id),['any','legacy']);
    assert.deepEqual(store.match('source',{...event,title:'other',text:'other'}).filtered.map(item=>item.id),['any','all']);
    assert.deepEqual(pipelineStore(db).get('any')?.filter,store.get('any')?.filter);
    assert.throws(()=>store.save({...base,filter:{includeKeywords:[' '],excludeKeywords:[],mode:'any',caseSensitive:false}}));
  }finally{db.close();}
});

test('source pipeline schemas validate defaults, unknown fields, required values and runtime matcher results',async()=>{
  const {SuperagentSources}=await import('../src/superagent/sources');const controller=new AbortController(),sources=new SuperagentSources('superagent',async()=>({accepted:false,duplicate:false}));
  sources.register('custom',{id:'rules',name:'Rules',pipelineConfigSchema:{channel:{type:'string',title:'频道',required:true},enabled:{type:'boolean',title:'启用',default:true},limit:{type:'number',title:'数量',minimum:0,maximum:10,default:0},mode:{type:'string',title:'模式',enum:['a','b'],default:'a'}},match:(_event,context)=>context.config.channel==='one'},controller.signal);
  assert.equal(sources.snapshot()[0].pipelineConfigSchema?.channel.required,true);
  assert.deepEqual(sources.resolveConfig('custom/rules',{channel:'one',enabled:false,limit:0}),{channel:'one',enabled:false,limit:0,mode:'a'});
  const invalidConfigs:Record<string,string|number|boolean>[]=[{},{channel:' '},{channel:'one',limit:11},{channel:'one',mode:'c'},{channel:'one',unknown:true}];for(const config of invalidConfigs)assert.throws(()=>sources.resolveConfig('custom/rules',config));
  const event={id:'x',title:'x',text:'x',threadId:'t',actorId:'a'};
  assert.equal(await sources.matches('custom/rules',event,{pipelineId:'p',pipelineName:'P',config:{channel:'one'}}),true);
  assert.equal(await sources.matches('custom/rules',event,{pipelineId:'q',pipelineName:'Q',config:{channel:'two'}}),false);
  assert.throws(()=>sources.register('custom',{id:'invalid',name:'Invalid',pipelineConfigSchema:{count:{type:'number',title:'Count',default:'bad'}}},controller.signal),/管道配置/);
  sources.register('custom',{id:'invalid-result',name:'Invalid result',match:()=>undefined as unknown as boolean},controller.signal);
  await assert.rejects(sources.matches('custom/invalid-result',event,{pipelineId:'p',pipelineName:'P',config:{}}),/boolean/);
  let entered!:()=>void;const started=new Promise<void>(resolve=>entered=resolve);sources.register('custom',{id:'slow',name:'Slow',match:()=>{entered();return new Promise(()=>{});}},controller.signal);
  const waiting=sources.matches('custom/slow',event,{pipelineId:'p',pipelineName:'P',config:{}});await started;controller.abort();await assert.rejects(waiting,/来源已停止/);
});

test('custom pipeline filters isolate fanout, freeze per-source config and retry only failures after reload',async()=>{
  const {sourceAdmission}=await import('../src/superagent/admission');const {pipelineInputs}=await import('../src/superagent/pipelines');const {SuperagentSources}=await import('../src/superagent/sources');
  const db=new DatabaseSync(':memory:');try{
    db.exec('CREATE TABLE source_policies(id TEXT PRIMARY KEY,value TEXT NOT NULL);CREATE TABLE source_events(source TEXT,eventId TEXT,value TEXT,PRIMARY KEY(source,eventId))');const store=pipelineStore(db);
    const base:SourcePipeline={id:'a',name:'A',sourceId:'custom/inbox',threadIds:[],inputs:[{sourceId:'custom/inbox',threadIds:[],config:{accept:true,word:'fix'}}],enabled:true,projectId:'p',coordinatorId:'c',executorId:'e',allowedActors:[],autoApprove:false,isolated:true,version:'v',createdAt:'now',updatedAt:'now'};
    store.save(base);store.save({...base,id:'b',inputs:[{sourceId:'custom/inbox',threadIds:[],config:{accept:false,word:'fix'}}]});store.save({...base,id:'c'});store.save({...base,id:'keyword',filter:{includeKeywords:['unmatched'],excludeKeywords:[],mode:'any',caseSensitive:false}});
    let fail=true;const filtered:string[]=[],created:string[]=[],controller=new AbortController(),sources=new SuperagentSources('superagent',async()=>({accepted:false,duplicate:false}));
    sources.register('custom',{id:'inbox',name:'Inbox',pipelineConfigSchema:{accept:{type:'boolean',title:'Accept'},word:{type:'string',title:'Word'}},match:(event,context)=>{filtered.push(context.pipelineId);if(context.pipelineId==='c'&&fail)throw new Error('temporary matcher error');return !!context.config.accept&&event.text.includes(String(context.config.word));}},controller.signal);
    const create=async(policy:SourcePipeline)=>{created.push(policy.id);return {id:'ticket-'+policy.id,duplicate:false};},matches=(source:string,event:any,pipeline:SourcePipeline)=>sources.matches(source,event,{pipelineId:pipeline.id,pipelineName:pipeline.name,config:pipelineInputs(pipeline)[0].config!});
    const admission=sourceAdmission(db,store,create,()=>true,matches),event={id:'x',title:'Request',text:'fix this',threadId:'room',actorId:'alice'};
    await assert.rejects(admission.emit('custom/inbox',event),/部分管道接收失败/);assert.deepEqual(created,['a']);assert.deepEqual(filtered,['a','b','c']);
    store.save({...base,id:'c',inputs:[{sourceId:'custom/inbox',threadIds:[],config:{accept:false,word:'changed'}}]});store.save({...base,id:'new'});fail=false;
    const receipt=await sourceAdmission(db,store,create,()=>true,matches).retry('custom/inbox','x');assert.deepEqual(created,['a','c']);assert.deepEqual(filtered,['a','b','c','c']);assert.equal(receipt.deliveries?.find(item=>item.pipelineId==='b')?.filtered,true);assert.equal(receipt.deliveries?.find(item=>item.pipelineId==='keyword')?.filtered,true);assert.deepEqual(receipt.ticketIds,['ticket-a','ticket-c']);
    await admission.emit('custom/inbox',event);assert.deepEqual(created,['a','c']);
    store.delete('a');store.delete('c');store.delete('new');const rejected=await admission.emit('custom/inbox',{...event,id:'rejected'});assert.equal(rejected.accepted,false);assert.equal(rejected.reason,'filtered');
  }finally{db.close();}
});


test('disposing a source interrupts an in-flight pipeline match and cannot accept a late result',async()=>{
  const {SuperagentSources}=await import('../src/superagent/sources');const sources=new SuperagentSources('superagent',async()=>({accepted:false,duplicate:false}));
  let entered!:()=>void,finish!:(value:boolean)=>void;const started=new Promise<void>(resolve=>entered=resolve),controller=new AbortController();
  const handle=sources.register('custom',{id:'inbox',name:'Inbox',match:()=>{entered();return new Promise(resolve=>finish=resolve);}},controller.signal);
  const waiting=sources.matches('custom/inbox',{id:'x',title:'x',text:'x',threadId:'t',actorId:'a'},{pipelineId:'p',pipelineName:'P',config:{}});
  await started;handle.dispose();await assert.rejects(waiting,/来源已停止/);finish(true);assert.equal(sources.has('custom/inbox'),false);
});
