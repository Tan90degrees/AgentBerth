import {test} from 'node:test';
import {once} from 'node:events';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,realpath,rm,writeFile,symlink} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import {DaemonServer} from '../src/daemon/server';
import {DaemonConnection,connectDaemon} from '../src/main/connection';
import {AcpClientTools} from '../src/daemon/acp-client-tools';
import {AcpTransport,acpExecutable,acpCommand} from '../src/daemon/acp-transport';
import {resolveExecutable} from '../src/daemon/executables';
import type {AgentDefinition,Session,Run,State} from '../src/shared/protocol';
import {conversationGroups,toolState} from '../src/shared/acp-presentation';
import {acpStreamBlocks} from '../src/shared/acp-stream';
import type {AcpSnapshot} from '../src/shared/acp';

const executable=process.execPath,fixtureFile=path.resolve('tests/fixtures/acp-agent.cjs');
async function until<T>(read:()=>Promise<T>,predicate:(value:T)=>boolean,ms=15000){const end=Date.now()+ms;let value:T;do{value=await read();if(predicate(value))return value;await new Promise(resolve=>setTimeout(resolve,30));}while(Date.now()<end);throw new Error('Condition timed out: '+JSON.stringify(value));}
async function fixture(t:any,args:string[]=[],context=false,program=executable){
  const dir=await mkdtemp(path.join(os.tmpdir(),'berth-acp-')),root=path.join(dir,'project'),data=path.join(dir,'data');await mkdir(root);await mkdir(path.join(dir,'agent'));
  const events:import('../src/shared/protocol').ServerEvent[]=[];
  const server=new DaemonServer(data),connection=await DaemonConnection.open(await server.listen(),event=>events.push(event));
  const extra=path.join(dir,'explicit-context');
  if(context)await mkdir(extra);
  const config={name:'Fixture ACP',command:program,acp:{executable:program,args:[fixtureFile,path.join(dir,'agent'),...args],env:{ELECTRON_RUN_AS_NODE:'1'},...(context?{additionalDirectories:[extra],systemPrompt:{mode:'override',text:'Use the selected workspace'}}:{})}};
  const agent=await connection.rpc<AgentDefinition>('createAgent',config),project=await connection.rpc<any>('createProject',{name:'ACP project',path:root});
  const session=await connection.rpc<Session>('createSession',{projectId:project.id,title:'ACP conversation',agent:agent.id,command:''});
  t.after(async()=>{connection.close();await server.close();await rm(dir,{recursive:true,force:true,maxRetries:8,retryDelay:100});});
  const snapshot=()=>connection.rpc<AcpSnapshot>('acpSnapshot',{sessionId:session.id}),send=(text:string,requestId=randomUUID())=>connection.rpc<any>('acpSend',{sessionId:session.id,requestId,text});
  return {dir,root,data,extra,server,events,connection,agent,project,session,snapshot,send};
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

test('ACP combined Unicode text and excerpts fail validation before exceeding the RPC frame',async()=>{
  const {requestSchema}=await import('../src/shared/protocol');
  const raw={id:randomUUID(),method:'acpSubmit',params:{sessionId:randomUUID(),message:{requestId:randomUUID(),text:'中'.repeat(40000),attachments:[] as {type:string;path:string;text:string}[]}}};
  assert.equal(requestSchema.safeParse(raw).success,true);
  raw.params.message.attachments.push({type:'file',path:'材料.md',text:'文'.repeat(4000)});
  const rejected=requestSchema.safeParse(raw);
  assert.equal(rejected.success,false);
  assert.match(String(rejected.error),/消息与引用片段合计过长/);
});
test('ACP workbench sends scoped files and images, forwards supported MCP and records usage',async t=>{
  const f=await fixture(t,['--workbench']);
  await writeFile(path.join(f.root,'上下文.txt'),'example');
  const params={sessionId:f.session.id};
  await f.connection.rpc('acpMcpConfig',{agentId:f.agent.id,servers:[
    {type:'http',name:'supported',url:'https://example.invalid/mcp'},
    {type:'sse',name:'unsupported',url:'https://example.invalid/events'},
  ]});
  await f.connection.rpc('start',{...params,cols:100,rows:30});
  await assert.rejects(f.connection.rpc('acpMcpConfig',{agentId:f.agent.id,servers:[]}),/先断开/);
  const imageId=randomUUID();
  const header=Buffer.from([137,80,78,71,13,10,26,10]);
  await assert.rejects(f.connection.rpc('acpImage',{...params,imageId,mimeType:'image/png',data:header.toString('base64'),offset:1,last:true}),/中断/);
  await f.connection.rpc('acpImage',{...params,imageId,mimeType:'image/png',data:header.subarray(0,4).toString('base64'),offset:0,last:false});
  await f.connection.rpc('acpImage',{...params,imageId,mimeType:'image/png',data:header.subarray(4).toString('base64'),offset:4,last:true});
  await assert.rejects(f.connection.rpc('acpSubmit',{...params,message:{requestId:randomUUID(),text:'',attachments:[{type:'file',path:'../outside'}]}}),/路径无效/);
  await f.connection.rpc('acpSubmit',{...params,message:{requestId:randomUUID(),text:'review',attachments:[{type:'file',path:'上下文.txt',text:'example'},{type:'image',id:imageId,name:'preview.png'}]}});
  const snapshot=await until(f.snapshot,value=>value.phase==='ready'&&!!value.usage);
  assert.deepEqual(snapshot.usage,{used:240,size:1000,cost:{amount:0.02,currency:'USD'}});
  assert.ok(snapshot.events.find(event=>event.kind==='user')?.data?.attachments);
  const log=(await readFile(path.join(f.dir,'agent','calls.jsonl'),'utf8')).trim().split('\n').map(line=>JSON.parse(line));
  assert.deepEqual(log.find(item=>item.method==='new').mcpServers.map((server:any)=>server.name),['supported']);
  assert.deepEqual(log.find(item=>item.method==='prompt').blocks.map((block:any)=>block.type),['text','resource_link','text','image']);
});

test('ACP queue edits and withdrawal work during a turn, stays paused on reconnect, and dispatches exactly once',async t=>{
  const f=await fixture(t),params={sessionId:f.session.id};
  await f.send('long');
  await until(f.snapshot,value=>value.phase==='running');
  const keep=randomUUID(),remove=randomUUID();
  const enqueue=(requestId:string,text:string)=>f.connection.rpc('acpSubmit',{...params,message:{requestId,text},queue:true});
  await enqueue(keep,'original');
  await enqueue(remove,'withdraw me');
  await f.connection.rpc('acpQueue',{...params,action:'edit',requestId:keep,text:'edited'});
  await f.connection.rpc('acpQueue',{...params,action:'remove',requestId:remove});
  await f.connection.rpc('stop',params);
  await f.connection.rpc('start',{...params,resume:true,cols:100,rows:30});
  const paused=await f.snapshot();
  assert.equal(paused.queuePaused,true);assert.equal(paused.queue?.length,1);
  assert.equal(paused.queue?.[0].text,'edited');
  assert.ok(!paused.events.some(event=>event.text==='edited'));
  await f.connection.rpc('acpQueue',{...params,action:'resume'});
  const sent=await until(f.snapshot,value=>value.phase==='ready'&&!!value.events.find(item=>item.text==='edited'));
  assert.equal(sent.events.filter(event=>event.kind==='user'&&event.text==='edited').length,1);
  assert.equal(sent.queue?.length,0);
  await enqueue(keep,'edited');
  assert.equal((await f.snapshot()).events.filter(event=>event.kind==='user'&&event.text==='edited').length,1);
});

test('ACP history archives safely and imports native sessions only from the selected work directory',async t=>{
  const f=await fixture(t,['--workbench']);
  const scope={projectId:f.project.id,agentId:f.agent.id};
  await f.connection.rpc('start',{sessionId:f.session.id,cols:100,rows:30});
  await assert.rejects(f.connection.rpc('acpArchive',{sessionId:f.session.id,archived:true}),/先断开/);
  await f.connection.rpc('stop',{sessionId:f.session.id});
  await f.connection.rpc('acpArchive',{sessionId:f.session.id,archived:true});
  const history=await f.connection.rpc<any[]>('acpHistory');
  assert.equal(history.find(item=>item.sessionId===f.session.id).archived,true);
  assert.equal(history.find(item=>item.sessionId===f.session.id).resumable,true);
  const transport=await AcpTransport.open(f.agent.acp!,f.root,async()=>{throw new Error('Unexpected callback');},()=>{},()=>{});
  t.after(()=>transport.stop());
  await transport.call('initialize',{protocolVersion:1,clientCapabilities:{}});
  const outsideLocalJournal=await transport.call('session/new',{cwd:f.root,mcpServers:[]});
  await transport.stop();
  const native=await f.connection.rpc<any>('acpNativeHistory',scope);
  assert.equal(native.sessions.length,2);
  const canonical=await realpath(f.root);
  assert.ok(native.sessions.every((item:any)=>path.relative(canonical,item.cwd)===''));
  await assert.rejects(f.connection.rpc('acpNativeHistory',{...scope,nativeId:'unrelated'}),/先刷新/);
  const imported=await f.connection.rpc<{imported:string}>('acpNativeHistory',{...scope,nativeId:outsideLocalJournal.sessionId});
  await f.connection.rpc('start',{sessionId:imported.imported,resume:true,cols:100,rows:30});
  const get=()=>f.connection.rpc<AcpSnapshot>('acpSnapshot',{sessionId:imported.imported});
  assert.ok((await get()).events.some(event=>event.text.includes('REMOTE_REPLAY')));
  await f.connection.rpc('stop',{sessionId:imported.imported});
  await f.connection.rpc('start',{sessionId:imported.imported,resume:true,cols:100,rows:30});
  assert.equal((await get()).events.filter(event=>event.kind==='assistant'&&event.text.includes('REMOTE_REPLAY')).length,1);
  assert.equal((await get()).events.filter(event=>event.kind==='tool'&&event.text.includes('REMOTE_REPLAY_TOOL')).length,1);
});
test('ACP answers structured forms on the original request and keeps concurrent permission separate',async t=>{
  const f=await fixture(t);await f.send('elicitation-and-permission');const pending=await until(f.snapshot,value=>value.elicitations?.length===1&&value.permissions.length===1),question=pending.elicitations![0],params={sessionId:f.session.id,requestId:question.id,action:'accept'};
  await assert.rejects(f.connection.rpc('acpElicitation',{...params,content:{strategy:'渐进修改',checks:['unit'],count:2,enabled:false}}),/有效选项/);assert.equal((await f.snapshot()).elicitations?.length,1);
  await f.connection.rpc('acpElicitation',{...params,content:{strategy:'incremental',checks:['unit','ui'],count:2,enabled:false}});assert.equal((await f.snapshot()).phase,'permission');assert.equal((await f.snapshot()).permissions.length,1);
  await assert.rejects(f.connection.rpc('acpElicitation',{...params,content:{}}),/已结束/);
  await f.connection.rpc('acpPermission',{sessionId:f.session.id,permissionId:pending.permissions[0].id,optionId:'reject'});await until(f.snapshot,value=>value.phase==='ready');
  const records=(await readFile(path.join(f.dir,'agent/calls.jsonl'),'utf8')).trim().split('\n').map(line=>JSON.parse(line)),reply=records.find(item=>item.method==='elicitation-results');assert.deepEqual(reply.outcomes[0],{action:'accept',content:{strategy:'incremental',checks:['unit','ui'],count:2,enabled:false}});assert.equal(reply.outcomes[1].outcome.optionId,'reject');assert.equal(records.filter(item=>item.method==='prompt').length,1);
  await f.send('elicitation');await until(f.snapshot,value=>!!value.elicitations?.length);await f.connection.rpc('acpCancel',{sessionId:f.session.id});await until(f.snapshot,value=>value.phase==='ready');assert.equal((await f.snapshot()).elicitations?.length,0);
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
  const first=(await f.snapshot()).nativeSessionId;await f.connection.rpc('stop',{sessionId:f.session.id});await f.connection.rpc('start',{sessionId:f.session.id,cols:100,rows:30});await f.connection.rpc('acpAuthenticate',{sessionId:f.session.id,methodId:'login'});assert.notEqual((await f.snapshot()).nativeSessionId,first);assert.ok((await f.snapshot()).events.some(event=>event.text.includes('未声明会话恢复能力')));
});
test('ACP disconnect preserves partial output, marks unknown turns and never automatically resubmits them',async t=>{
  const f=await fixture(t),requestId=randomUUID();await f.send('disconnect',requestId);await until(f.snapshot,value=>value.phase==='disconnected');const output=await f.snapshot();assert.ok(output.events.some(event=>event.text.includes('partial before disconnect')));
  const duplicate=await f.send('disconnect',requestId);assert.equal(duplicate.duplicate,true);const log=await readFile(path.join(f.dir,'agent','calls.jsonl'),'utf8');assert.equal(log.split('\n').filter(line=>line.includes('"method":"prompt"')).length,1);
});
test('ACP drains buffered output before exit cleanup and refuses new writes after the process exits',async t=>{
  const f=await fixture(t),events:string[]=[];
  const transport=await AcpTransport.open({executable,args:[fixtureFile,path.join(f.dir,'agent')],env:{ELECTRON_RUN_AS_NODE:'1'}},f.root,async()=>{throw new Error('Unexpected client request');},(_method,params)=>{events.push(String(params.update?.content?.text??''));},()=>{events.push('closed');});
  t.after(()=>transport.stop());await transport.call('initialize',{protocolVersion:1,clientCapabilities:{}});const session=await transport.call('session/new',{cwd:f.root,mcpServers:[]});
  transport.child.stdout.pause();const exit=once(transport.child,'exit');const interrupted=transport.call('session/prompt',{sessionId:session.sessionId,prompt:[{type:'text',text:'disconnect'}]}).then(()=>null,error=>error);
  await exit;assert.ok(!events.includes('closed'),'Cleanup must wait until buffered protocol output drains');await assert.rejects(transport.call('session/cancel',{sessionId:session.sessionId}),/断开/);
  transport.child.stdout.resume();await transport.exited;assert.ok(await interrupted instanceof Error);assert.ok(events.includes('partial before disconnect'));assert.ok(events.indexOf('partial before disconnect')<events.indexOf('closed'));
});
test('ACP filesystem requests stay inside the canonical workspace, including symlink targets',async t=>{
  const dir=await mkdtemp(path.join(os.tmpdir(),'berth-acp-files-')),root=path.join(dir,'root'),outside=path.join(dir,'outside');await mkdir(root);await mkdir(outside);const tools=new AcpClientTools(root);t.after(async()=>{await tools.close();await rm(dir,{recursive:true,force:true});});
  await assert.rejects(tools.call('fs/write_text_file',{path:path.join(outside,'no.txt'),content:'no'}),/工作区/);
  await tools.call('fs/write_text_file',{path:path.join(root,'sub','ok.txt'),content:'one\ntwo\nthree'});assert.deepEqual(await tools.call('fs/read_text_file',{path:path.join(root,'sub','ok.txt'),line:2,limit:1}),{content:'two'});
  if(process.platform!=='win32'){const alias=path.join(dir,'workspace-alias');await symlink(root,alias);const aliased=new AcpClientTools(alias);await aliased.call('fs/write_text_file',{path:path.join(alias,'alias.txt'),content:'SAME_WORKSPACE'});assert.equal(await readFile(path.join(root,'alias.txt'),'utf8'),'SAME_WORKSPACE');await aliased.close();await symlink(outside,path.join(root,'link'));await assert.rejects(tools.call('fs/write_text_file',{path:path.join(root,'link','no.txt'),content:'no'}),/工作区/);}
});


test('Windows ACP resolves and runs a batch launcher through the same bidirectional protocol', {skip:process.platform!=='win32'}, async t=>{
  const f=await fixture(t),folder=path.join(f.dir,'Program Files');await mkdir(folder);const shim=path.join(folder,'agent launcher.cmd');
  await writeFile(shim,'@echo off\r\n"'+process.execPath+'" "'+path.resolve('tests/fixtures/acp-agent.cjs')+'" %*\r\n');
  const marker='路径 with spaces';
  await f.connection.rpc('updateAgent',{agentId:f.agent.id,name:f.agent.name,command:shim,acp:{executable:'"'+shim+'"',args:[path.join(f.dir,'agent'),marker],env:{ELECTRON_RUN_AS_NODE:'1'}}});
  await f.send('hello');const output=await until(f.snapshot,value=>value.phase==='ready');assert.ok(output.events.some(event=>event.text.includes('from small')));
  const initialized=(await readFile(path.join(f.dir,'agent','calls.jsonl'),'utf8')).trim().split('\n').map(line=>JSON.parse(line)).find(value=>value.method==='initialize');assert.deepEqual(initialized.arguments,[marker]);
});

test('ACP executable paths keep spaces and remove only matching surrounding quotes',()=>{
  assert.equal(acpExecutable('  "C:\\Program Files\\agent launcher.ps1"  '),'C:\\Program Files\\agent launcher.ps1');
  assert.equal(acpExecutable('C:\\Program Files\\agent launcher.cmd'),'C:\\Program Files\\agent launcher.cmd');
  assert.equal(acpExecutable("'/opt/agent launch'"),'/opt/agent launch');
  assert.equal(acpExecutable("/opt/agent's launch"),"/opt/agent's launch");
});

test('Windows ACP chooses the batch launcher when an extensionless POSIX npm shim also exists',{skip:process.platform!=='win32'},async t=>{
  const f=await fixture(t),folder=path.join(f.dir,'Program Files');await mkdir(folder);const bare=path.join(folder,'agent'),shim=bare+'.cmd';
  await writeFile(bare,'#!/bin/sh\nexit 13\n');
  await writeFile(shim,'@echo off\r\n"'+process.execPath+'" "'+fixtureFile+'" %*\r\n');
  await f.connection.rpc('updateAgent',{agentId:f.agent.id,name:f.agent.name,command:bare,acp:{executable:bare,args:[path.join(f.dir,'agent')],env:{ELECTRON_RUN_AS_NODE:'1'}}});
  await f.send('hello');const output=await until(f.snapshot,value=>value.phase==='ready');assert.ok(output.events.some(event=>event.text.includes('from small')));
  const command=await acpCommand('"'+bare+'"',[]),script=Buffer.from(command.args.at(-1)!,'base64').toString('utf16le');assert.ok(script.includes(shim));
});

test('Windows ACP starts a PowerShell script with spaces and preserves its protocol and arguments',{skip:process.platform!=='win32'},async t=>{
  const f=await fixture(t),folder=path.join(f.dir,'Program Files');await mkdir(folder);const shim=path.join(folder,"agent's launcher.ps1"),quote=(value:string)=>"'"+value.replaceAll("'","''")+"'";
  // Use the real console runtime, like a Node ACP adapter. Electron.exe is a
  // GUI executable on Windows; PowerShell does not wait for an unpiped GUI
  // child even with ELECTRON_RUN_AS_NODE and can exit while it is still live.
  const node=await resolveExecutable('node');t.diagnostic('PowerShell adapter runtime: '+node);
  await writeFile(shim,`$ErrorActionPreference='Stop'\r\n& ${quote(node)} ${quote(fixtureFile)} @args\r\nexit $LASTEXITCODE\r\n`);
  const markers=['路径 with spaces',"a literal's argument",'--config-modes'];
  await f.connection.rpc('updateAgent',{agentId:f.agent.id,name:f.agent.name,command:shim,acp:{executable:shim,args:[path.join(f.dir,'agent'),...markers],env:{ELECTRON_RUN_AS_NODE:'1'}}});
  await f.send('hello');const output=await until(f.snapshot,value=>value.phase==='ready');assert.ok(output.events.some(event=>event.text.includes('from small')));assert.equal(output.modes,undefined);
  await f.send('long');await until(f.snapshot,value=>value.phase==='running'&&value.events.some(event=>event.text.includes('stream 1')));await f.connection.rpc('acpCancel',{sessionId:f.session.id});await until(f.snapshot,value=>value.phase==='ready');
  const initialized=(await readFile(path.join(f.dir,'agent','calls.jsonl'),'utf8')).trim().split('\n').map(line=>JSON.parse(line)).find(value=>value.method==='initialize');assert.deepEqual(initialized.arguments,markers);
  const resolved=await acpCommand(shim.slice(0,-4),[]);assert.match(resolved.file,/powershell\.exe$/i);
});


test('the first prompt joins an existing ACP startup and executes exactly once',async t=>{
  const f=await fixture(t,['--slow-init']),started=f.connection.rpc('start',{sessionId:f.session.id,cols:100,rows:30});
  await until(f.snapshot,value=>value.phase==='connecting');const requestId=randomUUID();await Promise.all([started,f.send('hello',requestId)]);
  const result=await until(f.snapshot,value=>value.phase==='ready'&&value.events.some(event=>event.kind==='assistant'));assert.equal(result.events.filter(event=>event.kind==='user').length,1);
  const log=await readFile(path.join(f.dir,'agent','calls.jsonl'),'utf8');assert.equal(log.split('"method":"prompt"').length-1,1);
});

test('configOptions mode uses the declared option API instead of the legacy session mode method',async t=>{
  const f=await fixture(t,['--config-modes']);await f.connection.rpc('start',{sessionId:f.session.id,cols:100,rows:30});
  const before=await f.snapshot();assert.equal(before.modes,undefined);assert.equal(before.configOptions?.find(option=>option.id==='mode')?.currentValue,'build');
  await f.connection.rpc('acpConfigure',{sessionId:f.session.id,configId:'mode',value:'plan'});
  assert.equal((await f.snapshot()).configOptions?.find(option=>option.id==='mode')?.currentValue,'plan');
  await assert.rejects(f.connection.rpc('acpConfigure',{sessionId:f.session.id,configId:'mode',value:'unavailable'}),/声明的配置/);
  const records=(await readFile(path.join(f.dir,'agent','calls.jsonl'),'utf8')).trim().split('\n').map(line=>JSON.parse(line));assert.deepEqual(records.filter(record=>record.method==='config').map(({configId,value})=>({configId,value})),[{configId:'mode',value:'plan'}]);
});

test('model discovery uses declared choices without a prompt and reuses a live matching session',async t=>{
  const f=await fixture(t,['--named-model']),params={agentId:f.agent.id,projectId:f.project.id};
  const [one,two]=await Promise.all([f.connection.rpc<any>('acpOptions',params),f.connection.rpc<any>('acpOptions',params)]);assert.deepEqual(one,two);assert.equal(one.configId,'provider-model');assert.deepEqual(one.choices.map((choice:any)=>choice.value),['small','large']);
  const calls=()=>readFile(path.join(f.dir,'agent','calls.jsonl'),'utf8').then(text=>text.trim().split('\n').map(line=>JSON.parse(line)));
  assert.equal((await calls()).filter(call=>call.method==='initialize').length,1);assert.equal((await calls()).filter(call=>call.method==='prompt').length,0);
  assert.equal((await f.connection.rpc<State>('state')).sessions.length,1);
  await f.send('hello');await until(f.snapshot,value=>value.phase==='ready');const before=(await calls()).length;await f.connection.rpc('acpOptions',params);assert.equal((await calls()).length,before);
});
test('terminal display output survives release and disconnect and cannot be read from another session',async t=>{
  const f=await fixture(t);await f.send('terminal');const done=await until(f.snapshot,value=>value.phase==='ready'),event=done.events.find(event=>event.kind==='terminal');assert.ok(event);
  const terminalId=String(event.data?.terminalId);await f.connection.rpc('stop',{sessionId:f.session.id});const output=await f.connection.rpc<any>('acpTerminal',{sessionId:f.session.id,terminalId});assert.equal(output.output,'ACP_TERMINAL_OK');assert.equal(output.released,true);
  const other=await f.connection.rpc<Session>('createSession',{projectId:f.project.id,title:'Other',agent:f.agent.id});await assert.rejects(f.connection.rpc('acpTerminal',{sessionId:other.id,terminalId}),/不属于|保留范围/);
});

for(const previousApi of [44,45,46,47,48,49,50,51,52,57,58,59,60,61,62,63,64,65,66])test(`a compatible API ${previousApi} backend remains attachable without stopping a running ACP session`,async t=>{
  const f=await fixture(t);await f.send('long');await until(f.snapshot,value=>value.phase==='running');
  const store=f.server.agentsCorePort().store,original=store.state.bind(store);store.state=()=>({...original(),apiVersion:previousApi});
  const connection=await connectDaemon(f.data,'must-not-launch-another-daemon','must-not-launch',()=>{});try{assert.equal((await connection.rpc<State>('state')).apiVersion,previousApi);assert.equal((await f.snapshot()).phase,'running');}finally{connection.close();store.state=original;}
});


test('ACP uses declared session/resume and close, retaining its journal without replay',async t=>{
  const f=await fixture(t,['--resume']);await f.send('hello');const first=await until(f.snapshot,value=>value.phase==='ready');
  await f.connection.rpc('stop',{sessionId:f.session.id});const count=(await f.snapshot()).events.length;
  await f.connection.rpc('updateAgent',{agentId:f.agent.id,name:f.agent.name,command:f.agent.command,acp:{...f.agent.acp,startupTimeoutMs:10000},resumeCommand:'',plugin:null});
  await f.connection.rpc('start',{sessionId:f.session.id,resume:true,cols:100,rows:30});
  const next=await f.snapshot();assert.equal(next.nativeSessionId,first.nativeSessionId);assert.equal(next.events.length,count);
  const calls=(await readFile(path.join(f.dir,'agent','calls.jsonl'),'utf8')).trim().split('\n').map(line=>JSON.parse(line));
  assert.equal(calls.filter(c=>c.method==='resume').length,1);assert.equal(calls.filter(c=>c.method==='load').length,0);assert.equal(calls.filter(c=>c.method==='close').length,1);
});
test('ACP startup timeout includes launch diagnostics and never retries or creates a session',async t=>{
  const f=await fixture(t,['--never-init']);
  await f.connection.rpc('updateAgent',{agentId:f.agent.id,name:f.agent.name,command:f.agent.command,acp:{...f.agent.acp,startupTimeoutMs:5000},resumeCommand:'',plugin:null});
  await assert.rejects(f.connection.rpc('start',{sessionId:f.session.id,resume:false,cols:100,rows:30}),error=>{
    assert.match(String(error),/initialize.*5 秒/);assert.match(String(error),/FIXTURE_BOOTSTRAP_WAIT/);return true;
  });
  const state=await f.snapshot();assert.equal(state.phase,'disconnected');assert.match(state.error??'',/initialize/);assert.equal(state.nativeSessionId,null);assert.equal(f.server.acpCorePort().acp.live.size,0);
});


test('an ACP connection can be cancelled during initialization without submitting a prompt or retaining its process',async t=>{
  const f=await fixture(t,['--never-init']);const started=f.connection.rpc('start',{sessionId:f.session.id,cols:100,rows:30}).catch(error=>error);
  await until(f.snapshot,value=>value.phase==='connecting');
  await f.connection.rpc('stop',{sessionId:f.session.id});await started;
  assert.equal(f.server.acpCorePort().acp.live.size,0);const state=await f.snapshot();assert.equal(state.nativeSessionId,null);assert.equal(state.events.filter(event=>event.kind==='user').length,0);assert.equal(state.phase,'disconnected');
});

test('Registry binary uses digest verification and never extracts archive paths outside staging',async t=>{
  const {installAcpBinary}=await import('../src/daemon/acp-registry-binary');
  const {zipSync}=await import('fflate');
  const {createHash}=await import('node:crypto');
  const {readdir}=await import('node:fs/promises');
  const dir=await mkdtemp(path.join(os.tmpdir(),'berth-acp-registry-'));
  t.after(()=>rm(dir,{recursive:true,force:true}));
  const contents=Buffer.from('fixture only');
  let archive=zipSync({'agent.exe':contents});
  t.mock.method(globalThis,'fetch',async()=>new Response(Buffer.from(archive)));
  const getRecipe=()=>({url:'https://example.invalid/agent.zip',sha256:createHash('sha256').update(archive).digest('hex'),kind:'zip' as const,command:'agent.exe',args:[]});
  const command=await installAcpBinary(dir,getRecipe());
  assert.deepEqual(await readFile(command),contents);
  const before=await readdir(dir);
  await assert.rejects(installAcpBinary(dir,{...getRecipe(),sha256:'0'.repeat(64)}),/SHA-256/);
  archive=zipSync({'../escape.exe':contents,'agent.exe':contents});
  await assert.rejects(installAcpBinary(dir,getRecipe()),/file name|invalid relative path|路径/);
  assert.deepEqual(await readdir(dir),before);
});

test('ACP v1 streams distinct messages, child events, plans, media and context patches in order',async t=>{
  const f=await fixture(t,['--workbench','--v1']),params={sessionId:f.session.id};
  await f.send('v1 stream');
  const live=await until(f.snapshot,value=>value.phase==='running'&&value.events.some(event=>event.data?.messageId==='media'));
  await assert.rejects(f.connection.rpc('acpCancel',{...params,childSessionId:'unknown'}),/未提供停止/);
  await f.connection.rpc('acpCancel',{...params,childSessionId:'child'});
  const groups=conversationGroups(live.events);
  const messages=groups.filter(group=>group[0].kind==='assistant'&&!group[0].data?.childSessionId);
  assert.deepEqual(messages.slice(0,2).map(group=>group.map(event=>event.text).join('')),['first continues','second']);
  assert.equal(groups.filter(group=>group[0].kind==='tool').length,2);
  assert.equal(toolState(groups.find(group=>group[0].kind==='tool'&&group[0].data?.childSessionId)!).title,'Child tool');
  assert.ok(!live.events.some(event=>event.text.includes('must not be recorded')));
  const context=groups.find(group=>group[0].kind==='compaction')!;
  assert.deepEqual(acpStreamBlocks(context,'summary'),[{type:'text',text:'Final context'}]);
  assert.deepEqual(acpStreamBlocks(groups.find(group=>group[0].kind==='session-message')!,'blocks'),[{type:'text',text:'new'}]);
  assert.deepEqual(groups.filter(group=>group[0].kind==='plan').map(group=>group[0].data?.planId),['visible']);
  assert.equal(live.sessionInfo?.title,'V1 title');
  assert.ok(f.events.some(event=>event.event==='acp'&&event.data.notice?.title==='Live V1 notice'));
  assert.ok(!live.events.some(event=>event.text.includes('Live V1 notice')));
  const media=messages.at(-1)?.[0].data?.content as {mediaId:string};
  const first=await f.connection.rpc<{data:string;total:number}>('acpMedia',{...params,mediaId:media.mediaId,offset:0});
  const last=await f.connection.rpc<{data:string;total:number}>('acpMedia',{...params,mediaId:media.mediaId,offset:first.data.length});
  assert.equal(first.total,128000);
  assert.deepEqual(Buffer.from(first.data+last.data,'base64'),Buffer.alloc(96000,42));
  const other=await f.connection.rpc<Session>('createSession',{projectId:f.project.id,title:'Other',agent:f.agent.id,command:''});
  await assert.rejects(f.connection.rpc('acpMedia',{sessionId:other.id,mediaId:media.mediaId,offset:0}),/附件不存在/);
  await until(f.snapshot,value=>value.phase==='ready');
  await f.connection.rpc('acpConfigure',{...params,configId:'reasoning',value:true});
  assert.equal((await f.snapshot()).configOptions?.find(option=>option.id==='reasoning')?.currentValue,true);
});

test('ACP v1 negotiates audio and embedded resources and streams terminal output before release',async t=>{
  const f=await fixture(t,['--workbench','--v1']),params={sessionId:f.session.id};
  await f.connection.rpc('start',{...params,cols:100,rows:30});
  await writeFile(path.join(f.root,'material.txt'),'完整正文');
  const id=randomUUID();
  await f.connection.rpc('acpImage',{...params,imageId:id,mimeType:'audio/wav',offset:0,data:Buffer.from('RIFF----WAVE').toString('base64'),last:true});
  await f.connection.rpc('acpSubmit',{...params,message:{requestId:randomUUID(),text:'use attachments',attachments:[{type:'file',path:'material.txt',embed:true},{type:'audio',id,name:'sample.wav'}]}});
  await until(f.snapshot,value=>value.phase==='ready');
  await f.send('v1 live terminal');
  await until(f.snapshot,value=>value.phase==='ready');
  const updates=f.events.flatMap(event=>event.event==='acp'&&event.data.terminal?[event.data.terminal]:[]);
  assert.ok(updates.some(item=>item.output==='first'&&!item.released));
  assert.ok(updates.some(item=>item.output==='firstlast'&&item.released));
  const calls=(await readFile(path.join(f.dir,'agent','calls.jsonl'),'utf8')).trim().split('\n').map(line=>JSON.parse(line));
  const blocks=calls.find(item=>item.text==='use attachments').blocks;
  assert.deepEqual(blocks.map((item:any)=>item.type),['text','resource','audio']);
  assert.equal(blocks[1].resource.text,'完整正文');
});

test('ACP v1 closes cancelled callbacks and completes URL interactions without persisting the URL',async t=>{
  const f=await fixture(t,['--v1']),params={sessionId:f.session.id};
  await f.send('v1 url');
  const waiting=await until(f.snapshot,value=>value.elicitations?.length===1),request=waiting.elicitations![0];
  assert.equal(request.url?.hostname,'example.invalid');
  await f.connection.rpc('acpElicitation',{...params,requestId:request.id,action:'accept'});
  const browser=await f.snapshot();assert.equal(browser.urlInteractions?.[0]?.hostname,'example.invalid');
  const done=await until(f.snapshot,value=>value.phase==='ready'&&!value.urlInteractions?.length);
  assert.ok(done.events.some(event=>event.text==='网页操作已完成'));
  assert.ok(!JSON.stringify(done).includes('private-fixture'));
  await f.send('v1 cancel callback');
  const permission=await until(f.snapshot,value=>value.permissions.length===1);
  await until(f.snapshot,value=>value.phase==='ready'&&!value.permissions.length);
  await assert.rejects(f.connection.rpc('acpPermission',{...params,permissionId:permission.permissions[0].id,optionId:'allow'}),/已结束/);
  const calls=(await readFile(path.join(f.dir,'agent','calls.jsonl'),'utf8')).trim().split('\n').map(line=>JSON.parse(line));
  assert.deepEqual(calls.find(item=>item.method==='url-response').outcome,{action:'accept'});
  assert.equal(calls.find(item=>item.method==='cancelled-callback').code,-32800);
});

test('ACP v1 logout and scoped native deletion leave the workstation records intact',async t=>{
  const f=await fixture(t,['--workbench','--v1']),params={sessionId:f.session.id},scope={projectId:f.project.id,agentId:f.agent.id};
  await f.send('preserve me');
  const ready=await until(f.snapshot,value=>value.phase==='ready');
  assert.equal(ready.canLogout,true);
  const nativeId=ready.nativeSessionId!;
  assert.equal((await f.connection.rpc<{deletable:boolean}>('acpNativeHistory',scope)).deletable,true);
  await assert.rejects(f.connection.rpc('acpNativeHistory',{...scope,nativeId,remove:true}),/先断开/);
  await f.connection.rpc('acpLogout',params);
  await f.connection.rpc('acpNativeHistory',{...scope,nativeId,remove:true});
  const saved=await f.snapshot();
  assert.equal(saved.nativeSessionId,null);
  assert.ok(saved.events.some(event=>event.kind==='user'&&event.text==='preserve me'));
});

test('ACP v1 terminal authentication is explicit, uses literal args and reconnects after a zero exit',async t=>{
  // The login process must be a console-subsystem executable on Windows.
  const f=await fixture(t,['--terminal-auth'],false,await resolveExecutable('node')),params={sessionId:f.session.id};
  await f.connection.rpc('start',{...params,cols:100,rows:30});
  assert.equal((await f.snapshot()).authMethods?.[0].type,'terminal');
  const request={...params,methodId:'login-terminal'};
  await assert.rejects(f.connection.rpc('acpAuthenticate',request),/核对/);
  const {terminalId}=await f.connection.rpc<{terminalId:string}>('acpAuthenticate',{...request,terminalApproved:true});
  const terminal={...params,terminalId};
  await until(()=>f.connection.rpc<{output:string}>('acpAuthTerminal',{...terminal,action:'read'}),value=>value.output.includes('FIXTURE_LOGIN>'));
  await f.connection.rpc('acpAuthTerminal',{...terminal,action:'write',input:'accept\r'});
  const ready=await until(f.snapshot,value=>value.phase==='ready');
  assert.ok(ready.nativeSessionId);
  assert.ok(!JSON.stringify(ready).includes('FIXTURE_LOGIN'));
});

test('ACP v1 negotiates lifecycle context and scopes child file calls to the declared roots',async t=>{
  const f=await fixture(t,['--workbench','--v1'],true);
  await writeFile(path.join(f.root,'private.txt'),'parent only');
  await writeFile(path.join(f.extra,'extra.txt'),'child context');
  await f.send('v1 scoped child');
  const saved=await until(f.snapshot,value=>value.phase==='ready');
  const reply=saved.events.find(event=>event.kind==='assistant')?.text;
  assert.deepEqual(JSON.parse(reply!),{value:'child context',rejected:true});
  const calls=(await readFile(path.join(f.dir,'agent','calls.jsonl'),'utf8')).trim().split('\n').map(line=>JSON.parse(line));
  const setup=calls.find(item=>item.method==='new');
  assert.deepEqual(setup.additionalDirectories,[await realpath(f.extra)]);
  assert.deepEqual(setup.systemPrompt,{mode:'override',content:[{type:'text',text:'Use the selected workspace'}]});
});
