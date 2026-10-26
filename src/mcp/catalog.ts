const uuid={type:'string',format:'uuid'};
const target={alias:{type:'string',description:'Saved server alias. After a successful call, omission reuses that same session.'},sessionId:uuid,runId:uuid};
const search={type:'object',description:'Search existing captured output; never executes again. limit=0 counts matching lines.',properties:{query:{type:'string',minLength:1,maxLength:256},caseSensitive:{type:'boolean'},contextLines:{type:'integer',minimum:0,maximum:5},limit:{type:'integer',minimum:0,maximum:100},offset:{type:'integer',minimum:0},endCursor:{type:'integer',minimum:0},maxBytes:{type:'integer',minimum:4096,maximum:65536}},required:['query'],additionalProperties:false};
const schema=(properties:Record<string,unknown>,required:string[]=[])=>({type:'object',properties,required,additionalProperties:false});
const transferFields={...target,requestId:uuid,localPath:{type:'string'},remotePath:{type:'string'},sourceAlias:{type:'string'},destinationAlias:{type:'string'},sourceSessionId:uuid,sourceRunId:uuid,destinationSessionId:uuid,destinationRunId:uuid,sourcePath:{type:'string'},destinationPath:{type:'string'},recursive:{type:'boolean',default:false},overwrite:{type:'boolean',default:false},resume:{type:'boolean',default:false},timeoutMs:{type:'integer',minimum:0,maximum:30000,default:25000}};

/** Four advertised choices. Legacy names remain callable for cached clients,
 * but are never suggested in discovery or new continuation pointers. */
export const tools=[
  {name:'terminal_execute',description:'Run an ordinary SSH command and RETURN ITS RESULT in this call. Example {"alias":"dev-server","command":"uname -a"}. Opens/reuses the authorized session and waits for completion (up to 25s), preserving cwd/environment. Read output.text and exitCode directly; do not call an interactive screen to verify it. For long work, call this SAME tool without command using the returned next arguments. Without command it reads/waits for the latest command, never reruns it; alias and actionId may be omitted after a successful call. Short output is complete even if the human terminal is only 5 rows. Large output is bounded; use search or page only for relevant detail. Set waitFor=output only for deliberately streaming/interactive commands. Human takeover is enforced; never replay an unknown outcome.',inputSchema:schema({...target,command:{type:'string',minLength:1,maxLength:16384,description:'Omit to retrieve/continue the previous command, without executing anything.'},actionId:uuid,cursor:{type:'integer',minimum:0,description:'Omit to retrieve the result from its beginning. Returned next arguments use a cursor for new output only.'},waitMs:{type:'integer',minimum:0,maximum:25000,default:25000},waitFor:{type:'string',enum:['completion','output'],default:'completion'},requestId:uuid,search,mode:{type:'string',enum:['summary','page'],default:'summary'},maxChars:{type:'integer',minimum:256,maximum:65536},atPrompt:{type:'boolean',description:'Only after personally observing an idle Shell prompt after untracked input.'},detail:{type:'string',enum:['compact','full'],default:'compact'}})},
  {name:'terminal_interact',description:'Only for TUI/interactive programs or prompt inspection, not for ordinary command results. text sends Enter by default (enter=false for partial typing); key sends a named key once. Returns the resulting viewport in the same call. With no input, view=auto recovers captured command output when possible; view=screen explicitly shows only the visible TUI. A viewport cannot represent a complete command result. Use terminal_execute for ordinary Shell commands.',inputSchema:schema({...target,text:{type:'string',maxLength:16384},enter:{type:'boolean',default:true},key:{type:'string',enum:['Enter','Tab','Escape','Up','Down','Left','Right','Ctrl+C','Ctrl+D','Ctrl+Z','Backspace']},view:{type:'string',enum:['auto','screen'],default:'auto'},detail:{type:'string',enum:['compact','full'],default:'compact'}})},
  {name:'terminal_session',description:'Manage SSH sessions. Omit action to list saved aliases/current sessions. Actions: open (reuse alias), create (alias+title), update, close, delete (stopped only), reconnect (explicit NEW Shell after link loss), actions (recent operation history). Normal commands use terminal_execute directly; no separate open is needed. Never create/reconnect to bypass human control or an unknown previous result. Server credentials are configured in AgentBerth.',inputSchema:schema({action:{type:'string',enum:['list','open','create','update','close','delete','reconnect','actions'],default:'list'},...target,title:{type:'string',minLength:1,maxLength:100},directory:{type:'string'},before:{type:'integer',minimum:1}})},
  {name:'terminal_transfer',description:'SFTP file transfer without interrupting the visible terminal. action=upload/download needs localPath+remotePath and a target; copy needs sourceAlias+sourcePath+destinationAlias+destinationPath. Paths are exact absolute destinations. action=status waits using requestId; cancel cancels that same ID. Directories require recursive=true; overwrite/resume are explicit. IDs are generated and must be retained on retry. Unknown/partial transfers are never automatically repeated. No remote helper is installed.',inputSchema:schema({action:{type:'string',enum:['upload','download','copy','status','cancel']},...transferFields},['action'])},
].map(tool=>({...tool,title:tool.name.replace('terminal_','SSH · '),annotations:{readOnlyHint:false,destructiveHint:true,idempotentHint:false,openWorldHint:true}}));

export function routeTool(name:string,args:Record<string,unknown>):{name:string;args:Record<string,unknown>;interactive?:boolean} {
  const rest={...args};
  if(name==='terminal_session'){
    const action=rest.action??'list';delete rest.action;
    if(!['list','open','create','update','close','delete','reconnect','actions'].includes(action as string))throw new Error('Invalid session action');
    return {name:'terminal_'+action,args:rest};
  }
  if(name==='terminal_transfer'&&rest.action!==undefined){
    const action=rest.action;delete rest.action;
    if(!['upload','download','copy','status','cancel'].includes(action as string))throw new Error('Invalid transfer action');
    return {name:action==='copy'?'terminal_transfer':'terminal_'+(action==='status'?'transfer_status':action==='cancel'?'transfer_cancel':action),args:rest};
  }
  if(name==='terminal_execute'){
    if(rest.command===undefined){
      if(rest.requestId!==undefined||rest.atPrompt!==undefined)throw new Error('Read a previous result with actionId, not requestId/atPrompt. Omit command to read; nothing is executed.');
      rest.timeoutMs=rest.waitMs??25000;delete rest.waitMs;rest.waitFor??='completion';
      return {name:'terminal_read_output',args:rest};
    }
    if(rest.actionId!==undefined||rest.cursor!==undefined)throw new Error('Use command for a new execution OR actionId/cursor to read the previous result, not both.');
    rest.waitMs??=25000;rest.waitFor??='completion';
  }
  if(name==='terminal_interact'){
    if(rest.view!==undefined&&!['auto','screen'].includes(rest.view as string))throw new Error('view must be auto or screen');
    delete rest.view;
    return {name:rest.text!==undefined||rest.key!==undefined?'terminal_keys':'terminal_screen',args:rest,interactive:true};
  }
  return {name,args:rest};
}

/** Rewrite only trusted tool pointers, never arbitrary terminal output text. */
export function publicReply(value:any):any {
  if(!value||typeof value!=='object')return value;
  const pointer=(next:any)=>{
    if(!next?.tool)return next;
    const args={...next.arguments};let tool=next.tool;
    if(['terminal_read_output','terminal_wait'].includes(tool)){args.waitMs=Math.min(25000,args.timeoutMs??25000);args.waitFor='completion';delete args.timeoutMs;tool='terminal_execute';}
    else if(['terminal_screen','terminal_keys'].includes(tool)){if(tool==='terminal_screen')args.view='screen';tool='terminal_interact';}
    else if(['terminal_list','terminal_open','terminal_create','terminal_update','terminal_close','terminal_delete','terminal_reconnect','terminal_actions'].includes(tool)){args.action=tool.slice(9);tool='terminal_session';}
    else if(['terminal_upload','terminal_download','terminal_transfer_status','terminal_transfer_cancel'].includes(tool)){args.action=tool.replace('terminal_','').replace('transfer_','');tool='terminal_transfer';}
    return {...next,tool,arguments:args};
  };
  return {...value,...('continuation'in value?{continuation:pointer(value.continuation)}:{}),...('details'in value?{details:pointer(value.details)}:{}),...(value.harness?{harness:{...value.harness,next:pointer(value.harness.next)}}:{})};
}
