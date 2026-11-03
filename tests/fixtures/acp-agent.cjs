const readline=require('node:readline'),fs=require('node:fs'),path=require('node:path'),{randomUUID}=require('node:crypto');
const directory=process.argv[2],log=path.join(directory,'calls.jsonl'),database=path.join(directory,'sessions.json');
let sessions={};try{sessions=JSON.parse(fs.readFileSync(database,'utf8'));}catch{}
let authenticated=!process.argv.includes('--auth'),model='small',mode='build',sequence=0,pending=new Map(),turns=new Map();
const send=value=>process.stdout.write(JSON.stringify({jsonrpc:'2.0',...value})+'\n');
const record=value=>fs.appendFileSync(log,JSON.stringify(value)+'\n');
const result=(id,value)=>send({id,result:value});
const error=(id,code,message)=>send({id,error:{code,message}});
const update=(sessionId,value)=>send({method:'session/update',params:{sessionId,update:value}});
const text=(sessionId,value)=>update(sessionId,{sessionUpdate:'agent_message_chunk',content:{type:'text',text:value}});
const configs=()=>[{id:process.argv.includes('--named-model')?'provider-model':'model',name:'模型',type:'select',category:'model',currentValue:model,options:[{value:'small',name:'Small'},{value:'large',name:'Large'}]},...(process.argv.includes('--config-modes')?[{id:'mode',name:'Session Mode',category:'mode',type:'select',currentValue:mode,options:[{value:'build',name:'Build'},{value:'plan',name:'Plan'}]}]:[])];
const metadata=()=>({...(!process.argv.includes('--config-modes')?{modes:{currentModeId:mode,availableModes:[{id:'build',name:'Build'},{id:'plan',name:'Plan'}]}}:{}),configOptions:configs()});
const call=(method,params)=>new Promise((resolve,reject)=>{const id='client-'+ ++sequence;pending.set(id,{resolve,reject});send({id,method,params});});
const permission=sessionId=>call('session/request_permission',{sessionId,toolCall:{toolCallId:'file-write',title:'Write note.txt',kind:'edit',status:'pending'},options:[{optionId:'allow',kind:'allow_once',name:'允许一次'},{optionId:'reject',kind:'reject_once',name:'拒绝'}]});
async function prompt(message){const p=message.params,content=p.prompt.map(item=>item.text??'').join(''),sessionId=p.sessionId;record({method:'prompt',sessionId,model,text:content});
  if(content==='disconnect'){text(sessionId,'partial before disconnect');setTimeout(()=>process.exit(1),30);return;}
  if(content==='long'){let n=0;const timer=setInterval(()=>text(sessionId,'stream '+ ++n+'\n'),20);turns.set(sessionId,{id:message.id,timer});return;}
  if(process.argv.includes('--hold-worker')&&content.includes('你是 Superagent 的独立执行器')&&!sessions[sessionId].workerSeen){sessions[sessionId].workerSeen=true;fs.writeFileSync(database,JSON.stringify(sessions));const timer=setInterval(()=>text(sessionId,'worker running\n'),150);turns.set(sessionId,{id:message.id,timer});return;}
  if(content==='multiple-permissions'){const requests=[permission(sessionId),permission(sessionId)];turns.set(sessionId,{id:message.id});const outcomes=await Promise.all(requests);record({method:'permission-results',outcomes});text(sessionId,'permissions resolved');turns.delete(sessionId);result(message.id,{stopReason:'cancelled'});return;}
  if(content==='rich'||content==='/rich'){
    update(sessionId,{sessionUpdate:'plan',entries:[{content:'检查配置',status:'in_progress',priority:'high'},{content:'更新文件',status:'pending',priority:'medium'}]});
    update(sessionId,{sessionUpdate:'tool_call',toolCallId:'read-config',title:'读取项目配置',kind:'read',status:'in_progress',rawInput:{path:'base.txt'},locations:[{path:path.join(sessions[sessionId].cwd,'base.txt'),line:1}]});
    text(sessionId,'正在核对配置。');
    update(sessionId,{sessionUpdate:'agent_thought_chunk',content:{type:'text',text:'先检查现有配置，再验证变更。'}});
    update(sessionId,{sessionUpdate:'tool_call_update',toolCallId:'read-config',status:'completed',content:[{type:'content',content:{type:'text',text:'已读取配置，包含 **两个**字段。'}}],rawOutput:{ok:true}});
    update(sessionId,{sessionUpdate:'tool_call',toolCallId:'edit-config',title:'更新配置',kind:'edit',status:'in_progress',rawInput:{path:'base.txt'}});
    update(sessionId,{sessionUpdate:'tool_call_update',toolCallId:'edit-config',status:'completed',content:[{type:'diff',path:path.join(sessions[sessionId].cwd,'base.txt'),oldText:'enabled = false\n',newText:'enabled = true\n'}]});
    update(sessionId,{sessionUpdate:'plan',entries:[{content:'检查配置',status:'completed',priority:'high'},{content:'更新文件',status:'completed',priority:'medium'}]});
    text(sessionId,'## 验证结果\n\n已完成 **配置检查**。\n\n```json\n{"ok": true}\n```\n\n| 检查项 | 结果 |\n| --- | --- |\n| 配置 | 通过 |');result(message.id,{stopReason:'end_turn'});return;
  }
  if(content==='permission'){const approval=await permission(sessionId);record({method:'permission-result',approval});if(approval.outcome.outcome==='selected'&&approval.outcome.optionId==='allow')await call('fs/write_text_file',{sessionId,path:path.join(sessions[sessionId].cwd,'note.txt'),content:'ACP_WRITE_OK'});text(sessionId,'permission complete');}
  else if(content==='terminal'){const terminal=await call('terminal/create',{sessionId,command:process.execPath,args:['-e',"process.stdout.write('ACP_TERMINAL_OK')"],env:[{name:'ELECTRON_RUN_AS_NODE',value:'1'}],outputByteLimit:4096});await call('terminal/wait_for_exit',{sessionId,...terminal});update(sessionId,{sessionUpdate:'tool_call',toolCallId:'terminal-command',title:'运行验证命令',kind:'execute',status:'in_progress',rawInput:{command:process.execPath,args:['-e',"process.stdout.write('ACP_TERMINAL_OK')"]},content:[{type:'terminal',terminalId:terminal.terminalId}]});const output=await call('terminal/output',{sessionId,...terminal});await call('terminal/release',{sessionId,...terminal});update(sessionId,{sessionUpdate:'tool_call_update',toolCallId:'terminal-command',status:'completed'});text(sessionId,output.output);}
  else if(content==='paging'){for(let i=0;i<120;i++)text(sessionId,'ROW-'+String(i).padStart(3,'0')+'\n');}
  else if(content.includes('你是 Superagent 的协调者')){if(content.includes('prose-report'))text(sessionId,'已分析任务，建议如下：\n```json\n');text(sessionId,JSON.stringify(content.includes('ask-human')&&!content.includes('用户回答 / 新指令：')?{action:'ask',question:'请选择验收条件',reason:'缺少信息',...(content.includes('ask-choices')?{questions:[{header:'验收方式',question:'请选择验收条件',options:[{label:'验证文件内容',description:'检查 result.txt 与预期一致'},{label:'运行自动化测试',description:'执行相关回归测试'}]}]}:{})}:{action:'execute',assignment:'在当前工作区创建 result.txt，内容 SUPERAGENT_OK，并验证文件内容。',reason:'可以独立执行'}));if(content.includes('prose-report'))text(sessionId,'\n```\n等待后续步骤。');}
  else if(content.includes('你是 Superagent 的独立执行器')){const approval=await permission(sessionId);if(approval.outcome.optionId==='allow'){await call('fs/write_text_file',{sessionId,path:path.join(sessions[sessionId].cwd,'result.txt'),content:'SUPERAGENT_OK'});text(sessionId,JSON.stringify({status:'ready',summary:'Created result.txt; fake validated',question:''}));}else text(sessionId,JSON.stringify({status:'blocked',summary:'permission denied',question:'需要写入权限'}));}
  else{text(sessionId,'hello ');await new Promise(resolve=>setTimeout(resolve,20));text(sessionId,'from '+model);}
  result(message.id,{stopReason:'end_turn'});
}
readline.createInterface({input:process.stdin}).on('line',line=>{void(async()=>{const message=JSON.parse(line);if(!message.method){const request=pending.get(String(message.id));if(request){pending.delete(String(message.id));message.error?request.reject(new Error(message.error.message)):request.resolve(message.result);}return;}
  const p=message.params??{};
  if(message.method==='initialize'){if(process.argv.includes('--slow-init'))await new Promise(resolve=>setTimeout(resolve,400));record({method:'initialize',capabilities:p.clientCapabilities,arguments:process.argv.slice(3)});result(message.id,{protocolVersion:1,agentInfo:{name:'fixture-acp',version:'1.0'},agentCapabilities:{loadSession:!process.argv.includes('--no-load')},authMethods:process.argv.includes('--auth')?[{id:'login',name:'Fixture login'}]:[]});}
  else if(message.method==='authenticate'){authenticated=true;result(message.id,{});}
  else if(message.method==='session/new'){if(!authenticated){error(message.id,-32000,'Authentication required');return;}const sessionId=randomUUID();sessions[sessionId]={cwd:p.cwd};fs.writeFileSync(database,JSON.stringify(sessions));record({method:'new',sessionId,cwd:p.cwd});result(message.id,{sessionId,...metadata()});update(sessionId,{sessionUpdate:'available_commands_update',availableCommands:[{name:'rich',description:'查看工具与 Markdown 展示示例'}]});}
  else if(message.method==='session/load'){record({method:'load',sessionId:p.sessionId});if(!sessions[p.sessionId]){error(message.id,-32001,'Session not found');return;}text(p.sessionId,'REMOTE_REPLAY_SHOULD_NOT_DUPLICATE');update(p.sessionId,{sessionUpdate:'tool_call',toolCallId:'replayed-tool',title:'REMOTE_REPLAY_TOOL',status:'completed'});update(p.sessionId,{sessionUpdate:'plan',entries:[{content:'REMOTE_REPLAY_PLAN',status:'completed',priority:'medium'}]});result(message.id,metadata());}
  else if(message.method==='session/set_mode'){if(process.argv.includes('--slow-mode'))await new Promise(resolve=>setTimeout(resolve,500));if(process.argv.includes('--fail-mode')){error(message.id,-32603,'fixture mode failed');return;}mode=p.modeId;result(message.id,{});}
  else if(message.method==='session/set_config_option'){record({method:'config',sessionId:p.sessionId,configId:p.configId,value:p.value});if(p.configId==='mode')mode=p.value;else model=p.value;result(message.id,{configOptions:configs()});}
  else if(message.method==='session/prompt')await prompt(message);
  else if(message.method==='session/cancel'){record({method:'cancel',sessionId:p.sessionId});const turn=turns.get(p.sessionId);if(turn?.timer){clearInterval(turn.timer);turns.delete(p.sessionId);result(turn.id,{stopReason:'cancelled'});}}
  else if(message.id!==undefined)error(message.id,-32601,'Method not found');
})().catch(failure=>{process.stderr.write(String(failure)+'\n');process.exitCode=1;});});
