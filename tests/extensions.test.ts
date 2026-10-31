import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink, readdir } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { runInNewContext } from 'node:vm';
import { zipSync, strToU8 } from 'fflate';
import { ExtensionRuntime, type ExtensionHost } from '../src/extensions/runtime';
import { DesktopExtensions } from '../src/extensions/desktop';
import { ExtensionMcp, extensionToolName } from '../src/extensions/mcp';
import { extensionDocument } from '../src/extensions/view-document';
import { stagePackage, packagePath } from '../src/extensions/packages';
import { extensionManifestSchema, resolveExtensionConfig } from '../src/shared/extensions';

const manifest=(id:string,extra={})=>({apiVersion:1,id,name:id,version:'1.0.0',...extra});
async function fixture(t:any){const root=await mkdtemp(path.join(os.tmpdir(),'berth-extensions-'));t.after(()=>rm(root,{recursive:true,force:true}));return root;}
async function source(root:string,id:string,code:string,extra={}){const dir=path.join(root,id);await mkdir(dir,{recursive:true});await writeFile(path.join(dir,'agentberth.extension.json'),JSON.stringify(manifest(id,extra)));await writeFile(path.join(dir,'index.cjs'),code);return dir;}
const host=(extra:Partial<ExtensionHost>={}):ExtensionHost=>({mount:()=>{},beforeChange:async()=>{},call:async()=>null,agentsChanged:()=>{},changed:()=>{},...extra});
const command=(value:string)=>`exports.apply=(ctx,config)=>{ctx.berth.command({name:'value',description:'Read value',inputSchema:{type:'object',properties:{},additionalProperties:false}},()=>(${value}));};`;


test('sandboxed plugin view bridge works without Web Crypto and correlates parallel replies',async()=>{
  const script=extensionDocument('').split('<script>')[1]?.split('</script>')[0];
  assert.ok(script);
  const requests:any[]=[],listeners=new Map<string,(event:any)=>void>();
  const parent={postMessage:(data:unknown)=>{requests.push(data);}};
  const frame={
    window:{},parent,setTimeout,clearTimeout,
    addEventListener:(event:string,listener:(event:any)=>void)=>{listeners.set(event,listener);},
    removeEventListener:(event:string)=>{listeners.delete(event);},
  };
  // An iframe with sandbox="allow-scripts" has an opaque origin. Even if
  // crypto.randomUUID is unavailable, command dispatch must still succeed.
  runInNewContext(script,frame);
  const bridge=(frame.window as any).agentberth;
  const first=bridge.call('info',{page:1}),second=bridge.call('info',{page:2});
  assert.equal(requests.length,2);
  assert.notEqual(requests[0].id,requests[1].id);
  assert.deepEqual(requests.map(request=>request.command),['info','info']);
  listeners.get('message')!({source:parent,data:{kind:'agentberth-plugin-result',id:requests[1].id,result:'second'}});
  listeners.get('message')!({source:parent,data:{kind:'agentberth-plugin-result',id:requests[0].id,result:'first'}});
  assert.deepEqual(await Promise.all([first,second]),['first','second']);
});

test('Cordis lifecycle, live config, dependency teardown, persistence and uninstall preserve data',async t=>{
  const root=await fixture(t),directory=path.join(root,'runtime');let agents:any[]=[];
  const runtime=new ExtensionRuntime(directory,host({agentsChanged:value=>{agents=value;}}));await runtime.ready;t.after(()=>runtime.close());
  const dir=await source(root,'example.agent',`exports.apply=(ctx,config)=>{ctx.berth.agent({id:'main',definition:{name:'Example',command:'example',skills:{project:'.example/skills'}}});ctx.berth.command({name:'value',description:'Get config',inputSchema:{$id:'example-config-command',type:'object',properties:{},additionalProperties:false}},()=>config.greeting);ctx.effect(()=>{globalThis.__extensionMounted=(globalThis.__extensionMounted||0)+1;return()=>{globalThis.__extensionMounted--;};});};`,{dependencies:['agents'],config:{greeting:{type:'string',title:'Greeting',default:'hello'}}});
  await runtime.install(dir);assert.equal(await runtime.call('example.agent','value',{}),'hello');assert.equal(agents[0].agent.definition.skills.project,'.example/skills');
  await runtime.change('configure','example.agent',{greeting:'updated'});assert.equal(await runtime.call('example.agent','value',{}),'updated');assert.equal((globalThis as any).__extensionMounted,1);
  await assert.rejects(runtime.change('configure','example.agent',{greeting:42}),/配置无效/);assert.equal(await runtime.call('example.agent','value',{}),'updated');
  await runtime.change('disable','agents');assert.equal(agents.length,0);assert.equal(runtime.active('example.agent'),false);assert.equal((globalThis as any).__extensionMounted,0);await assert.rejects(runtime.call('example.agent','value',{}),/未启用/);
  await runtime.change('enable','agents');assert.equal(await runtime.call('example.agent','value',{}),'updated');assert.equal((globalThis as any).__extensionMounted,1);
  const data=path.join(directory,'data','example.agent','keep.txt');await writeFile(data,'keep');await runtime.change('uninstall','example.agent');assert.equal(await readFile(data,'utf8'),'keep');assert.ok((await readdir(path.join(directory,'packages'))).every(name=>!name.startsWith('example.agent-')));await assert.rejects(runtime.change('enable','example.agent'),/重新选择/);
  await runtime.close();const restarted=new ExtensionRuntime(directory,host());await restarted.ready;t.after(()=>restarted.close());assert.equal(restarted.snapshot().plugins.find(p=>p.manifest.id==='example.agent')?.installed,false);
});

test('developer reload rolls back code and config, rejects cycles and never deletes source',async t=>{
  const root=await fixture(t),runtime=new ExtensionRuntime(path.join(root,'runtime'),host());await runtime.ready;t.after(()=>runtime.close());
  const dir=await source(root,'example.dev',command("'v1'"));await runtime.install(dir,true);
  await writeFile(path.join(dir,'index.cjs'),`exports.apply=()=>{throw new Error('broken release');};`);
  await assert.rejects(runtime.change('reload','example.dev'),/恢复旧配置与代码/);assert.equal(await runtime.call('example.dev','value',{}),'v1');
  await writeFile(path.join(dir,'index.cjs'),command("'v2'"));await runtime.change('reload','example.dev');assert.equal(await runtime.call('example.dev','value',{}),'v2');
  await runtime.change('disable','example.dev');await writeFile(path.join(dir,'index.cjs'),command("'v3'"));await runtime.change('enable','example.dev');assert.equal(await runtime.call('example.dev','value',{}),'v3');
  const a=await source(root,'cycle.a',command('1'),{dependencies:['cycle.b']});await runtime.install(a);const b=await source(root,'cycle.b',command('2'),{dependencies:['cycle.a']});await assert.rejects(runtime.install(b),/循环/);
  await runtime.change('uninstall','example.dev');assert.match(await readFile(path.join(dir,'index.cjs'),'utf8'),/v3/);assert.ok(!(await readdir(path.join(root,'runtime','packages'))).some(name=>name.startsWith('.staging')));
});

test('active commands and host operations reject mutation without disposing the working plugin',async t=>{
  const root=await fixture(t);let rejectHost=false;
  const runtime=new ExtensionRuntime(path.join(root,'runtime'),host({beforeChange:async()=>{if(rejectHost)throw new Error('live terminal');}}));await runtime.ready;t.after(()=>runtime.close());
  const dir=await source(root,'example.busy',`exports.apply=ctx=>{ctx.berth.command({name:'wait',description:'Wait',inputSchema:{type:'object'}},()=>new Promise(resolve=>{globalThis.__releaseExtension=resolve;}));};`);await runtime.install(dir);
  const pending=runtime.call('example.busy','wait',{});await new Promise(resolve=>setImmediate(resolve));await assert.rejects(runtime.change('disable','example.busy'),/命令正在执行/);(globalThis as any).__releaseExtension('done');assert.equal(await pending,'done');
  rejectHost=true;await assert.rejects(runtime.change('disable','example.busy'),/live terminal/);assert.equal(runtime.active('example.busy'),true);
  await assert.rejects(runtime.install(dir),/live terminal/);assert.ok(!(await readdir(path.join(root,'runtime','packages'))).some(name=>name.startsWith('.staging')));
});

test('plugin packages validate zip boundaries, symlinks, schema and config',async t=>{
  const root=await fixture(t),base=path.join(root,'packages');
  for(const bad of ['../x','/tmp/x','foo/../x','C:/x','foo\\bar'])assert.throws(()=>packagePath(root,bad));
  const zip=path.join(root,'valid.zip');await writeFile(zip,zipSync({'agentberth.extension.json':strToU8(JSON.stringify(manifest('example.zip'))),'index.cjs':strToU8(command('1'))}));const staged=await stagePackage(zip,base,false);assert.equal(staged.manifest.id,'example.zip');await staged.cleanup();
  const evil=path.join(root,'evil.zip');await writeFile(evil,zipSync({'../escaped.cjs':strToU8('no')}));await assert.rejects(stagePackage(evil,base,false),/路径无效/);assert.deepEqual(await readdir(base),[]);
  if(process.platform!=='win32'){const dir=await source(root,'example.link',command('1'));await symlink('/etc/passwd',path.join(dir,'linked'));await assert.rejects(stagePackage(dir,base,false),/符号链接/);}
  const config=extensionManifestSchema.parse(manifest('example.config',{config:{count:{type:'number',title:'Count',minimum:1,maximum:3,default:2}}}));assert.deepEqual(resolveExtensionConfig(config,{}),{count:2});assert.throws(()=>resolveExtensionConfig(config,{count:4}),/配置无效/);
});

test('MCP catalog follows plugin lifecycle and custom commands stay on the caller RPC',async()=>{
  let snapshot:any={apiVersion:1,revision:1,plugins:[{manifest:manifest('example.tools'),status:'active',commands:[{name:'value',description:'Read',inputSchema:{type:'object'}}]}]},calls:any[]=[];
  const base={request:async(method:string)=>method==='tools/list'?{tools:[{name:'terminal_execute'}]}:{base:true,instructions:'SSH_GUIDE'}};
  const mcp=new ExtensionMcp(base,async(method,params)=>{calls.push([method,params]);return method==='state'?{extensions:snapshot}:123;});
  const name=extensionToolName('example.tools','value');assert.deepEqual((await mcp.request('tools/list')).tools.map((t:any)=>t.name),[name]);
  const init=await mcp.request('initialize');assert.equal(init.capabilities.tools.listChanged,true);assert.equal(init.serverInfo.name,'agentberth-terminal');assert.ok(!init.instructions.includes('SSH_GUIDE'));
  const result=await mcp.request('tools/call',{name,arguments:{x:1}});assert.equal(result.content[0].text,'123');assert.equal(calls.at(-1)[1].request.id,'example.tools');assert.deepEqual(calls.at(-1)[1].request.params,{x:1});
  assert.equal((await mcp.request('tools/call',{name:'terminal_execute'})).isError,true);await assert.rejects(mcp.request('resources/read'),/未启用/);
  snapshot.plugins.push({manifest:manifest('ssh'),status:'active',commands:[]});assert.equal((await mcp.request('tools/list')).tools.length,2);
});

test('desktop Cordis mirrors only changed plugin scopes',async t=>{
  let mounted=0,disposed=0;const desktop=new DesktopExtensions({pet:ctx=>{ctx.effect(()=>{mounted++;return()=>{disposed++;};});}});t.after(()=>desktop.close());
  const snapshot:any={apiVersion:1,revision:1,plugins:[{manifest:manifest('pet'),generation:1,config:{},status:'active'}]};
  await desktop.update(snapshot);await desktop.update({...snapshot,revision:2});assert.equal(mounted,1);assert.equal(disposed,0);
  await desktop.update({...snapshot,plugins:[{...snapshot.plugins[0],generation:2}]});assert.equal(mounted,2);assert.equal(disposed,1);
  await desktop.update({...snapshot,plugins:[]});assert.equal(disposed,2);
});

test('real daemon removes feature routes and keeps contributed Agent identities across config and restart',async t=>{
  const {DaemonServer}=await import('../src/daemon/server');const {DaemonConnection}=await import('../src/main/connection');
  // The SQLite database must be closed before removing its directory on Windows.
  // fixture(t) registers deletion before the daemon teardown hook and can leave
  // the SQLite WAL/SHM locked, keeping the test runner alive after a hook failure.
  const root=await mkdtemp(path.join(os.tmpdir(),'berth-extensions-')),directory=path.join(root,'data');let server=new DaemonServer(directory);let connection=await DaemonConnection.open(await server.listen(),()=>{});
  t.after(async()=>{try{connection.close();await server.close();}finally{await rm(root,{recursive:true,force:true,maxRetries:10,retryDelay:150});}});
  const project=await connection.rpc<any>('createProject',{name:'Fixture',path:root});const session=await connection.rpc<any>('createSession',{projectId:project.id,title:'Shell',agent:'shell'});await connection.rpc('start',{sessionId:session.id,cols:90,rows:20});
  const change=(request:any)=>connection.rpc<any>('extensions',{request});
  await assert.rejects(change({action:'disable',id:'workspace'}),/运行会话/);
  const codex=await connection.rpc<any>('createSession',{projectId:project.id,title:'Disabled provider',agent:'codex'});await change({action:'disable',id:'agent.codex'});await assert.rejects(connection.rpc('history',{sessionId:codex.id}),/未启用/);await change({action:'enable',id:'agent.codex'});
  await change({action:'disable',id:'files'});await assert.rejects(connection.rpc('projectFiles',{projectId:project.id}),/未启用/);assert.equal((await connection.rpc<any>('state')).extensions.plugins.find((p:any)=>p.manifest.id==='git').status,'blocked');
  await change({action:'enable',id:'files'});await connection.rpc('projectFiles',{projectId:project.id});
  const dir=await source(root,'example.integration',`exports.apply=(ctx,c)=>ctx.berth.agent({id:'main',definition:{name:c.name,command:'fixture-agent',skills:{project:'.fixture/skills'}}});`,{dependencies:['agents'],config:{name:{type:'string',title:'Name',default:'Fixture Agent'}}});
  await change({action:'install',path:dir});let agent=(await connection.rpc<any>('state')).agents.find((a:any)=>a.name==='Fixture Agent');assert.ok(agent.id);
  const versions=(server as any).agentVersions as Map<string,number>,revision=versions.get(agent.id);await change({action:'disable',id:'resources'});await change({action:'enable',id:'resources'});assert.equal(versions.get(agent.id),revision,'Unrelated plugins must not invalidate in-flight Agent history reads');
  const owned=await connection.rpc<any>('createSession',{projectId:project.id,title:'Plugin Agent',agent:agent.id});
  await change({action:'configure',id:'example.integration',config:{name:'Renamed Fixture'}});assert.equal((await connection.rpc<any>('state')).agents.find((a:any)=>a.name==='Renamed Fixture').id,agent.id);
  await assert.rejects(connection.rpc('deleteAgent',{agentId:agent.id}),/卸载接入插件/);
  await change({action:'disable',id:'example.integration'});await assert.rejects(connection.rpc('start',{sessionId:owned.id,cols:90,rows:20}),/未启用/);
  await change({action:'enable',id:'example.integration'});await connection.rpc('stop',{sessionId:session.id});connection.close();await server.close();
  server=new DaemonServer(directory);connection=await DaemonConnection.open(await server.listen(),()=>{});const state=await connection.rpc<any>('state');assert.equal(state.agents.find((a:any)=>a.name==='Renamed Fixture').id,agent.id);assert.equal(state.sessions.find((s:any)=>s.id===owned.id).agent,agent.id);
});

test('Cordis singleton is shared with external plugins and native child injection works',async t=>{
  const root=await fixture(t),runtime=new ExtensionRuntime(path.join(root,'runtime'),host());await runtime.ready;t.after(()=>runtime.close());
  const dir=await source(root,'example.cordis',`const {Context}=require('cordis');exports.apply=async ctx=>{if(!(ctx instanceof Context))throw new Error('duplicate Cordis');ctx.provide('exampleValue',42);await ctx.plugin({inject:['exampleValue'],apply:child=>child.berth.command({name:'read',description:'Read DI',inputSchema:{type:'object'}},()=>child.exampleValue)}).await();};`);
  await runtime.install(dir);assert.equal(await runtime.call('example.cordis','read',{}),42);
});

test('failed initialization times out and releases Cordis effects',async t=>{
  const root=await fixture(t),runtime=new ExtensionRuntime(path.join(root,'runtime'),host());await runtime.ready;t.after(()=>runtime.close());
  const dir=await source(root,'example.slow',`exports.apply=async ctx=>{ctx.effect(()=>{globalThis.__slowMounted=true;return()=>{globalThis.__slowMounted=false;};});await new Promise(()=>{});};`);
  await assert.rejects(runtime.install(dir),/超过 5 秒/);assert.equal((globalThis as any).__slowMounted,false);assert.equal(runtime.snapshot().plugins.some(p=>p.manifest.id==='example.slow'),false);
});

test('named MCP contexts accept scalar plugin results without corrupting ownership metadata',async()=>{
  const {AgentMcp}=await import('../src/mcp/agents');const router=new AgentMcp(()=>({disconnect(){},server:{request:async()=>({content:[{type:'text',text:'123'}]})}}));
  const reply=await router.request('tools/call',{name:'plugin_read',arguments:{agentId:'worker-a'}});assert.deepEqual(JSON.parse(reply.content[0].text),{result:123,agentId:'worker-a'});router.close();
});
