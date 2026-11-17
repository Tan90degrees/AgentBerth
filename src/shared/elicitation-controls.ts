import type {AcpElicitation,ElicitationContent} from './acp-elicitation';

/** Self-contained DOM renderer shared by the React host and sandboxed task view. */
export function elicitationControls(host:HTMLElement,request:AcpElicitation,submit:(action:'accept'|'decline'|'cancel',content?:ElicitationContent)=>Promise<unknown>,report:(message:string)=>void=()=>{},drafts?:Map<string,ElicitationContent>){
  const doc=host.ownerDocument,form=doc.createElement('form'),heading=doc.createElement('h3'),error=doc.createElement('p'),body=doc.createElement('div');let alive=true,busy=false;
  form.className='agent-input-card';form.setAttribute('aria-label','Agent 提问');form.dataset.requestId=request.id;heading.textContent=request.message;error.className='agent-input-error';error.setAttribute('role','alert');body.className='agent-input-fields';form.append(heading,body,error);const readers:{key:string;read:()=>string|number|boolean|string[]|undefined}[]=[];
  request.fields.forEach((original,index)=>{
    const field={...original,...(drafts?.has(request.id)&&Object.hasOwn(drafts.get(request.id)!,original.key)?{default:drafts.get(request.id)![original.key]}:{})};
    const group=doc.createElement('fieldset'),legend=doc.createElement('legend');group.dataset.field=field.key;legend.textContent=field.title+(field.required?' *':'（可选）');group.append(legend);
    if(field.description){const description=doc.createElement('p');description.className='agent-input-description';description.textContent=field.description;group.append(description);}
    if(field.choices){
      const choices=field.choices.map(choice=>{
        const label=doc.createElement('label'),input=doc.createElement('input'),text=doc.createElement('span'),title=doc.createElement('strong');label.className='agent-input-choice';input.type=field.type==='array'?'checkbox':'radio';input.name=request.id+'-'+index;input.value=choice.value;input.checked=Array.isArray(field.default)?field.default.includes(choice.value):field.default===choice.value;title.textContent=choice.label;text.append(title);if(choice.description){const small=doc.createElement('small');small.textContent=choice.description;text.append(small);}label.append(input,text);group.append(label);return input;
      });readers.push({key:field.key,read:()=>field.type==='array'?choices.filter(input=>input.checked).map(input=>input.value):choices.find(input=>input.checked)?.value});
    }else if(field.type==='boolean'){
      const select=doc.createElement('select');select.setAttribute('aria-label',field.title);for(const [value,title]of [['','请选择'],['true','是'],['false','否']]){const option=doc.createElement('option');option.value=value;option.textContent=title;select.append(option);}if(typeof field.default==='boolean')select.value=String(field.default);select.required=field.required;group.append(select);readers.push({key:field.key,read:()=>select.value===''?undefined:select.value==='true'});
    }else{
      const input=doc.createElement('input');input.setAttribute('aria-label',field.title);input.type=field.type==='number'||field.type==='integer'?'number':field.format==='email'?'email':field.format==='date'?'date':field.format==='password'?'password':'text';input.required=field.required;input.autocomplete='off';
      if(field.type==='integer')input.step='1';else if(field.type==='number')input.step='any';if(field.minimum!==undefined)input.min=String(field.minimum);if(field.maximum!==undefined)input.max=String(field.maximum);if(field.minLength!==undefined)input.minLength=field.minLength;if(field.maxLength!==undefined)input.maxLength=field.maxLength;if(typeof field.default==='string'||typeof field.default==='number')input.value=String(field.default);group.append(input);readers.push({key:field.key,read:()=>input.value===''?undefined:field.type==='number'||field.type==='integer'?Number(input.value):input.value});
    }body.append(group);
  });
  const actions=doc.createElement('div');actions.className='agent-input-actions';
  async function act(action:'accept'|'decline'|'cancel'){
    if(busy)return;error.textContent='';const content:ElicitationContent=Object.create(null);
    if(action==='accept'){
      if(!form.reportValidity())return;
      for(const field of request.fields){const value=readers.find(reader=>reader.key===field.key)!.read();if(value===undefined||Array.isArray(value)&&!value.length){if(field.required||Array.isArray(value)&&(field.minItems??0)>0){error.textContent='请回答：'+field.title;groupFocus(field.key);return;}continue;}if(Array.isArray(value)&&(value.length<(field.minItems??0)||field.maxItems!==undefined&&value.length>field.maxItems)){error.textContent=field.title+'：请选择 '+(field.minItems??0)+'–'+(field.maxItems??field.choices?.length??'全部')+' 项';groupFocus(field.key);return;}content[field.key]=value;}
    }
    busy=true;form.setAttribute('aria-busy','true');form.querySelectorAll<HTMLInputElement|HTMLButtonElement|HTMLSelectElement>('input,select,button').forEach(node=>node.disabled=true);
    try{await submit(action,action==='accept'?content:undefined);drafts?.delete(request.id);}catch(reason){if(alive){error.textContent=String(reason);report(String(reason));}}finally{if(alive){busy=false;form.removeAttribute('aria-busy');form.querySelectorAll<HTMLInputElement|HTMLButtonElement|HTMLSelectElement>('input,select,button').forEach(node=>node.disabled=false);}}
  }
  function groupFocus(key:string){Array.from(body.children).find(node=>(node as HTMLElement).dataset.field===key)?.querySelector<HTMLElement>('input,select')?.focus();}
  for(const [action,title]of [['accept','提交回答'],['decline','拒绝回答'],['cancel','取消']] as const){const button=doc.createElement('button');button.type=action==='accept'?'submit':'button';button.textContent=title;if(action==='accept')button.className='primary';else button.onclick=()=>{void act(action);};actions.append(button);}
  const saveDraft=()=>{if(!drafts)return;const value:ElicitationContent=Object.create(null);for(const reader of readers){const field=request.fields.find(field=>field.key===reader.key)!;if(field.format==='password')continue;const answer=reader.read();if(answer!==undefined)value[reader.key]=answer;}drafts.set(request.id,value);if(drafts.size>100)drafts.delete(drafts.keys().next().value!);};
  form.oninput=saveDraft;form.onchange=saveDraft;form.onsubmit=event=>{event.preventDefault();void act('accept');};form.append(actions);host.append(form);return()=>{alive=false;form.remove();};
}
