import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {DaemonServer} from '../src/daemon/server';
import {DaemonConnection} from '../src/main/connection';
import {acpOptionChoices,type AcpSnapshot} from '../src/shared/acp';

// Optional real CLI integration. This never submits a prompt, authenticates,
// installs hooks, reads the developer's profile or calls a model provider.
const executable=process.env.AGENTBERTH_OPENCODE_TEST_EXECUTABLE;
test('real OpenCode ACP negotiates options, changes model/plan mode and loads the same native session',{skip:!executable,timeout:90000},async t=>{
  assert.ok(path.isAbsolute(executable!),'Use an absolute path to the test-only OpenCode binary');
  const dir=await mkdtemp(path.join(os.tmpdir(),'berth-opencode-acp-')),root=path.join(dir,'project'),profile=path.join(dir,'profile');
  await mkdir(root);for(const name of ['config','data','cache','state'])await mkdir(path.join(profile,name),{recursive:true});
  const config=path.join(profile,'config.json');
  await writeFile(config,JSON.stringify({autoupdate:false,share:'disabled',enabled_providers:['validation'],model:'validation/one',provider:{validation:{npm:'@ai-sdk/openai-compatible',name:'Local validation',options:{baseURL:'http://127.0.0.1:9/v1',apiKey:'validation-placeholder'},models:{one:{name:'Validation One',limit:{context:8192,output:1024}},two:{name:'Validation Two',limit:{context:8192,output:1024}}}}}}));
  const server=new DaemonServer(path.join(dir,'workbench')),connection=await DaemonConnection.open(await server.listen(),()=>{});
  t.after(async()=>{connection.close();await server.close();await rm(dir,{recursive:true,force:true,maxRetries:8,retryDelay:100});});
  const project=await connection.rpc<any>('createProject',{name:'OpenCode ACP validation',path:root}),agent=await connection.rpc<any>('createAgent',{name:'Real OpenCode ACP',command:executable!,acp:{executable:executable!,args:['acp'],env:{XDG_CONFIG_HOME:path.join(profile,'config'),XDG_DATA_HOME:path.join(profile,'data'),XDG_CACHE_HOME:path.join(profile,'cache'),XDG_STATE_HOME:path.join(profile,'state'),OPENCODE_CONFIG:config,OPENCODE_CONFIG_DIR:path.join(profile,'config'),OPENCODE_DISABLE_AUTOUPDATE:'1',OPENCODE_DISABLE_MODELS_FETCH:'1'}}});
  const session=await connection.rpc<any>('createSession',{projectId:project.id,title:'Real ACP conversation',agent:agent.id});
  await connection.rpc('start',{sessionId:session.id,cols:100,rows:30});
  const snapshot=()=>connection.rpc<AcpSnapshot>('acpSnapshot',{sessionId:session.id}),initial=await snapshot();
  assert.equal(initial.agentInfo?.name,'OpenCode');t.diagnostic('OpenCode '+String(initial.agentInfo?.version)+' · ACP v1');assert.equal(initial.phase,'ready');assert.ok(initial.nativeSessionId);assert.equal(initial.capabilities?.loadSession,true);
  const mode=initial.configOptions?.find(option=>option.category==='mode'),model=initial.configOptions?.find(option=>option.category==='model');assert.ok(mode);assert.ok(model);assert.ok(acpOptionChoices(mode).some(option=>option.value==='plan'));assert.ok(acpOptionChoices(model).some(option=>option.value==='validation/two'));
  await connection.rpc('acpConfigure',{sessionId:session.id,configId:mode.id,value:'plan'});assert.equal((await snapshot()).configOptions?.find(option=>option.id===mode.id)?.currentValue,'plan');
  await connection.rpc('acpConfigure',{sessionId:session.id,configId:model.id,value:'validation/two'});assert.equal((await snapshot()).configOptions?.find(option=>option.id===model.id)?.currentValue,'validation/two');
  await connection.rpc('stop',{sessionId:session.id});await connection.rpc('start',{sessionId:session.id,resume:true,cols:100,rows:30});assert.equal((await snapshot()).nativeSessionId,initial.nativeSessionId);
});
