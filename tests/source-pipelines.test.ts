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
test('route overlap checks thread and actor scopes, permits disjoint routes and disabled drafts',()=>{
  const db=new DatabaseSync(':memory:');try{
    db.exec('CREATE TABLE source_policies(id TEXT PRIMARY KEY,value TEXT NOT NULL)');const store=pipelineStore(db),base:SourcePipeline={id:'a',name:'A',sourceId:'source',enabled:true,projectId:'p',coordinatorId:'c',executorId:'e',allowedActors:['alice'],threadIds:['thread-a'],autoApprove:false,isolated:false,version:'v',createdAt:'now',updatedAt:'now'};
    store.save(base);store.save({...base,id:'b',name:'B',allowedActors:['bob']});store.save({...base,id:'c',name:'C',allowedActors:[],threadIds:['thread-b']});store.save({...base,id:'draft',enabled:false,allowedActors:[],threadIds:[]});
    assert.throws(()=>store.save({...base,id:'overlap',allowedActors:[]}),/管道「A」/);assert.throws(()=>store.save({...base,id:'draft',enabled:true,allowedActors:[],threadIds:[]}),/范围重叠/);
    const event={id:'x',title:'x',text:'x',threadId:'thread-a',actorId:'bob'};assert.equal(store.match('source',event).pipeline?.id,'b');assert.equal(store.match('source',{...event,actorId:'carol'}).reason,'actor_not_allowed');assert.equal(store.match('source',{...event,threadId:'elsewhere'}).reason,'no_matching_pipeline');
    // Defensive ambiguity detection also protects configurations written outside the UI.
    db.prepare('INSERT INTO source_pipelines VALUES (?,?)').run('bad',JSON.stringify({...base,id:'bad',allowedActors:[]}));assert.equal(store.match('source',{...event,actorId:'alice'}).reason,'ambiguous_pipeline');
  }finally{db.close();}
});

test('source discovery supplies bounded named scopes and stops when its plugin is disposed',async()=>{
  const {SuperagentSources}=await import('../src/superagent/sources');const controller=new AbortController(),sources=new SuperagentSources('superagent',async()=>({accepted:false,duplicate:false}));
  const handle=sources.register('custom',{id:'inbox',name:'Inbox',listThreads:async()=>[{id:'room-a',name:'产品群'},{id:'room-a',name:'产品群'}]},controller.signal);
  assert.equal(sources.snapshot()[0].canListThreads,true);assert.deepEqual(await sources.listThreads('custom/inbox'),{available:true,threads:[{id:'room-a',name:'产品群'}]});handle.dispose();await assert.rejects(sources.listThreads('custom/inbox'),/未启用/);
  sources.register('custom',{id:'invalid',name:'Invalid',listThreads:async()=>[{id:'',name:'invalid'}]},controller.signal);await assert.rejects(sources.listThreads('custom/invalid'));
  controller.abort();await assert.rejects(sources.listThreads('custom/invalid'),/未启用/);
});
