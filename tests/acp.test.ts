import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,rm,writeFile,symlink} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import {DaemonServer} from '../src/daemon/server';
import {DaemonConnection} from '../src/main/connection';
import {AcpClientTools} from '../src/daemon/acp-client-tools';
import type {AgentDefinition,Session,Run,State} from '../src/shared/protocol';
import type {AcpSnapshot} from '../src/shared/acp';

const executable=process.execPath,fixtureFile=path.resolve('tests/fixtures/acp-agent.cjs');
async function until<T>(read:()=>Promise<T>,predicate:(value:T)=>boolean,ms=15000){const end=Date.now()+ms;let value:T;do{value=await read();if(predicate(value))return value;await new Promise(resolve=>setTimeout(resolve,30));}while(Date.now()<end);throw new Error('Condition timed out: '+JSON.stringify(value));}
async function fixture(t:any,args:string[]=[]){
  const dir=await mkdtemp(path.join(os.tmpdir(),'berth-acp-')),root=path.join(dir,'project'),data=path.join(dir,'data');await mkdir(root);await mkdir(path.join(dir,'agent'));
  const server=new DaemonServer(data),connection=await DaemonConnection.open(await server.listen(),()=>{});
  const config={name:'Fixture ACP',command:executable,acp:{executable,args:[fixtureFile,path.join(dir,'agent'),...args],env:{ELECTRON_RUN_AS_NODE:'1'}}};
  const agent=await connection.rpc<AgentDefinition>('createAgent',config),project=await connection.rpc<any>('createProject',{name:'ACP project',path:root});
  const session=await connection.rpc<Session>('createSession',{projectId:project.id,title:'ACP conversation',agent:agent.id,command:''});
  t.after(async()=>{connection.close();await server.close();await rm(dir,{recursive:true,force:true,maxRetries:8,retryDelay:100});});
  const snapshot=()=>connection.rpc<AcpSnapshot>('acpSnapshot',{sessionId:session.id}),send=(text:string,requestId=randomUUID())=>connection.rpc<any>('acpSend',{sessionId:session.id,requestId,text});
  return {dir,root,data,server,connection,agent,project,session,snapshot,send};
}
test('ACP sends once, streams structured output, switches models and restores the same native session without replay',async t=>{
  const f=await fixture(t),requestId=randomUUID();await f.send('hello',requestId);await f.send('hello',requestId);
  const first=await until(f.snapshot,value=>value.phase==='ready');assert.equal(first.events.filter(event=>event.kind==='user').length,1);assert.equal(first.events.filter(event=>event.kind==='assistant').map(event=>event.text).join(''),'hello from small');assert.ok(first.nativeSessionId);
  await f.connection.rpc('acpConfigure',{sessionId:f.session.id,configId:'model',value:'large'});await f.send('next');await until(f.snapshot,value=>value.phase==='ready'&&value.events.filter(event=>event.kind==='user').length===2);
  await assert.rejects(f.connection.rpc('deleteSession',{sessionId:f.session.id}),/断开 Agent/);
  await f.connection.rpc('stop',{sessionId:f.session.id});const count=(await f.snapshot()).events.length;
  await f.connection.rpc('start',{sessionId:f.session.id,resume:true,cols:100,rows:30});const resumed=await f.snapshot();assert.equal(resumed.nativeSessionId,first.nativeSessionId);assert.equal(resumed.events.length,count);assert.ok(!resumed.events.some(event=>event.text.includes('REMOTE_REPLAY')));
  const log=(await readFile(path.join(f.dir,'agent','calls.jsonl'),'utf8')).trim().split('\n').map(line=>JSON.parse(line));assert.equal(log.filter(item=>item.method==='prompt').length,2);assert.equal(log.filter(item=>item.method==='load').length,1);
});
test('ACP relays permissions, rejects foreign options and cancels every pending permission once',async t=>{
  const f=await fixture(t);await f.send('permission');const waiting=await until(f.snapshot,value=>value.permissions.length===1);
  await assert.rejects(f.connection.rpc('acpPermission',{sessionId:f.session.id,permissionId:waiting.permissions[0].id,optionId:'foreign'}),/无效的授权/);
  await f.connection.rpc('acpPermission',{sessionId:f.session.id,permissionId:waiting.permissions[0].id,optionId:'allow'});await until(f.snapshot,value=>value.phase==='ready');assert.equal(await readFile(path.join(f.root,'note.txt'),'utf8'),'ACP_WRITE_OK');
  await f.send('multiple-permissions');await until(f.snapshot,value=>value.permissions.length===2);await f.connection.rpc('acpCancel',{sessionId:f.session.id});await until(f.snapshot,value=>value.phase==='ready');
  const log=(await readFile(path.join(f.dir,'agent','calls.jsonl'),'utf8')).trim().split('\n').map(line=>JSON.parse(line));assert.deepEqual(log.find(item=>item.method==='permission-results').outcomes.map((value:any)=>value.outcome.outcome),['cancelled','cancelled']);
});
test('ACP supports a long streaming turn, explicit cancellation and paginated output independent of terminal size',async t=>{
  const f=await fixture(t);await f.send('long');const streaming=await until(f.snapshot,value=>value.phase==='running'&&value.events.some(event=>event.kind==='assistant'));assert.ok(streaming.turnId);await assert.rejects(f.send('second'),/正在执行/);
  await f.connection.rpc('acpCancel',{sessionId:f.session.id});await until(f.snapshot,value=>value.phase==='ready');await f.send('paging');await until(f.snapshot,value=>value.phase==='ready');
  let after=0,output='',pages=0;while(true){const page=await f.connection.rpc<AcpSnapshot>('acpSnapshot',{sessionId:f.session.id,after,limit:17});for(const event of page.events){after=event.sequence;if(event.kind==='assistant')output+=event.text;}pages++;if(!page.hasMore)break;}
  assert.ok(pages>7);assert.ok(output.includes('ROW-000'));assert.ok(output.includes('ROW-119'));
});
test('ACP client terminal methods return complete command output and release owned processes',async t=>{
  const f=await fixture(t);await f.send('terminal');const done=await until(f.snapshot,value=>value.phase==='ready');assert.ok(done.events.some(event=>event.text.includes('ACP_TERMINAL_OK')));
});
test('ACP authentication and a provider without loadSession are negotiated honestly',async t=>{
  const f=await fixture(t,['--auth','--no-load']);await f.connection.rpc('start',{sessionId:f.session.id,cols:100,rows:30});assert.equal((await f.snapshot()).phase,'error');await f.connection.rpc('acpAuthenticate',{sessionId:f.session.id,methodId:'login'});assert.equal((await f.snapshot()).phase,'ready');
  const first=(await f.snapshot()).nativeSessionId;await f.connection.rpc('stop',{sessionId:f.session.id});await f.connection.rpc('start',{sessionId:f.session.id,cols:100,rows:30});await f.connection.rpc('acpAuthenticate',{sessionId:f.session.id,methodId:'login'});assert.notEqual((await f.snapshot()).nativeSessionId,first);assert.ok((await f.snapshot()).events.some(event=>event.text.includes('未声明 session/load')));
});
test('ACP disconnect preserves partial output, marks unknown turns and never automatically resubmits them',async t=>{
  const f=await fixture(t),requestId=randomUUID();await f.send('disconnect',requestId);await until(f.snapshot,value=>value.phase==='disconnected');const output=await f.snapshot();assert.ok(output.events.some(event=>event.text.includes('partial before disconnect')));
  const duplicate=await f.send('disconnect',requestId);assert.equal(duplicate.duplicate,true);const log=await readFile(path.join(f.dir,'agent','calls.jsonl'),'utf8');assert.equal(log.split('\n').filter(line=>line.includes('"method":"prompt"')).length,1);
});
test('ACP filesystem requests stay inside the canonical workspace, including symlink targets',async t=>{
  const dir=await mkdtemp(path.join(os.tmpdir(),'berth-acp-files-')),root=path.join(dir,'root'),outside=path.join(dir,'outside');await mkdir(root);await mkdir(outside);const tools=new AcpClientTools(root);t.after(async()=>{await tools.close();await rm(dir,{recursive:true,force:true});});
  await assert.rejects(tools.call('fs/write_text_file',{path:path.join(outside,'no.txt'),content:'no'}),/工作区/);
  await tools.call('fs/write_text_file',{path:path.join(root,'sub','ok.txt'),content:'one\ntwo\nthree'});assert.deepEqual(await tools.call('fs/read_text_file',{path:path.join(root,'sub','ok.txt'),line:2,limit:1}),{content:'two'});
  if(process.platform!=='win32'){const alias=path.join(dir,'workspace-alias');await symlink(root,alias);const aliased=new AcpClientTools(alias);await aliased.call('fs/write_text_file',{path:path.join(alias,'alias.txt'),content:'SAME_WORKSPACE'});assert.equal(await readFile(path.join(root,'alias.txt'),'utf8'),'SAME_WORKSPACE');await aliased.close();await symlink(outside,path.join(root,'link'));await assert.rejects(tools.call('fs/write_text_file',{path:path.join(root,'link','no.txt'),content:'no'}),/工作区/);}
});


test('Windows ACP resolves and runs a batch launcher through the same bidirectional protocol', {skip:process.platform!=='win32'}, async t=>{
  const f=await fixture(t),shim=path.join(f.dir,'adapter shim.cmd');
  await writeFile(shim,'@echo off\r\n"'+process.execPath+'" "'+path.resolve('tests/fixtures/acp-agent.cjs')+'" %*\r\n');
  await f.connection.rpc('updateAgent',{agentId:f.agent.id,name:f.agent.name,command:shim,acp:{executable:shim,args:[path.join(f.dir,'agent')],env:{ELECTRON_RUN_AS_NODE:'1'}}});
  await f.send('hello');const output=await until(f.snapshot,value=>value.phase==='ready');assert.ok(output.events.some(event=>event.text.includes('from small')));
});
