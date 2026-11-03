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
const configs=()=>[{id:'model',name:'模型',type:'select',category:'model',currentValue:model,options:[{value:'small',name:'Small'},{value:'large',name:'Large'}]},...(process.argv.includes('--config-modes')?[{id:'mode',name:'Session Mode',category:'mode',type:'select',currentValue:mode,options:[{value:'build',name:'Build'},{value:'plan',name:'Plan'}]}]:[])];
const metadata=()=>({...(!process.argv.includes('--config-modes')?{modes:{currentModeId:mode,availableModes:[{id:'build',name:'Build'},{id:'plan',name:'Plan'}]}}:{}),configOptions:configs()});
const call=(method,params)=>new Promise((resolve,reject)=>{const id='client-'+ ++sequence;pending.set(id,{resolve,reject});send({id,method,params});});
const permission=sessionId=>call('session/request_permission',{sessionId,toolCall:{toolCallId:'file-write',title:'Write note.txt',kind:'edit',status:'pending'},options:[{optionId:'allow',kind:'allow_once',name:'允许一次'},{optionId:'reject',kind:'reject_once',name:'拒绝'}]});
async function prompt(message){const p=message.params,content=p.prompt.map(item=>item.text??'').join(''),sessionId=p.sessionId;record({method:'prompt',sessionId,text:content});
  if(content==='disconnect'){text(sessionId,'partial before disconnect');setTimeout(()=>process.exit(1),30);return;}
  if(content==='long'){let n=0;const timer=setInterval(()=>text(sessionId,'stream '+ ++n+'\n'),20);turns.set(sessionId,{id:message.id,timer});return;}
  if(content==='multiple-permissions'){const requests=[permission(sessionId),permission(sessionId)];turns.set(sessionId,{id:message.id});const outcomes=await Promise.all(requests);record({method:'permission-results',outcomes});text(sessionId,'permissions resolved');turns.delete(sessionId);result(message.id,{stopReason:'cancelled'});return;}
  if(content==='permission'){const approval=await permission(sessionId);record({method:'permission-result',approval});if(approval.outcome.outcome==='selected'&&approval.outcome.optionId==='allow')await call('fs/write_text_file',{sessionId,path:path.join(sessions[sessionId].cwd,'note.txt'),content:'ACP_WRITE_OK'});text(sessionId,'permission complete');}
  else if(content==='terminal'){const terminal=await call('terminal/create',{sessionId,command:process.execPath,args:['-e',"process.stdout.write('ACP_TERMINAL_OK')"],env:[{name:'ELECTRON_RUN_AS_NODE',value:'1'}],outputByteLimit:4096});await call('terminal/wait_for_exit',{sessionId,...terminal});const output=await call('terminal/output',{sessionId,...terminal});await call('terminal/release',{sessionId,...terminal});text(sessionId,output.output);}
  else if(content==='paging'){for(let i=0;i<120;i++)text(sessionId,'ROW-'+String(i).padStart(3,'0')+'\n');}
  else if(content.includes('你是 Superagent 的协调者')){text(sessionId,JSON.stringify(content.includes('ask-human')?{action:'ask',question:'请选择验收条件',reason:'缺少信息'}:{action:'execute',assignment:'在当前工作区创建 result.txt，内容 SUPERAGENT_OK，并验证文件内容。',reason:'可以独立执行'}));}
  else if(content.includes('你是 Superagent 的独立执行器')){const approval=await permission(sessionId);if(approval.outcome.optionId==='allow'){await call('fs/write_text_file',{sessionId,path:path.join(sessions[sessionId].cwd,'result.txt'),content:'SUPERAGENT_OK'});text(sessionId,JSON.stringify({status:'ready',summary:'Created result.txt; fake validated',question:''}));}else text(sessionId,JSON.stringify({status:'blocked',summary:'permission denied',question:'需要写入权限'}));}
  else{text(sessionId,'hello ');await new Promise(resolve=>setTimeout(resolve,20));text(sessionId,'from '+model);}
  result(message.id,{stopReason:'end_turn'});
}
readline.createInterface({input:process.stdin}).on('line',line=>{void(async()=>{const message=JSON.parse(line);if(!message.method){const request=pending.get(String(message.id));if(request){pending.delete(String(message.id));message.error?request.reject(new Error(message.error.message)):request.resolve(message.result);}return;}
  const p=message.params??{};
  if(message.method==='initialize'){if(process.argv.includes('--slow-init'))await new Promise(resolve=>setTimeout(resolve,400));record({method:'initialize',capabilities:p.clientCapabilities,arguments:process.argv.slice(3)});result(message.id,{protocolVersion:1,agentInfo:{name:'fixture-acp',version:'1.0'},agentCapabilities:{loadSession:!process.argv.includes('--no-load')},authMethods:process.argv.includes('--auth')?[{id:'login',name:'Fixture login'}]:[]});}
  else if(message.method==='authenticate'){authenticated=true;result(message.id,{});}
  else if(message.method==='session/new'){if(!authenticated){error(message.id,-32000,'Authentication required');return;}const sessionId=randomUUID();sessions[sessionId]={cwd:p.cwd};fs.writeFileSync(database,JSON.stringify(sessions));record({method:'new',sessionId,cwd:p.cwd});result(message.id,{sessionId,...metadata()});}
  else if(message.method==='session/load'){record({method:'load',sessionId:p.sessionId});if(!sessions[p.sessionId]){error(message.id,-32001,'Session not found');return;}text(p.sessionId,'REMOTE_REPLAY_SHOULD_NOT_DUPLICATE');result(message.id,metadata());}
  else if(message.method==='session/set_mode'){if(process.argv.includes('--slow-mode'))await new Promise(resolve=>setTimeout(resolve,500));if(process.argv.includes('--fail-mode')){error(message.id,-32603,'fixture mode failed');return;}mode=p.modeId;result(message.id,{});}
  else if(message.method==='session/set_config_option'){record({method:'config',configId:p.configId,value:p.value});if(p.configId==='mode')mode=p.value;else model=p.value;result(message.id,{configOptions:configs()});}
  else if(message.method==='session/prompt')await prompt(message);
  else if(message.method==='session/cancel'){record({method:'cancel',sessionId:p.sessionId});const turn=turns.get(p.sessionId);if(turn?.timer){clearInterval(turn.timer);turns.delete(p.sessionId);result(turn.id,{stopReason:'cancelled'});}}
  else if(message.id!==undefined)error(message.id,-32601,'Method not found');
})().catch(failure=>{process.stderr.write(String(failure)+'\n');process.exitCode=1;});});
