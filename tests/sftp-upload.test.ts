import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, randomBytes, generateKeyPairSync } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { Client, Server, type Connection, type SFTPWrapper } from 'ssh2';
import { copyTransfer, localTransferFs, sftpTransferFs } from '../src/daemon/remote-transfer';
import type { TransferSpec } from '../src/shared/protocol';
import { serveSftp, type WriteProbe } from './fixtures/sftp-server';

const spec=(source:string,destination:string):TransferSpec=>({requestId:randomUUID(),source:{kind:'local',path:source},destination:{kind:'remote',sessionId:randomUUID(),runId:randomUUID(),path:destination},recursive:false,resume:false,overwrite:false});

test('failed or cancelled pipelined uploads stop scheduling writes and ignore late acknowledgements',async t=>{
  for(const failure of ['error','cancel'] as const)await t.test(failure,async()=>{
    const channel=new EventEmitter(),writes:{offset:number;length:number;ack:(error?:Error|null)=>void}[]=[];
    const sftp=Object.assign(channel,{
      open:(_path:string,_flags:string,_attrs:unknown,callback:(error:null,handle:Buffer)=>void)=>queueMicrotask(()=>callback(null,Buffer.from('handle'))),
      write:(_handle:Buffer,_data:Buffer,_offset:number,length:number,position:number,callback:(error?:Error|null)=>void)=>{writes.push({offset:position,length,ack:callback});},
      close:(_handle:Buffer,callback:()=>void)=>queueMicrotask(callback),
      end:()=>channel.emit('close'),
    }) as unknown as SFTPWrapper;
    const fs=sftpTransferFs(sftp),abort=new AbortController(),output=fs.write('/partial','wx',73,0o600);let finished=false;
    output.on('finish',()=>{finished=true;});
    const copying=pipeline(Readable.from([Buffer.alloc(4*1024*1024)]),output,{signal:abort.signal});
    await new Promise<void>(resolve=>setImmediate(resolve));
    assert.equal(writes.length,32,'even an oversized input chunk must keep a bounded request window');
    assert.equal(writes[0].offset,73);assert.ok(writes.every(write=>write.length<=32768));
    const rejected=assert.rejects(copying,failure==='error'?/fixture disk full/:/aborted/);
    if(failure==='error')writes[0].ack(new Error('fixture disk full'));else abort.abort();
    await rejected;
    for(const write of writes.slice(failure==='error'?1:0))write.ack();
    assert.equal(writes.length,32,'late acknowledgements must not enqueue another window');
    assert.equal(finished,false,'partial writes must never be reported as complete');fs.close();
  });
});

test('SFTP upload pipelines bounded writes over delayed SSH and waits for all acknowledgements', {timeout:30000},async t=>{
  const folder=await mkdtemp(path.join(tmpdir(),'ab-upload-window-')),remoteRoot=path.join(folder,'remote');await mkdir(remoteRoot);
  const key=generateKeyPairSync('rsa',{modulusLength:2048,privateKeyEncoding:{type:'pkcs1',format:'pem'},publicKeyEncoding:{type:'pkcs1',format:'pem'}});
  const probe:WriteProbe={active:0,peak:0,packets:0,bytes:0,delayMs:12},clients=new Set<Connection>();
  const server=new Server({hostKeys:[key.privateKey]},client=>{
    clients.add(client);client.on('error',()=>{});client.on('close',()=>clients.delete(client));
    client.on('authentication',context=>context.accept());
    client.on('ready',()=>client.on('session',accept=>accept().on('sftp',accept=>serveSftp(accept(),remoteRoot,undefined,probe))));
  });
  const client=new Client();client.on('error',()=>{});
  t.after(async()=>{client.destroy();for(const connection of clients)connection.end();await new Promise<void>(resolve=>server.close(()=>resolve()));await rm(folder,{recursive:true,force:true});});
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  const address=server.address();assert.ok(address&&typeof address!=='string');
  await new Promise<void>((resolve,reject)=>{client.once('ready',resolve);client.once('error',reject);client.connect({host:'127.0.0.1',port:address.port,username:'fixture',readyTimeout:10000});});
  const sftp=await new Promise<SFTPWrapper>((resolve,reject)=>client.sftp((error,value)=>error?reject(error):resolve(value)));
  const destination=sftpTransferFs(sftp),source=localTransferFs(),payload=randomBytes(4*1024*1024+23),file=path.join(folder,'payload');await writeFile(file,payload);
  const transfer=spec(file,'/uploaded.bin'),start=performance.now();let finalFiles=0;
  await copyTransfer(transfer,source,destination,new AbortController().signal,(_bytes,_total,files)=>{finalFiles=files;});
  const elapsed=performance.now()-start;
  t.diagnostic(`4 MiB upload, delayed acknowledgements: ${elapsed.toFixed(0)} ms; peak ${probe.peak} writes in flight; ${probe.packets} packets`);
  assert.ok(probe.peak>1,'upload must overlap SFTP requests instead of waiting one packet per RTT');
  assert.ok(probe.peak<=32,'outstanding requests must stay bounded');
  assert.equal(probe.active,0,'success must wait for every write acknowledgement');
  assert.equal(probe.bytes,payload.length);assert.equal(finalFiles,1);
  assert.deepEqual(await readFile(path.join(remoteRoot,'uploaded.bin')),payload);
  destination.close();
});

