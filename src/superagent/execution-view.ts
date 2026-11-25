export const executionView=String.raw`
function renderExecutionBody(host,value,sessionId){
  host.replaceChildren();const data=value.data||{};
  function block(title,text){const section=document.createElement('section'),label=document.createElement('strong'),pre=document.createElement('pre');label.textContent=title;pre.textContent=typeof text==='string'?text:JSON.stringify(text,null,2);section.append(label,pre);host.append(section);}
  function openSession(label){const button=document.createElement('button');button.type='button';button.textContent=label;button.onclick=function(){agentberth.openSession(sessionId);};host.append(button);}
  if(value.kind==='plan'&&data.format==='markdown'){const node=document.createElement('div');node.className='message-text';renderText(node,value.text);host.append(node);return;}
  if(value.kind==='subagent'){block('子代理',data.description||data.title||value.text);return;}
  if(value.kind==='compaction'||value.kind==='session-message'){
    const blocks=data.summary||data.blocks||(data.block?[data.block]:[]);
    const text=blocks.filter(function(block){return block?.type==='text';}).map(function(block){return block.text;}).join('');
    if(text||data.error){const node=document.createElement('div');node.className='message-text';renderText(node,text||data.error);host.append(node);}
    if(!text||blocks.some(function(block){return block?.type!=='text';}))openSession('打开会话记录');
    return;
  }
  if(value.kind==='terminal'){block('终端输出',data.output||'');return;}
  if(value.kind==='plan'&&Array.isArray(data.entries)){const list=document.createElement('ol');list.className='execution-plan';data.entries.forEach(function(entry){const item=document.createElement('li');item.dataset.status=entry.status;item.textContent=({completed:'✓ ',in_progress:'◉ ',pending:'○ '}[entry.status]||'○ ')+String(entry.content||'');list.append(item)});host.append(list);return;}
  if(data.rawInput!==undefined)block(data.kind==='execute'?'命令 / 参数':'输入参数',data.rawInput);
  (Array.isArray(data.content)?data.content:[]).forEach(function(item){if(item.type==='diff'){block(item.path||'文件改动','');block('修改前',item.oldText??'');block('修改后',item.newText??'');return;}const content=item.content||item;if(content.mediaId){openSession('在会话中预览附件');return;}if(content.type==='terminal'){openSession('在会话中查看终端');return;}if(content.type==='session'){openSession('在会话中查看子代理');return;}if(content.type==='text'){const node=document.createElement('div');node.className='message-text';renderText(node,String(content.text||''));host.append(node)}else if(content.type==='image'&&typeof content.data==='string'&&/^image\/(png|jpeg|webp|gif)$/i.test(content.mimeType||'')){const image=document.createElement('img');image.alt='Agent 返回的图片';image.src='data:'+content.mimeType+';base64,'+content.data;image.style.maxWidth='100%';host.append(image)}else block(content.type==='terminal'?'终端记录':'工具内容',content);});
  if(data.rawOutput!==undefined)block('返回结果',data.rawOutput);
  if(!host.children.length)block(value.kind==='tool'?'工具详情':'记录内容',Object.keys(data).length?data:value.text);
}
function renderExecutionEvents(result){
  const events=result.execution?.events||[],host=$('executionEvents'),scope=result.task.id+'/'+result.execution?.sessionId;if(host.dataset.scope!==scope){host.replaceChildren();host.dataset.scope=scope;}const existing=new Map(Array.from(host.children).map(function(node){return [node.dataset.event,node]})),taskId=result.task.id,sessionId=result.execution?.sessionId;host.querySelector('.empty')?.remove();
  events.forEach(function(event,index){let row=existing.get(event.id);existing.delete(event.id);if(!row){row=document.createElement('details');row.className='execution-event-card';row.dataset.event=event.id;const summary=document.createElement('summary'),badge=document.createElement('span'),text=document.createElement('span'),time=document.createElement('time'),body=document.createElement('div');badge.className='execution-event-status';summary.append(badge,text,time);body.className='execution-event-body';row.append(summary,body);}const summary=row.children[0],body=row.children[1];row.dataset.status=event.status||event.kind;summary.children[0].textContent=event.kind==='tool'?({pending:'待执行',in_progress:'执行中',completed:'已完成',failed:'失败'}[event.status]||'工具'):({permission:'授权',elicitation:'提问',notice:'通知',error:'错误',turn:'轮次',plan:'计划',compaction:'上下文',subagent:'子代理','session-message':'协作消息',terminal:'终端'}[event.kind]||'事件');summary.children[1].textContent=event.text;summary.children[2].textContent=formatTime(event.at);
    if(row.dataset.sequence!==String(event.sequence)){row.dataset.sequence=String(event.sequence);body.replaceChildren();row.dataset.loaded='';}
    row.ontoggle=function(){if(!row.open||row.dataset.loaded||!sessionId)return;const sequence=String(event.sequence);row.dataset.loaded='loading';body.textContent='正在读取…';call('execution_detail',{id:taskId,sessionId,sequence:event.sequence}).then(function(value){if(row.isConnected&&selected===taskId&&row.dataset.sequence===sequence){renderExecutionBody(body,value,sessionId);row.dataset.loaded='done';}}).catch(function(reason){if(row.isConnected&&selected===taskId&&row.dataset.sequence===sequence){body.textContent=String(reason);row.dataset.loaded='';}});};
    if(host.children[index]!==row)host.insertBefore(row,host.children[index]||null);if(row.open&&!row.dataset.loaded)row.ontoggle();
  });existing.forEach(function(row){row.remove()});if(!events.length){const node=document.createElement('p');node.className='empty';node.textContent=result.execution?.error||'暂无执行记录';host.append(node);}
  $('executionTraceHint').textContent=result.execution?.hasEarlier?'· 最近 8 项':'';$('fullExecution').disabled=!(result.task.stage==='worker'?result.sessions.worker:result.sessions.coordinator);$('fullExecution').onclick=function(){agentberth.openSession(result.task.stage==='worker'?result.task.workerSession:result.task.coordinatorSession)};
}
`;
