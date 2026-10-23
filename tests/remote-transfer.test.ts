import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, randomBytes, generateKeyPairSync } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, readFile, rm, lstat, readdir, open, symlink } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { Server, utils, type SFTPWrapper } from 'ssh2';
import { copyTransfer, localTransferFs, RemoteTransfers, type TransferFs } from '../src/daemon/remote-transfer';
import { Store } from '../src/daemon/store';
import { DaemonServer } from '../src/daemon/server';
import { DaemonConnection } from '../src/main/connection';
import { TerminalMcp } from '../src/mcp/server';
import { transferSpecSchema, type RemoteTransfer, type Session, type SshConnection, type TransferSpec } from '../src/shared/protocol';

const spec=(source:string,destination:string,options:Partial<TransferSpec>={}):TransferSpec=>({requestId:randomUUID(),source:{kind:'remote',sessionId:randomUUID(),runId:randomUUID(),path:source},destination:{kind:'local',path:destination},recursive:false,resume:false,overwrite:false,...options});
test('binary and recursive transfers preserve bytes, empty folders and explicit overwrite/resume behavior',async t=>{
  const folder=await mkdtemp(path.join(tmpdir(),'ab-copy-'));t.after(()=>rm(folder,{recursive:true,force:true}));
  const source=path.join(folder,'source'),target=path.join(folder,'target'),payload=randomBytes(2*1024*1024+17);
  await mkdir(path.join(source,'中😀','empty'),{recursive:true});await writeFile(path.join(source,'中😀','binary.bin'),payload);await writeFile(path.join(source,'zero'),Buffer.alloc(0));
  const fs=localTransferFs(),signal=new AbortController().signal;
  const transfer=spec(source,target,{recursive:true});let progress:number[]=[];
  await copyTransfer(transfer,fs,fs,signal,(...values)=>progress=values);
  assert.deepEqual(await readFile(path.join(target,'中😀','binary.bin')),payload);assert.equal((await lstat(path.join(target,'中😀','empty'))).isDirectory(),true);
  assert.deepEqual(progress,[payload.length,payload.length,2,2]);
  await assert.rejects(copyTransfer(transfer,fs,fs,signal,()=>{}),/已存在/);
  const single=spec(path.join(source,'中😀','binary.bin'),path.join(folder,'partial'));
  await writeFile(single.destination.path,payload.subarray(0,54321));
  await copyTransfer({...single,resume:true},fs,fs,signal,()=>{});assert.deepEqual(await readFile(single.destination.path),payload);
  await copyTransfer({...single,resume:true},fs,fs,signal,()=>{});assert.deepEqual(await readFile(single.destination.path),payload);
  await writeFile(single.destination.path,Buffer.from('wrong-prefix'));
  await assert.rejects(copyTransfer({...single,resume:true},fs,fs,signal,()=>{}),/前缀不同/);
  assert.equal((await readFile(single.destination.path)).toString(),'wrong-prefix');
  await copyTransfer({...single,overwrite:true},fs,fs,signal,()=>{});assert.deepEqual(await readFile(single.destination.path),payload);
  await assert.rejects(copyTransfer(spec(source,path.join(folder,'unused')),fs,fs,signal,()=>{}),/recursive/);
  assert.equal(transferSpecSchema.safeParse({...single,resume:true,overwrite:true}).success,false);
});

test('unsafe traversal and symlinks are rejected, cancellation leaves an explicit partial file',async t=>{
  const folder=await mkdtemp(path.join(tmpdir(),'ab-copy-cancel-'));t.after(()=>rm(folder,{recursive:true,force:true}));
  const source=path.join(folder,'large'),target=path.join(folder,'partial');await writeFile(source,randomBytes(4*1024*1024));
  const abort=new AbortController(),fs=localTransferFs();
  await assert.rejects(copyTransfer(spec(source,target),fs,fs,abort.signal,bytes=>{if(bytes>0)abort.abort();}));
  assert.ok((await lstat(target)).size<4*1024*1024);
  const unsafe:TransferFs={...fs,stat:async()=>({size:0,mtime:0,mode:0o755,file:false,directory:true,symlink:false}),list:async()=>['../escape']};
  await assert.rejects(copyTransfer(spec(source,target,{recursive:true}),unsafe,fs,new AbortController().signal,()=>{}),/文件名/);
  if(process.platform!=='win32'){
    const link=path.join(folder,'link');await symlink(source,link);
    await assert.rejects(copyTransfer(spec(link,path.join(folder,'other')),fs,fs,new AbortController().signal,()=>{}),/符号链接/);
  }
});

test('background transfer IDs deduplicate, survive waits/disconnects and preserve crash outcomes',async t=>{
  const folder=await mkdtemp(path.join(tmpdir(),'ab-transfer-jobs-'));let store=new Store(path.join(folder,'data'));
  const project=store.createProject('fixture',folder),session=store.createSession(project.id,'SSH','shell','',null,{host:'fixture',directory:''}),run=store.createRun(session.id,'',80,24,'SSH');
  const source=path.join(folder,'source'),target=path.join(folder,'target');await writeFile(source,randomBytes(1024*1024));
  const request=spec(source,target,{source:{kind:'remote',sessionId:session.id,runId:run.id,path:source}});
  const events:RemoteTransfer[]=[],manager=new RemoteTransfers(store,async()=>localTransferFs(),value=>events.push(value),()=>{});
  t.after(async()=>{await manager.close();store.close();await rm(folder,{recursive:true,force:true});});
  const started=manager.start(request);assert.equal(started.status,'running');assert.equal(manager.start(request).id,started.id);
  assert.throws(()=>manager.start({...request,overwrite:true}),/requestId/);
  const cancelledWait=new AbortController();cancelledWait.abort();await manager.wait(started.id,30000,cancelledWait.signal);
  assert.equal((await manager.wait(started.id,10000)).status,'completed');assert.deepEqual(await readFile(target),await readFile(source));
  assert.equal(manager.start(request).status,'completed');assert.ok(events.some(value=>value.bytes>0));assert.equal(manager.list(session.id)[0].id,started.id);
  const crashed={...started,id:randomUUID(),status:'running' as const};store.saveRemoteAction({id:crashed.id,sessionId:session.id,runId:run.id,kind:'transfer',status:'running',label:'fixture',startedAt:crashed.startedAt,endedAt:null,exitCode:null,transfer:crashed});
  store.close();store=new Store(path.join(folder,'data'));
  const restarted=new RemoteTransfers(store,async()=>localTransferFs(),()=>{},()=>{});assert.equal(restarted.get(crashed.id).status,'unknown');
});

// Protocol-level SFTP fixture: files stay under a temporary directory, with real
// SSH authentication/channel multiplexing on both Windows and Linux.
function serveSftp(sftp:SFTPWrapper,root:string,holdWrite:()=>boolean=()=>false):void {
  let next=0;const handles=new Map<string,FileHandle|string[]>();
  const file=(name:string)=>{const value=path.resolve(root,'.'+name);if(!value.startsWith(root+path.sep)&&value!==root)throw new Error('outside fixture');return value;};
  const attrs=(s:Awaited<ReturnType<typeof lstat>>)=>({mode:Number(s.mode),size:Number(s.size),uid:0,gid:0,atime:Math.floor(Number(s.atimeMs)/1000),mtime:Math.floor(Number(s.mtimeMs)/1000)});
  const safe=(id:number,fn:()=>Promise<void>)=>{void fn().catch((error:NodeJS.ErrnoException)=>sftp.status(id,error.code==='ENOENT'?2:4,error.code));};
  sftp.on('OPEN',(id,name,flags,a)=>safe(id,async()=>{const handle=await open(file(name),utils.sftp.flagsToString(flags)!,a.mode),key=String(++next);handles.set(key,handle);sftp.handle(id,Buffer.from(key));}));
  sftp.on('CLOSE',(id,key)=>safe(id,async()=>{const handle=handles.get(key.toString());if(handle&&!Array.isArray(handle))await handle.close();handles.delete(key.toString());sftp.status(id,0);}));
  sftp.on('READ',(id,key,offset,length)=>safe(id,async()=>{const handle=handles.get(key.toString()) as FileHandle,bytes=Buffer.alloc(length);const read=await handle.read(bytes,0,length,offset);if(read.bytesRead)sftp.data(id,bytes.subarray(0,read.bytesRead));else sftp.status(id,1);}));
  sftp.on('WRITE',(id,key,offset,data)=>{if(holdWrite())return;safe(id,async()=>{const handle=handles.get(key.toString()) as FileHandle;let written=0;while(written<data.length)written+=(await handle.write(data,written,data.length-written,offset+written)).bytesWritten;sftp.status(id,0);});});
  for(const event of ['LSTAT','STAT'] as const)sftp.on(event,(id:number,name:string)=>safe(id,async()=>{sftp.attrs(id,attrs(await lstat(file(name))));}));
  sftp.on('FSTAT',(id,key)=>safe(id,async()=>{const handle=handles.get(key.toString()) as FileHandle;sftp.attrs(id,attrs(await handle.stat()));}));
  sftp.on('MKDIR',(id,name,a)=>safe(id,async()=>{await mkdir(file(name),{mode:a.mode});sftp.status(id,0);}));
  sftp.on('OPENDIR',(id,name)=>safe(id,async()=>{const entries=await readdir(file(name));const key=String(++next);handles.set(key,entries.map(entry=>path.posix.join(name,entry)));sftp.handle(id,Buffer.from(key));}));
  sftp.on('READDIR',(id,key)=>safe(id,async()=>{const entries=handles.get(key.toString()) as string[];if(!entries.length){sftp.status(id,1);return;}const batch=entries.splice(0,100);sftp.name(id,await Promise.all(batch.map(async name=>({filename:path.posix.basename(name),longname:name,attrs:attrs(await lstat(file(name)))}))));}));
  sftp.on('error',()=>{});sftp.on('close',()=>{for(const handle of handles.values())if(!Array.isArray(handle))void handle.close().catch(()=>{});handles.clear();});
}

test('Agent manages sessions and uploads/downloads/streams over the same authenticated SSH while PTY remains live', {timeout:60000},async t=>{
  const folder=await mkdtemp(path.join(tmpdir(),'ab-transfer-ssh-')),remoteRoot=path.join(folder,'remote');await mkdir(remoteRoot);
  const key=generateKeyPairSync('rsa',{modulusLength:2048,privateKeyEncoding:{type:'pkcs1',format:'pem'},publicKeyEncoding:{type:'pkcs1',format:'pem'}});
  const clients=new Set<any>();let handshakes=0,channels=0,holdWrites=false,denySftp=false,onHeld=()=>{};
  const ssh=new Server({hostKeys:[key.privateKey]},client=>{
    clients.add(client);client.on('error',()=>{});client.on('close',()=>clients.delete(client));
    client.on('authentication',context=>{if(context.method==='password'&&context.password==='fixture-secret')context.accept();else context.reject(['password']);});
    client.on('ready',()=>{handshakes++;client.on('session',accept=>{
      const session=accept();session.on('pty',accept=>accept?.());session.on('window-change',accept=>accept?.());session.on('sftp',(accept,reject)=>{if(denySftp){reject();return;}channels++;serveSftp(accept(),remoteRoot,()=>{if(holdWrites){onHeld();return true;}return false;});});
      session.on('exec',(accept,_reject,info)=>{
        const channel=accept();if(info.command.startsWith('case x')){channel.end('AgentBerth_POSIX');return;}
        const id=/AgentBerth;([^;]+);ready/.exec(info.command)![1];channel.write(`\x1b]777;AgentBerth;${id};ready;;0;/fixture\x07$ `);
        let input='';channel.on('data',(bytes:Buffer)=>{input+=bytes.toString();if(!input.endsWith('\r'))return;const request=/start;([a-f0-9-]+)/.exec(input)?.[1];if(request)channel.write(input.replaceAll('\r','\r\n')+`\x1b]777;AgentBerth;${id};start;${request}\x07PTY_LIVE\r\n\x1b]777;AgentBerth;${id};ready;${request};0;/fixture\x07$ `);input='';});
      });
    });});
  });
  await new Promise<void>(resolve=>ssh.listen(0,'127.0.0.1',resolve));const address=ssh.address();assert.ok(address&&typeof address!=='string');
  const daemon=new DaemonServer(path.join(folder,'data')),runtime=await daemon.listen();let ui:DaemonConnection;
  ui=await DaemonConnection.open(runtime,event=>{if(event.event==='sshChallenge')void ui.rpc('sshChallengeReply',{challengeId:event.data.id,...(event.data.kind==='hostKey'?{accepted:true}:{secret:{password:'fixture-secret'}})});});
  const agent=await DaemonConnection.open(runtime,()=>{}),mcp=new TerminalMcp(agent);
  t.after(async()=>{await ui.rpc('shutdown').catch(()=>{});agent.close();ui.close();await daemon.close();for(const client of clients)client.destroy();await new Promise<void>(resolve=>ssh.close(()=>resolve()));await rm(folder,{recursive:true,force:true});});
  await ui.rpc('registerSshProvider');
  await ui.rpc<SshConnection>('saveSshConnection',{config:{alias:'fixture-server',hostname:'127.0.0.1',port:address.port,username:'fixture-user',authentication:'password',privateKeyPath:'',allowAgent:true}});
  const call=async(name:string,args:Record<string,unknown>={})=>{const result:any=await mcp.request('tools/call',{name,arguments:args});if(result.isError)throw new Error(JSON.parse(result.content[0].text).error.message);return JSON.parse(result.content[0].text);};
  const [a,b]=await Promise.all([call('terminal_create',{alias:'fixture-server',title:'worker'}),call('terminal_create',{alias:'fixture-server',title:'worker'})]);
  assert.equal(a.runId,b.runId);assert.equal(handshakes,1);
  const payload=randomBytes(512*1024+5),local=path.join(folder,'payload'),download=path.join(folder,'download');await writeFile(local,payload);
  const uploadId=randomUUID(),uploadArgs={alias:'fixture-server',requestId:uploadId,localPath:local,remotePath:'/new/中😀.bin'};
  await call('terminal_upload',uploadArgs);let result=await call('terminal_transfer_status',{requestId:uploadId,timeoutMs:10000});assert.equal(result.status,'completed',result.error);
  assert.deepEqual(await readFile(path.join(remoteRoot,'new','中😀.bin')),payload);assert.equal(handshakes,1);assert.ok(channels>=1);
  assert.equal((await call('terminal_upload',uploadArgs)).status,'completed','Retry must not overwrite or open another SFTP channel');
  const resumeId=randomUUID();await writeFile(path.join(remoteRoot,'resume.bin'),payload.subarray(0,12345));
  await call('terminal_upload',{...uploadArgs,requestId:resumeId,remotePath:'/resume.bin',resume:true});
  result=await call('terminal_transfer_status',{requestId:resumeId,timeoutMs:10000});assert.equal(result.status,'completed',result.error);assert.deepEqual(await readFile(path.join(remoteRoot,'resume.bin')),payload);
  const downloadId=randomUUID();await call('terminal_download',{alias:'fixture-server',requestId:downloadId,remotePath:'/new/中😀.bin',localPath:download});
  result=await call('terminal_transfer_status',{requestId:downloadId,timeoutMs:10000});assert.equal(result.status,'completed',result.error);assert.deepEqual(await readFile(download),payload);
  const directoryId=randomUUID();await call('terminal_download',{alias:'fixture-server',requestId:directoryId,remotePath:'/new',localPath:path.join(folder,'tree'),recursive:true});
  result=await call('terminal_transfer_status',{requestId:directoryId,timeoutMs:10000});assert.equal(result.status,'completed',result.error);assert.deepEqual(await readFile(path.join(folder,'tree','中😀.bin')),payload);
  const transferId=randomUUID();await call('terminal_transfer',{requestId:transferId,sourceAlias:'fixture-server',destinationAlias:'fixture-server',sourcePath:'/new/中😀.bin',destinationPath:'/copy.bin'});
  result=await call('terminal_transfer_status',{requestId:transferId,timeoutMs:10000});assert.equal(result.status,'completed',result.error);assert.deepEqual(await readFile(path.join(remoteRoot,'copy.bin')),payload);
  await assert.rejects(call('terminal_transfer',{requestId:randomUUID(),sourceAlias:'fixture-server',destinationAlias:'fixture-server',sourcePath:'/copy.bin',destinationPath:'/copy.bin',overwrite:true}),/路径相同/);
  const cancelledId=randomUUID();holdWrites=true;const held=new Promise<void>(resolve=>{onHeld=resolve;});
  await call('terminal_upload',{...uploadArgs,requestId:cancelledId,remotePath:'/partial.bin'});await held;
  assert.equal((await call('terminal_transfer_cancel',{requestId:cancelledId})).status,'cancelled');holdWrites=false;
  denySftp=true;const unsupportedId=randomUUID();await call('terminal_upload',{...uploadArgs,requestId:unsupportedId,remotePath:'/unsupported.bin'});
  result=await call('terminal_transfer_status',{requestId:unsupportedId,timeoutMs:10000});assert.equal(result.status,'failed');assert.match(result.error,/SFTP/);denySftp=false;
  const action=await call('terminal_execute',{alias:'fixture-server',requestId:randomUUID(),command:'printf PTY_LIVE',waitMs:5000});assert.equal(action.exitCode,0);
  const screen=await call('terminal_screen',{alias:'fixture-server'});assert.ok(screen.text.includes('PTY_LIVE'));assert.ok(!screen.text.includes('__ab_status'));assert.ok(!screen.text.includes(']777;AgentBerth;'));assert.equal(handshakes,1);
  await ui.rpc('saveSshConnection',{config:{alias:'fixture-backup',hostname:'127.0.0.1',port:address.port,username:'fixture-user',authentication:'password',privateKeyPath:'',allowAgent:true}});
  const backup=await call('terminal_create',{alias:'fixture-backup',title:'backup'});
  const crossId=randomUUID();await call('terminal_transfer',{requestId:crossId,sourceAlias:'fixture-server',destinationAlias:'fixture-backup',sourcePath:'/copy.bin',destinationPath:'/backup.bin'});
  result=await call('terminal_transfer_status',{requestId:crossId,timeoutMs:10000});assert.equal(result.status,'completed',result.error);assert.deepEqual(await readFile(path.join(remoteRoot,'backup.bin')),payload);assert.equal(handshakes,2);
  assert.ok((await ui.rpc<RemoteTransfer[]>('remoteTransfers',{sessionId:backup.sessionId})).some(value=>value.id===crossId),'Destination session sees server-to-server transfer progress');
  await call('terminal_close',{alias:'fixture-backup'});await call('terminal_delete',{sessionId:backup.sessionId});
  await call('terminal_update',{alias:'fixture-server',title:'worker-renamed'});
  await ui.rpc('remoteControl',{sessionId:a.sessionId,runId:a.runId,owner:'user'});
  await assert.rejects(call('terminal_close',{alias:'fixture-server'}),/用户控制/);
  await assert.rejects(call('terminal_upload',{...uploadArgs,requestId:randomUUID(),remotePath:'/denied'}),/用户控制/);
  await ui.rpc('remoteControl',{sessionId:a.sessionId,runId:a.runId,owner:'agent'});
  await call('terminal_close',{alias:'fixture-server'});await call('terminal_update',{sessionId:a.sessionId,directory:'/new'});await call('terminal_delete',{sessionId:a.sessionId});
  const listed=await call('terminal_list');assert.equal(listed.sessions.length,0);assert.equal(listed.connections.length,2);
});
