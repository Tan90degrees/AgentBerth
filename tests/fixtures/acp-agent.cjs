const readline=require('node:readline'),fs=require('node:fs'),path=require('node:path'),{randomUUID}=require('node:crypto');
const directory=process.argv[2],log=path.join(directory,'calls.jsonl'),database=path.join(directory,'sessions.json');
let sessions={};try{sessions=JSON.parse(fs.readFileSync(database,'utf8'));}catch{}
const modern=process.argv.includes('--v1'),terminalAuth=process.argv.includes('--terminal-auth'),login=path.join(directory,'login');
if(process.argv.includes('--login')){
  process.stdout.write('FIXTURE_LOGIN> ');
  const input=readline.createInterface({input:process.stdin,crlfDelay:Infinity});
  input.on('line',value=>{
    if(value.trim()!=='accept')return;
    fs.writeFileSync(login,'ok');
    input.close();
    process.exit(0);
  });
} else {
let authenticated=!process.argv.includes('--auth')&&(!terminalAuth||fs.existsSync(login)),booleanOption=false,model='small',mode='build',sequence=0,pending=new Map(),turns=new Map();
const send=(value,flushed)=>process.stdout.write(JSON.stringify({jsonrpc:'2.0',...value})+'\n',flushed);
const record=value=>fs.appendFileSync(log,JSON.stringify(value)+'\n');
const result=(id,value)=>send({id,result:value});
const error=(id,code,message)=>send({id,error:{code,message}});
const update=(sessionId,value,flushed)=>send({method:'session/update',params:{sessionId,update:value}},flushed);
const text=(sessionId,value,flushed)=>update(sessionId,{sessionUpdate:'agent_message_chunk',content:{type:'text',text:value}},flushed);
const configs=()=>[{id:process.argv.includes('--named-model')?'provider-model':'model',name:'模型',type:'select',category:'model',currentValue:model,options:[{value:'small',name:'Small'},{value:'large',name:'Large'}]},...(modern?[{id:'reasoning',name:'扩展思考',type:'boolean',currentValue:booleanOption}]:[]),...(process.argv.includes('--config-modes')?[{id:'mode',name:'Session Mode',category:'mode',type:'select',currentValue:mode,options:[{value:'build',name:'Build'},{value:'plan',name:'Plan'}]}]:[])];
const metadata=()=>({...(!process.argv.includes('--config-modes')?{modes:{currentModeId:mode,availableModes:[{id:'build',name:'Build'},{id:'plan',name:'Plan'}]}}:{}),configOptions:configs()});
const call=(method,params)=>new Promise((resolve,reject)=>{const id='client-'+ ++sequence;pending.set(id,{resolve,reject});send({id,method,params});});
const permission=(sessionId,toolCall={toolCallId:'file-write',title:'Write note.txt',kind:'edit',status:'pending'})=>call('session/request_permission',{sessionId,toolCall,options:[{optionId:'allow',kind:'allow_once',name:'允许一次'},{optionId:'reject',kind:'reject_once',name:'拒绝'}]});
async function prompt(message){const p=message.params,content=p.prompt.map(item=>item.text??'').join(''),sessionId=p.sessionId;record({method:'prompt',sessionId,model,text:content,...(process.argv.includes('--workbench')||modern?{blocks:p.prompt.map(({type,name,uri,mimeType,resource})=>({type,name,uri,mimeType,resource}))}:{})});
  if(content.includes('acp-url-task')&&content.includes('你是 Superagent 的协调者')){
    const outcome=await call('elicitation/create',{mode:'url',sessionId,elicitationId:'task-url',url:'https://example.invalid/authorize?state=fixture-token',message:'Authorize in browser'});
    record({method:'task-url-result',outcome});
  }
  if(content==='v1 stream'){
    const chunk=(source,messageId,value)=>update(source,{sessionUpdate:'agent_message_chunk',messageId,content:{type:'text',text:value}});
    chunk(sessionId,'one','first ');
    update(sessionId,{sessionUpdate:'tool_call',toolCallId:'parallel',title:'Parent tool',status:'in_progress'});
    chunk(sessionId,'two','second');
    update(sessionId,{sessionUpdate:'subagent_update',sessionId:'child',title:'Review worker',state:{state:'running'},capabilities:{cancel:{}}});
    update('child',{sessionUpdate:'tool_call',toolCallId:'parallel',title:'Child tool',status:'completed'});
    chunk('child','one','child result');
    chunk('unannounced','one','must not be recorded');
    chunk(sessionId,'one','continues');
    update(sessionId,{sessionUpdate:'session_message_chunk',messageId:'direct',content:{type:'text',text:'old'}});
    update(sessionId,{sessionUpdate:'session_message',messageId:'direct',senderSessionId:'child',recipientSessionId:sessionId,content:null});
    update(sessionId,{sessionUpdate:'session_message_chunk',messageId:'direct',content:{type:'text',text:'new'}});
    update(sessionId,{sessionUpdate:'compaction_summary_chunk',compactionId:'context',content:{type:'text',text:'partial'}});
    update(sessionId,{sessionUpdate:'compaction_update',compactionId:'context',status:'completed',summary:[{type:'text',text:'Final context'}]});
    update(sessionId,{sessionUpdate:'plan_update',plan:{type:'items',planId:'gone',entries:[{content:'Remove me',status:'pending',priority:'low'}]}});
    update(sessionId,{sessionUpdate:'plan_removed',planId:'gone'});
    update(sessionId,{sessionUpdate:'plan_update',plan:{type:'markdown',planId:'visible',content:'## V1 plan\n\n**Review**'}});
    update(sessionId,{sessionUpdate:'session_info_update',title:'V1 title',updatedAt:'2026-11-25T00:00:00.000Z'});
    update(sessionId,{sessionUpdate:'notice',severity:'warning',title:'Live V1 notice'});
    update(sessionId,{sessionUpdate:'agent_message_chunk',messageId:'media',content:{type:'resource',resource:{uri:'fixture://artifact.bin',mimeType:'application/octet-stream',blob:Buffer.alloc(96000,42).toString('base64')}}});
    await new Promise(resolve=>setTimeout(resolve,750));
    update(sessionId,{sessionUpdate:'tool_call_update',toolCallId:'parallel',status:'completed'});
    result(message.id,{stopReason:'end_turn'});
    return;
  }
  if(content==='v1 url'){
    const outcome=await call('elicitation/create',{mode:'url',sessionId,elicitationId:'url-1',url:'https://example.invalid/authorize?state=private-fixture',message:'Authorize in browser'});
    record({method:'url-response',outcome});
    send({method:'elicitation/complete',params:{elicitationId:'unknown'}});
    await new Promise(resolve=>setTimeout(resolve,200));
    send({method:'elicitation/complete',params:{elicitationId:'url-1'}});
    result(message.id,{stopReason:'end_turn'});
    return;
  }
  if(content==='v1 cancel callback'){
    const request=permission(sessionId).catch(error=>error.code);
    const requestId='client-'+sequence;
    await new Promise(resolve=>setTimeout(resolve,400));
    send({method:'$/cancel_request',params:{requestId}});
    record({method:'cancelled-callback',code:await request});
    result(message.id,{stopReason:'end_turn'});
    return;
  }
  if(content==='v1 scoped child'){
    const extra=sessions[sessionId].extra;
    update(sessionId,{sessionUpdate:'subagent_update',sessionId:'scoped',cwd:extra,additionalDirectories:[],title:'Scoped helper'});
    const value=await call('fs/read_text_file',{sessionId:'scoped',path:'extra.txt'});
    let rejected=false;
    try{await call('fs/read_text_file',{sessionId:'scoped',path:path.join(sessions[sessionId].cwd,'private.txt')});}catch(error){rejected=true;}
    text(sessionId,JSON.stringify({value:value.content,rejected}));
    result(message.id,{stopReason:'end_turn'});
    return;
  }
  if(content==='v1 live terminal'){
    const terminal=await call('terminal/create',{sessionId,command:process.execPath,args:['-e',"process.stdout.write('first');setTimeout(()=>process.stdout.write('last'),350)"],env:[{name:'ELECTRON_RUN_AS_NODE',value:'1'}]});
    update(sessionId,{sessionUpdate:'tool_call',toolCallId:'live-terminal',title:'Streaming terminal',kind:'execute',status:'in_progress',content:[{type:'terminal',...terminal}]});
    await call('terminal/wait_for_exit',{sessionId,...terminal});
    await call('terminal/release',{sessionId,...terminal});
    result(message.id,{stopReason:'end_turn'});
    return;
  }
  if(content==='elicitation'||content==='elicitation-and-permission'||content.includes('acp-form-questions')&&content.includes('你是 Superagent 的协调者')){
    update(sessionId,{sessionUpdate:'plan',entries:[{content:'收集实现范围',status:'in_progress',priority:'high'},{content:'执行验证',status:'pending',priority:'medium'}]});
    update(sessionId,{sessionUpdate:'tool_call',toolCallId:'ask-user',title:'收集实现选择',kind:'other',status:'in_progress',rawInput:{purpose:'确认范围'}});
    const form=call('elicitation/create',{sessionId,mode:'form',message:'选择实现方案和验证范围',toolCallId:'ask-user',requestedSchema:{type:'object',properties:{strategy:{type:'string',title:'实施方案',oneOf:[{const:'incremental',title:'渐进修改',description:'保留已有行为'},{const:'rebuild',title:'重新构建'}]},checks:{type:'array',title:'验证范围',items:{type:'string',anyOf:[{const:'unit',title:'单元测试'},{const:'ui',title:'界面回归'},{const:'integration',title:'集成测试'}]},minItems:1,maxItems:2},count:{type:'integer',title:'验证轮数',minimum:1,maximum:5,default:2},enabled:{type:'boolean',title:'保留日志',default:false},note:{type:'string',title:'补充说明',maxLength:100}},required:['strategy','checks','count','enabled']}});
    const outcomes=await Promise.all([form,...(content==='elicitation-and-permission'?[permission(sessionId)]:[])]);record({method:'elicitation-results',outcomes});update(sessionId,{sessionUpdate:'tool_call_update',toolCallId:'ask-user',status:'completed',rawOutput:{received:true}});
    if(content==='elicitation'||content==='elicitation-and-permission'){text(sessionId,'elicitation resolved');result(message.id,{stopReason:'end_turn'});return;}
  }
  if(content==='disconnect'){text(sessionId,'partial before disconnect',()=>process.exit(1));return;}
  if(content==='pagination'){for(let i=1;i<=240;i++)update(sessionId,{sessionUpdate:'tool_call',toolCallId:'page-'+i,title:'历史工具 '+i,kind:'read',status:'completed'});text(sessionId,'pagination ready');result(message.id,{stopReason:'end_turn'});return;}
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
  else if(content.includes('你是 Superagent 的独立执行器')){
    if(process.argv.includes('--superagent-tool-policy')){
      const decision=await permission(sessionId,{toolCallId:'run-check',kind:'execute',title:'Run verification',status:'pending'});
      let refused=false;
      try{await call('terminal/create',{sessionId,command:process.execPath,args:['--version']});}catch(error){refused=/Superagent/.test(String(error));}
      let metadataRefused=false;
      try{await call('fs/read_text_file',{sessionId,path:'.git'});}catch(error){metadataRefused=/版本控制元数据/.test(String(error));}
      record({method:'superagent-policy',decision,refused,metadataRefused});
      text(sessionId,JSON.stringify({status:'blocked',summary:'Command requires a trusted runner',question:'Choose a file-only verification'}));result(message.id,{stopReason:'end_turn'});return;
    }
    const approval=await permission(sessionId);if(approval.outcome.optionId==='allow'){await call('fs/write_text_file',{sessionId,path:path.join(sessions[sessionId].cwd,'result.txt'),content:'SUPERAGENT_OK'});text(sessionId,JSON.stringify({status:'ready',summary:'Created result.txt; fake validated',question:'',artifacts:['result.txt','./result.txt','../outside.txt']}));}else text(sessionId,JSON.stringify({status:'blocked',summary:'permission denied',question:'需要写入权限'}));}
  else{if(process.argv.includes('--workbench'))update(sessionId,{sessionUpdate:'usage_update',used:240,size:1000,cost:{amount:0.02,currency:'USD'}});text(sessionId,'hello ');await new Promise(resolve=>setTimeout(resolve,20));text(sessionId,'from '+model);}
  result(message.id,{stopReason:'end_turn'});
}
readline.createInterface({input:process.stdin}).on('line',line=>{void(async()=>{const message=JSON.parse(line);if(!message.method){const request=pending.get(String(message.id));if(request){pending.delete(String(message.id));message.error?request.reject(Object.assign(new Error(message.error.message),{code:message.error.code})):request.resolve(message.result);}return;}
  const p=message.params??{};
  if(message.method==='initialize'){if(process.argv.includes('--never-init')){process.stderr.write('FIXTURE_BOOTSTRAP_WAIT\n');return;}if(process.argv.includes('--slow-init'))await new Promise(resolve=>setTimeout(resolve,400));record({method:'initialize',capabilities:p.clientCapabilities,arguments:process.argv.slice(3)});result(message.id,{protocolVersion:1,agentInfo:{name:'fixture-acp',version:'1.0'},agentCapabilities:process.argv.includes('--resume')?{sessionCapabilities:{resume:{},close:{}}}:{loadSession:!process.argv.includes('--no-load'),...(modern?{auth:{logout:{}}}:{}),...(process.argv.includes('--workbench')?{sessionCapabilities:{list:{},...(modern?{delete:{},additionalDirectories:{},systemPrompt:{mode:{override:{}}}}:{})},promptCapabilities:{image:true,...(modern?{audio:true,embeddedContext:true}:{})},mcpCapabilities:{http:true}}:{})},authMethods:terminalAuth&&p.clientCapabilities?.auth?.terminal?[{id:'login-terminal',name:'Fixture terminal',type:'terminal',args:['--login'],env:{LANG:'C'}}]:process.argv.includes('--auth')?[{id:'login',name:'Fixture login'}]:[]});}
  else if(message.method==='authenticate'){authenticated=true;result(message.id,{});}
  else if(message.method==='logout'&&modern){record({method:'logout'});authenticated=false;result(message.id,{});}
  else if(message.method==='session/delete'&&modern){if(!sessions[p.sessionId]){error(message.id,-32002,'Session not found');return;}delete sessions[p.sessionId];fs.writeFileSync(database,JSON.stringify(sessions));result(message.id,{});}
  else if(message.method==='session/new'){if(!authenticated){error(message.id,-32000,'Authentication required');return;}const sessionId=randomUUID();sessions[sessionId]={cwd:p.cwd,extra:p.additionalDirectories?.[0]};fs.writeFileSync(database,JSON.stringify(sessions));record({method:'new',sessionId,cwd:p.cwd,...(process.argv.includes('--workbench')?{mcpServers:p.mcpServers,additionalDirectories:p.additionalDirectories,systemPrompt:p.systemPrompt}:{})});result(message.id,{sessionId,...metadata()});update(sessionId,{sessionUpdate:'available_commands_update',availableCommands:[{name:'rich',description:'查看工具与 Markdown 展示示例'}]});}
  else if(message.method==='session/list'&&process.argv.includes('--workbench')){result(message.id,{sessions:[...Object.entries(sessions).map(([sessionId,value])=>({sessionId,title:'Fixture history',cwd:value.cwd})),{sessionId:'unrelated',title:'Outside project',cwd:p.cwd+'-unrelated'}]});}
  else if(message.method==='session/resume'){record({method:'resume',sessionId:p.sessionId});if(!sessions[p.sessionId]){error(message.id,-32001,'Session not found');return;}result(message.id,metadata());}
  else if(message.method==='session/close'){record({method:'close',sessionId:p.sessionId});result(message.id,{});}
  else if(message.method==='session/load'){record({method:'load',sessionId:p.sessionId});if(!sessions[p.sessionId]){error(message.id,-32001,'Session not found');return;}text(p.sessionId,'REMOTE_REPLAY_SHOULD_NOT_DUPLICATE');update(p.sessionId,{sessionUpdate:'tool_call',toolCallId:'replayed-tool',title:'REMOTE_REPLAY_TOOL',status:'completed'});update(p.sessionId,{sessionUpdate:'plan',entries:[{content:'REMOTE_REPLAY_PLAN',status:'completed',priority:'medium'}]});result(message.id,metadata());}
  else if(message.method==='session/set_mode'){if(process.argv.includes('--slow-mode'))await new Promise(resolve=>setTimeout(resolve,500));if(process.argv.includes('--fail-mode')){error(message.id,-32603,'fixture mode failed');return;}mode=p.modeId;result(message.id,{});}
  else if(message.method==='session/set_config_option'){record({method:'config',sessionId:p.sessionId,configId:p.configId,value:p.value});if(p.configId==='mode')mode=p.value;else if(p.configId==='reasoning'){if(p.type!=='boolean'||typeof p.value!=='boolean'){error(message.id,-32602,'Boolean config mismatch');return;}booleanOption=p.value;}else model=p.value;result(message.id,{configOptions:configs()});}
  else if(message.method==='session/prompt')await prompt(message);
  else if(message.method==='session/cancel'){record({method:'cancel',sessionId:p.sessionId});const turn=turns.get(p.sessionId);if(turn?.timer){clearInterval(turn.timer);turns.delete(p.sessionId);result(turn.id,{stopReason:'cancelled'});}}
  else if(message.id!==undefined)error(message.id,-32601,'Method not found');
})().catch(failure=>{process.stderr.write(String(failure)+'\n');process.exitCode=1;});});
}
