import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { shutdownDaemon, stopIdleDaemon } from '../src/main/connection';

test('authenticated 0.1 daemon upgrade preserves busy process and replaces it only when idle', { timeout: 15000 }, async t => {
  const folder = mkdtempSync(path.join(os.tmpdir(), 'berth-legacy-'));
  const stateFile = path.join(folder, 'state.json');
  const script = path.join(folder, 'legacy.cjs');
  writeFileSync(stateFile, JSON.stringify({ sessions: [{ latestRun: { status: 'running' } }] }));
  // A minimal old-protocol fixture deliberately has no new shutdown RPC.
  writeFileSync(script, `const fs=require('node:fs'); const {WebSocketServer}=require(${JSON.stringify(path.resolve('node_modules/ws'))});
    const token='a'.repeat(64); const server=new WebSocketServer({host:'127.0.0.1',port:0});
    server.on('listening',()=>fs.writeFileSync(${JSON.stringify(path.join(folder, 'runtime.json'))},JSON.stringify({version:1,pid:process.pid,port:server.address().port,token})));
    server.on('connection',(socket,req)=>{if(req.headers.authorization!=='Bearer '+token){socket.close();return;}
      socket.on('message',bytes=>{const req=JSON.parse(bytes);socket.send(JSON.stringify({id:req.id,result:JSON.parse(fs.readFileSync(${JSON.stringify(stateFile)},'utf8'))}));});});`);
  const child = spawn(process.execPath, [script], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, stdio: 'ignore' });
  t.after(async () => {
    try { child.kill('SIGTERM'); } catch {}
    for (let n = 0; n < 50 && child.exitCode === null && child.signalCode === null; n++) await new Promise(resolve => setTimeout(resolve, 50));
    rmSync(folder, { recursive: true, force: true, maxRetries: 5 });
  });
  for (let n = 0; n < 100 && !existsSync(path.join(folder, 'runtime.json')); n++) await new Promise(resolve => setTimeout(resolve, 50));
  assert.ok(existsSync(path.join(folder, 'runtime.json')));
  await assert.rejects(stopIdleDaemon(folder), /停止全部终端/);
  assert.equal(child.exitCode, null); process.kill(child.pid!, 0);
  writeFileSync(stateFile, JSON.stringify({ sessions: [] }));
  await stopIdleDaemon(folder);
  assert.equal(JSON.parse(readFileSync(stateFile, 'utf8')).sessions.length, 0);
  assert.throws(() => process.kill(child.pid!, 0), /ESRCH/);
});

test('full quit drains an older backend through stop before requesting its idle shutdown', { timeout: 15000 }, async t => {
  const folder = mkdtempSync(path.join(os.tmpdir(), 'berth-legacy-quit-'));
  const calls = path.join(folder, 'calls.json'), script = path.join(folder, 'backend.cjs');
  writeFileSync(script, `const fs=require('node:fs');const {WebSocketServer}=require(${JSON.stringify(path.resolve('node_modules/ws'))});
    const token='b'.repeat(64),calls=[];let busy=true;const server=new WebSocketServer({host:'127.0.0.1',port:0});
    server.on('listening',()=>fs.writeFileSync(${JSON.stringify(path.join(folder, 'runtime.json'))},JSON.stringify({version:1,pid:process.pid,port:server.address().port,token})));
    server.on('connection',(socket,req)=>{if(req.headers.authorization!=='Bearer '+token){socket.close();return;}socket.on('message',bytes=>{
      const req=JSON.parse(bytes);calls.push(req.method);fs.writeFileSync(${JSON.stringify(calls)},JSON.stringify(calls));
      if(req.method==='state')socket.send(JSON.stringify({id:req.id,result:{apiVersion:3,sessions:[{id:'f8709828-83a8-4443-a414-2621b8125895',latestRun:{status:busy?'running':'stopped'}}]}}));
      else if(req.method==='stop'){busy=false;socket.send(JSON.stringify({id:req.id,result:null}));}
      else if(req.method==='shutdownIdle'&&!busy){socket.send(JSON.stringify({id:req.id,result:null}));setTimeout(()=>process.exit(0),50);}
      else socket.send(JSON.stringify({id:req.id,error:'unsupported or still busy'}));
    });});`);
  const child = spawn(process.execPath, [script], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, stdio: 'ignore' });
  t.after(async () => {
    try { child.kill('SIGTERM'); } catch {}
    for (let n = 0; n < 50 && child.exitCode === null && child.signalCode === null; n++) await new Promise(resolve => setTimeout(resolve, 50));
    rmSync(folder, { recursive: true, force: true, maxRetries: 5 });
  });
  for (let n = 0; n < 100 && !existsSync(path.join(folder, 'runtime.json')); n++) await new Promise(resolve => setTimeout(resolve, 50));
  assert.ok(existsSync(path.join(folder, 'runtime.json')));
  await shutdownDaemon(folder);
  const requested = JSON.parse(readFileSync(calls, 'utf8')) as string[];
  assert.ok(requested.indexOf('stop') < requested.indexOf('shutdownIdle'));
  assert.equal(requested.includes('shutdown'), false);
  assert.throws(() => process.kill(child.pid!, 0), /ESRCH/);
});
