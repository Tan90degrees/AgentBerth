import {elicitationControls} from '../shared/elicitation-controls';

export const interactionView=String.raw`
const buildElicitation=${elicitationControls.toString()};
const interactionCards=new Map(),interactionDrafts=new Map();
function renderInteractions(result){
  const host=$('agentInteractions'),task=result.task,requests=result.interactions,keys=new Set();host.hidden=!requests||!(requests.permissions.length||requests.elicitations.length);
  function live(){return selected===task.id&&current?.attempt===task.attempt;}
  function respond(kind,id,params){if(!live())return Promise.reject(new Error('任务状态已变化，请核对当前请求'));return call('respond',{id:task.id,sessionId:requests.sessionId,requestId:id,kind,...params}).then(async function(){if(live())await detail();});}
  if(requests){
    requests.elicitations.forEach(function(stub){const key=task.id+'|'+requests.sessionId+'|'+stub.id;keys.add(key);if(interactionCards.has(key))return;const container=document.createElement('div'),card={node:container,dispose:function(){container.remove()}};host.append(container);interactionCards.set(key,card);
      if(stub.external){
        const section=document.createElement('section'),title=document.createElement('h3'),actions=document.createElement('div'),open=document.createElement('button');
        section.className='agent-input-card';title.textContent=stub.message;
        actions.className='agent-input-actions';open.type='button';open.className='primary';open.textContent='打开内部会话';
        open.onclick=function(){if(live())agentberth.openSession(requests.sessionId);};
        actions.append(open);section.append(title,actions);container.append(section);return;
      }
      function load(){container.textContent='正在读取提问…';call('interaction',{id:task.id,sessionId:requests.sessionId,requestId:stub.id,kind:'elicitation'}).then(function(request){if(!live()||interactionCards.get(key)!==card){if(interactionCards.get(key)===card){card.dispose();interactionCards.delete(key);}return;}container.replaceChildren();card.dispose=buildElicitation(container,request,function(action,content){return respond('elicitation',request.id,{action,content})},function(message){if(live())error(message)},interactionDrafts);}).catch(function(reason){if(!live()||interactionCards.get(key)!==card){if(interactionCards.get(key)===card){card.dispose();interactionCards.delete(key);}return;}container.textContent=String(reason);const retry=document.createElement('button');retry.textContent='重试读取';retry.onclick=load;container.append(retry);});}load();});
    requests.permissions.forEach(function(stub){const key=task.id+'|'+requests.sessionId+'|'+stub.id;keys.add(key);if(interactionCards.has(key))return;const container=document.createElement('div'),entry={node:container,dispose:function(){container.remove()}};host.append(container);interactionCards.set(key,entry);
      function load(){container.textContent='正在读取授权请求…';call('interaction',{id:task.id,sessionId:requests.sessionId,requestId:stub.id,kind:'permission'}).then(function(permission){if(!live()||interactionCards.get(key)!==entry){if(interactionCards.get(key)===entry){entry.dispose();interactionCards.delete(key);}return;}container.replaceChildren();const card=document.createElement('section'),heading=document.createElement('h3'),actions=document.createElement('div'),failure=document.createElement('p');card.className='agent-input-card agent-permission-card';card.setAttribute('aria-label','Agent 授权请求');heading.textContent=permission.title;actions.className='agent-input-actions';failure.setAttribute('role','alert');failure.className='agent-input-error';card.append(heading);
      if(permission.toolCall){const details=document.createElement('details'),summary=document.createElement('summary'),pre=document.createElement('pre');summary.textContent='操作详情';pre.textContent=JSON.stringify(permission.toolCall.rawInput??permission.toolCall,null,2);details.append(summary,pre);card.append(details);}
      let busy=false;permission.options.concat([{optionId:null,name:'取消授权',kind:'cancel'}]).forEach(function(option){const button=document.createElement('button');button.type='button';button.textContent=option.name;if(option.kind==='allow_once')button.className='primary';else if(option.kind.startsWith('reject'))button.className='danger-action';button.onclick=async function(){if(busy)return;busy=true;actions.querySelectorAll('button').forEach(function(node){node.disabled=true});failure.textContent='';try{await respond('permission',permission.id,{optionId:option.optionId})}catch(reason){if(live()){failure.textContent=String(reason);error(reason)}}finally{busy=false;actions.querySelectorAll('button').forEach(function(node){node.disabled=false});}};actions.append(button);});card.append(actions,failure);container.append(card);}).catch(function(reason){if(!live()||interactionCards.get(key)!==entry){if(interactionCards.get(key)===entry){entry.dispose();interactionCards.delete(key);}return;}container.textContent=String(reason);const retry=document.createElement('button');retry.textContent='重试读取';retry.onclick=load;container.append(retry);});}load();
    });
  }
  interactionCards.forEach(function(value,key){if(!keys.has(key)){value.dispose();value.node.remove();interactionCards.delete(key);}});
}
`;
