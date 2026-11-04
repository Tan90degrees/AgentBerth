import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import {Store} from '../src/daemon/store';

test('feature ownership persists without its plugin, isolates retries and is deleted with the session',async()=>{
  const dir=await mkdtemp(path.join(os.tmpdir(),'berth-owner-'));let store=new Store(dir);
  try{
    const project=store.createProject('Owner project',dir),taskId=randomUUID(),sessionId=randomUUID();store.manageSessions('superagent',{kind:'superagent',taskId,projectId:project.id,sessionIds:[sessionId]});
    store.createSession(project.id,'Internal','codex','',null,null,null,sessionId);const normal=store.createSession(project.id,'Superagent · a user named session','codex','');assert.equal(normal.owner,undefined);store.close();store=new Store(dir);
    const restored=store.state().sessions.find(session=>session.id===sessionId)!;assert.equal(restored.owner?.pluginId,'superagent');assert.equal(restored.owner?.taskId,taskId);assert.equal(store.state().sessions.filter(session=>!session.owner).length,1);
    const other=store.createProject('Other',path.join(dir,'other'));assert.throws(()=>store.manageSessions('superagent',{kind:'superagent',taskId:randomUUID(),projectId:other.id,sessionIds:[normal.id]}),/其他项目/);assert.equal(store.session(normal.id).owner,undefined);
    store.deleteSession(sessionId);assert.equal(store.sessionOwner(sessionId),undefined);
  }finally{store.close();await rm(dir,{recursive:true,force:true});}
});
