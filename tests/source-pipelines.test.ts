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
