import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {HarnessService,defaultHarnessArgs} from '../src/plugins/deepseek-harness/service';
import {resolveExecutable} from '../src/daemon/executables';
import {extensionManifestSchema,localPluginUrl,type PluginWebState} from '../src/shared/extensions';
import {harnessManifest} from '../src/plugins/deepseek-harness/manifest';
import {DaemonServer} from '../src/daemon/server';
import {DaemonConnection} from '../src/main/connection';

const wait=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(read:()=>Promise<PluginWebState>|PluginWebState){const end=Date.now()+10000;while(Date.now()<end){const value=await read();if(value.state==='running')return value;await wait(30);}throw new Error('Web startup timed out');}
test('native Web manifests remain additive, reject ambiguous views and only accept loopback endpoints',()=>{
  const manifest=extensionManifestSchema.parse(harnessManifest);assert.equal(manifest.views[0].web?.command,'web');assert.equal(manifest.kind,'feature');assert.equal(manifest.views.filter(view=>view.location==='settings').length,0);
  assert.ok(!manifest.dependencies.includes('acp'));assert.ok(!manifest.config.model);
  assert.ok(defaultHarnessArgs.includes('--no-open'));assert.deepEqual(defaultHarnessArgs.slice(-2),['--port','0']);
  assert.equal(localPluginUrl('http://127.0.0.1:3080/?token=x').port,'3080');
  for(const url of ['file:///etc/passwd','https://example.org/','http://127.0.0.1.example.org/','http://name:pass@localhost/'])assert.throws(()=>localPluginUrl(url));
  assert.throws(()=>extensionManifestSchema.parse({...manifest,views:[{id:'web',title:'Web',location:'sidebar',entry:'index.html',web:{command:'web'}}]}));
});
test('Harness owns its original HTTP frontend and auth; the host starts once and redacts split launch tokens',async t=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'berth-native-harness-')),counter=path.join(root,'starts.jsonl');
  const pids:Array<number|null>=[];
  const service=new HarnessService(await resolveExecutable('node'),[path.resolve('tests/fixtures/harness-web.cjs'),counter],pid=>pids.push(pid));
  t.after(async()=>{await service.dispose();await rm(root,{recursive:true,force:true,maxRetries:5});});
  const project={id:'b65f75ba-5b53-48c3-b6ac-a74fe39e6628',path:root};
  await service.control('start',project);const status=await until(()=>service.snapshot());
  assert.ok(status.pid&&pids.includes(status.pid),'Harness PID must be published to resource monitoring');
  assert.ok(status.url?.includes('fixture-private-token'));assert.ok(!status.log.includes('fixture-private-token'));assert.ok(status.log.includes('fixture startup diagnostics'));assert.match(status.log,/redacted/);
  const response=await fetch(status.url!,{redirect:'manual'});assert.equal(response.status,302);const cookie=response.headers.get('set-cookie')!;
  const original=await fetch(new URL('/',status.url!),{headers:{cookie}});assert.equal(original.status,200);assert.equal(original.headers.get('x-frame-options'),'DENY');assert.match(await original.text(),/Harness Native/);
  await service.control('start',project);assert.equal((await readFile(counter,'utf8')).trim().split('\n').length,1);
  await service.control('restart',project);const restarted=await until(()=>service.snapshot());assert.ok(restarted.pid&&pids.includes(restarted.pid));assert.equal((await readFile(counter,'utf8')).trim().split('\n').length,2);
  await service.control('stop');assert.equal(pids.at(-1),null,'Stopped Harness must be removed from resource roots');assert.equal(service.snapshot().state,'stopped');assert.equal(service.snapshot().url,null);assert.equal(service.snapshot().pid,null);
  await service.dispose();await assert.rejects(service.control('start',project),/停用/);
});
test('Harness plugin is opt-in to execution, publishes no ACP agent and disposes its owned service on disable',async t=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'berth-harness-plugin-')),counter=path.join(root,'starts.jsonl'),server=new DaemonServer(path.join(root,'data'));
  const connection=await DaemonConnection.open(await server.listen(),()=>{});t.after(async()=>{connection.close();await server.close();await rm(root,{recursive:true,force:true,maxRetries:5});});
  const call=(action:string)=>connection.rpc<PluginWebState>('extensions',{request:{action:'call',id:'deepseek-harness',command:'web',params:{action}}});
  const resourcePort=server.resourcesCorePort();
  const initial=await connection.rpc<any>('extensions',{request:{action:'list'}});const plugin=initial.plugins.find((p:any)=>p.manifest.id==='deepseek-harness');assert.equal(plugin?.status,'active',JSON.stringify(plugin));
  assert.equal((await call('status')).state,'stopped');assert.equal(plugin.manifest.views[0].web.project,false);
  const node=await resolveExecutable('node');
  await connection.rpc('extensions',{request:{action:'configure',id:'deepseek-harness',config:{executable:node,args:JSON.stringify([path.resolve('tests/fixtures/harness-web.cjs'),counter])}}});
  await call('start');const status=await until(()=>call('status'));assert.ok(status.pid);assert.deepEqual(resourcePort.appProcesses,{'deepseek-harness':[status.pid]});
  const state=await connection.rpc<any>('state');assert.equal(state.agents.filter((a:any)=>a.sourceId?.includes('deepseek-harness')).length,0);assert.equal(state.sessions.length,0);
  await connection.rpc('extensions',{request:{action:'disable',id:'deepseek-harness'}});
  assert.deepEqual(resourcePort.appProcesses,{},'Disabling Harness must release its resource PID root');
  assert.throws(()=>process.kill(status.pid!,0));
  await assert.rejects(call('status'),/未启用/);
});
