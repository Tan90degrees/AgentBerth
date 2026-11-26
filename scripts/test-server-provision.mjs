import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { test } from 'node:test';
import ssh2 from 'ssh2';
import { strToU8, zipSync } from 'fflate';
import { generateSshKeys, testPassword, testUsername, workspaceSshFixture } from './ssh-workspace-fixture.mjs';

await mkdir('dist/tests',{recursive:true});
await build({stdin:{contents:`
  export {WorkspaceProvision} from './src/main/workspace-provision';
  export {WorkspaceSshHosts} from './src/main/workspace-ssh-hosts';
  export {WorkspaceTargets} from './src/main/workspace-target';
`,resolveDir:process.cwd()},outfile:'dist/tests/workspace-provision.cjs',bundle:true,platform:'node',format:'cjs',target:'node24',packages:'external'});
const {WorkspaceProvision,WorkspaceSshHosts,WorkspaceTargets}=(await import('../dist/tests/workspace-provision.cjs')).default;
const version=JSON.parse(await readFile('package.json','utf8')).version;

test('SSH workspaces deploy once, preserve a remote terminal and install a local plugin package', {timeout:95000},async t=>{
  const root=await mkdtemp(path.join(tmpdir(),'berth-provision-'));
  const home=path.join(root,'remote home'),data=path.join(home,'.local/share/agentberth-server');
  const hostKey=generateSshKeys().privateKey,privateKey=generateSshKeys().privateKey,publicKey=ssh2.utils.parseKey(privateKey);
  const keyPath=path.join(root,'test-identity'),connections=new Set();
  let server;
  t.after(async()=>{
    for(const connection of connections)connection.close(true);
    const runtime=await readFile(path.join(data,'runtime.json'),'utf8').then(JSON.parse).catch(()=>null);
    if(runtime?.pid)try{process.kill(runtime.pid,'SIGTERM');}catch{}
    if(server)await server.close();
    await rm(root,{recursive:true,force:true});
  });
  await mkdir(home);await writeFile(keyPath,privateKey,{mode:0o600});
  server=await workspaceSshFixture(home,{hostKey,publicKey,remotePath:process.env.AGENTBERTH_TEST_REMOTE_PATH});
  const settings={host:'127.0.0.1',port:server.port,username:testUsername,authentication:'password'};
  const targetPath=path.join(root,'target.json');
  const vault={isEncryptionAvailable:()=>true,encryptString:value=>Buffer.from(value).reverse(),decryptString:value=>Buffer.from(value).reverse().toString()};
  const targets=new WorkspaceTargets(targetPath,vault),endpoint=targets.sshEndpoint(settings,testPassword);
  let fingerprints=0;
  const hosts=new WorkspaceSshHosts(path.join(root,'hosts.json'),async(_target,fingerprint)=>{
    assert.match(fingerprint,/^SHA256:[A-Za-z0-9+/]{43}$/);
    fingerprints++;
    return true;
  });
  const provision=new WorkspaceProvision((...args)=>hosts.verify(...args),path.resolve('release'),version);
  await assert.rejects(provision.inspect(targets.sshEndpoint(settings,'incorrect')),/SSH 登录失败/);
  assert.equal(fingerprints,1);
  const probe=await provision.inspect(endpoint);
  assert.equal(probe.status,'missing');
  assert.equal(probe.arch,process.arch);
  const phases=[];
  const {connection}=await provision.activate(probe.id,()=>{},phase=>phases.push(phase));
  connections.add(connection);
  assert.deepEqual(phases,['upload','install','start','connect']);
  const pid=JSON.parse(await readFile(path.join(data,'runtime.json'),'utf8')).pid;
  assert.deepEqual(await readdir(path.join(home,'.local/opt')),['agentberth-server']);
  assert.ok((await connection.rpc('state')).server);
  const project=await connection.rpc('createProject',{name:'SSH workspace',path:home});
  const session=await connection.rpc('createSession',{projectId:project.id,title:'SSH workspace',agent:'shell'});
  const run=await connection.rpc('start',{sessionId:session.id,cols:80,rows:24});
  await connection.rpc('attach',{sessionId:session.id});
  await connection.rpc('input',{sessionId:session.id,runId:run.id,data:"sleep .3; printf 'PROVISION_%s\\n' CONNECTED\r"});
  connection.close(true);

  targets.select(endpoint,true);
  const disk=await readFile(targetPath,'utf8');
  assert.ok(!disk.includes(testPassword));
  assert.equal(targets.state().savedSsh,true);
  assert.ok(!JSON.stringify(targets.state()).includes(testPassword));
  const restored=new WorkspaceTargets(targetPath,vault);restored.load();
  const reconnected=await provision.reconnect(restored.active,()=>{});
  connections.add(reconnected);
  const keyEndpoint=targets.sshEndpoint({...settings,authentication:'key',keyPath});
  const running=await provision.inspect(keyEndpoint);
  assert.equal(running.status,'running');
  const {connection:usingKey}=await provision.activate(running.id,()=>{},value=>assert.equal(value,'connect'));
  connections.add(usingKey);
  assert.equal(JSON.parse(await readFile(path.join(data,'runtime.json'),'utf8')).pid,pid);
  let attachment;
  const deadline=Date.now()+10000;
  do {
    attachment=await usingKey.rpc('attach',{sessionId:session.id});
    if(attachment.snapshot.includes('PROVISION_CONNECTED'))break;
    await new Promise(resolve=>setTimeout(resolve,50));
  }while(Date.now()<deadline);
  const pluginFile=path.join(root,'local plugin.zip');
  await writeFile(pluginFile,zipSync({
    'agentberth.extension.json':strToU8(JSON.stringify({apiVersion:1,id:'example.ssh-upload',name:'SSH upload fixture',version:'1.0.0'})),
    'index.cjs':strToU8("exports.apply=ctx=>{ctx.berth.command({name:'ping',description:'Fixture',inputSchema:{type:'object'}},()=>({ready:true}));};"),
    'asset.bin':new Uint8Array(192*1024),
  },{level:0}));
  const plugin=await provision.installExtension(usingKey,pluginFile);
  assert.equal(plugin.plugins.find(item=>item.manifest.id==='example.ssh-upload')?.status,'active');
  assert.deepEqual(await usingKey.rpc('extensions',{request:{action:'call',id:'example.ssh-upload',command:'ping'}}),{ready:true});
  await writeFile(pluginFile,'incomplete ZIP');
  await assert.rejects(provision.installExtension(usingKey,pluginFile),/ZIP 不完整/);
  assert.ok(!(await readdir(data)).some(name=>name.startsWith('.plugin-stage-')));
  assert.equal(attachment.run.id,run.id);
  assert.ok(attachment.snapshot.includes('PROVISION_CONNECTED'));
  assert.equal(fingerprints,1);
  await assert.rejects(hosts.verify(endpoint,'SHA256:'+'A'.repeat(43),true),/指纹已变化/);
  await usingKey.rpc('stop',{sessionId:session.id});
  process.kill(pid,'SIGTERM');
  const serviceDeadline=Date.now()+10000;
  while(Date.now()<serviceDeadline&&await readFile(path.join(data,'daemon.lock')).then(()=>true,()=>false)){
    await new Promise(resolve=>setTimeout(resolve,50));
  }
  const installed=await provision.inspect(endpoint);
  assert.equal(installed.status,'installed');
  const restartPhases=[];
  const {connection:restarted}=await provision.activate(installed.id,()=>{},phase=>restartPhases.push(phase));
  connections.add(restarted);
  assert.deepEqual(restartPhases,['start','connect']);
  assert.notEqual(JSON.parse(await readFile(path.join(data,'runtime.json'),'utf8')).pid,pid);
  const saved=await restarted.rpc('state');
  assert.ok(saved.projects.some(item=>item.id===project.id));
  assert.equal(saved.extensions.plugins.find(item=>item.manifest.id==='example.ssh-upload')?.status,'active');
});
