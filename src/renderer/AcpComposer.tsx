import { useEffect, useRef, useState } from 'react';
import type { AcpSnapshot } from '../shared/acp';
import type { Method, ProjectFile, Session } from '../shared/protocol';
import { ACP_IMAGE_LIMIT, acpCapability, acpImageTypes, type AcpAttachment, type AcpMessage } from '../shared/acp-workbench';
import { AsyncButton } from './AsyncButton';

type FileAttachment = Extract<AcpAttachment, {type:'file'}>;
type ImageAttachment = {id:string; file:File};
type Draft = {text:string; files:FileAttachment[]; requestId?:string};
const empty = {text:'',files:[]};
const draftKey = (id:string) => 'agentberth.acp.draft.'+id;
function loadDraft(id:string):Draft {
  try {
    const stored=JSON.parse(localStorage.getItem(draftKey(id))??'null');
    if(typeof stored?.text==='string'&&Array.isArray(stored.files))return stored;
  }catch{/* Browser storage can be disabled. */}
  return empty;
}

let imageStorage:Promise<IDBDatabase>|undefined;
function openImageStorage(){
  return imageStorage??=new Promise<IDBDatabase>((resolve,reject)=>{
    const request=indexedDB.open('agentberth-acp-drafts',1);
    request.onupgradeneeded=()=>request.result.createObjectStore('images');
    request.onsuccess=()=>resolve(request.result);
    request.onerror=()=>reject(request.error);
  });
}
async function readImages(id:string):Promise<ImageAttachment[]>{
  const database=await openImageStorage();
  return new Promise((resolve,reject)=>{
    const request=database.transaction('images').objectStore('images').get(id);
    request.onsuccess=()=>resolve(request.result??[]);
    request.onerror=()=>reject(request.error);
  });
}
async function saveImages(id:string,images:ImageAttachment[]){
  const database=await openImageStorage();
  const transaction=database.transaction('images','readwrite');
  const store=transaction.objectStore('images');
  if(images.length)store.put(images,id);else store.delete(id);
  await new Promise<void>((resolve,reject)=>{
    transaction.oncomplete=()=>resolve();
    transaction.onabort=()=>reject(transaction.error);
  });
}

export function attachToAcp(sessionId:string, attachment:FileAttachment) {
  window.dispatchEvent(new CustomEvent('berth:acp-attach',{detail:{sessionId,attachment}}));
}

export function AcpComposer({session,snapshot,ready,enhanced,onError,onSent,call}:{session:Session;snapshot:AcpSnapshot|null;ready:boolean;enhanced:boolean;onError:(value:string)=>void;onSent:()=>void;call:(method:Method,params?:Record<string,unknown>)=>Promise<unknown>}){
  const [draft,setDraft]=useState(()=>loadDraft(session.id)),[images,setImages]=useState<ImageAttachment[]>([]),[imagesLoaded,setImagesLoaded]=useState(false);
  const [pending,setPending]=useState(false),[picker,setPicker]=useState(false),[query,setQuery]=useState(''),[matches,setMatches]=useState<ProjectFile[]>([]);
  const pendingRef=useRef(false),fileInput=useRef<HTMLInputElement>(null),input=useRef<HTMLTextAreaElement>(null),uploaded=useRef(new Set<string>());
  const [editing,setEditing]=useState<AcpMessage|null>(null);
  const running=snapshot?.phase==='running'||snapshot?.phase==='permission';
  const supportsImages=enhanced&&imagesLoaded&&acpCapability(snapshot?.capabilities,'promptCapabilities','image');
  const attachmentCount=draft.files.length+images.length;
  const canSend=ready&&(!enhanced||imagesLoaded)&&!pending&&!!(draft.text.trim()||attachmentCount)&&(snapshot?.phase==='ready'||enhanced&&running);
  useEffect(()=>{
    let current=true;
    void readImages(session.id).then(result=>{if(current)setImages(result);}).catch(()=>{}).finally(()=>{if(current)setImagesLoaded(true);});
    return ()=>{current=false;};
  },[session.id]);
  useEffect(()=>{
    if(imagesLoaded)void saveImages(session.id,images).catch(()=>{});
  },[imagesLoaded,images,session.id]);
  useEffect(()=>{uploaded.current.clear();},[session.id,session.latestRun?.id]);
  useEffect(()=>{
    try{
      if(draft.text||draft.files.length)localStorage.setItem(draftKey(session.id),JSON.stringify(draft));
      else localStorage.removeItem(draftKey(session.id));
    }catch{/* Keep the current draft in memory when storage is full. */}
  },[session.id,draft]);
  const attach=(attachment:FileAttachment)=>{
    setDraft(previous=>previous.files.length+images.length>=8?previous:{...previous,requestId:undefined,files:[...previous.files.filter(item=>item.path!==attachment.path||item.text!==attachment.text),attachment]});
    input.current?.focus();
  };
  useEffect(()=>{
    if(!enhanced)return;
    const listener=(event:Event)=>{
      const {sessionId,attachment}=(event as CustomEvent<{sessionId:string;attachment:FileAttachment}>).detail;
      if(sessionId===session.id)attach(attachment);
    };
    window.addEventListener('berth:acp-attach',listener);
    return ()=>window.removeEventListener('berth:acp-attach',listener);
  },[session.id,enhanced,images.length]);
  useEffect(()=>{
    if(!picker||!ready||!query.trim()){setMatches([]);return;}
    let current=true;
    setMatches([]);
    const timer=setTimeout(()=>{
      void window.berth.rpc<{matches:ProjectFile[]}>('findProjectFiles',{projectId:session.projectId,worktreePath:session.worktreePath??null,query:query.trim()})
        .then(result=>{if(current)setMatches(result.matches.filter(file=>file.kind==='file'&&!file.unavailable).slice(0,30));})
        .catch(error=>{if(current)onError(String(error));});
    },150);
    return ()=>{current=false;clearTimeout(timer);};
  },[query,picker,ready,session.projectId,session.worktreePath]);
  const editText=(text:string)=>setDraft(value=>({...value,text,requestId:undefined}));
  const addImages=(files:Iterable<File>)=>{
    if(!supportsImages)return;
    const added:ImageAttachment[]=[];
    for(const file of files){
      if(!acpImageTypes.some(type=>type===file.type)||file.size<=0||file.size>ACP_IMAGE_LIMIT){onError('请选择 2 MiB 以内的 PNG、JPEG、WebP 或 GIF 图片');continue;}
      if(attachmentCount+added.length>=8){onError('一条消息最多添加 8 个附件');break;}
      added.push({id:crypto.randomUUID(),file});
    }
    if(added.length){setImages(previous=>[...previous,...added]);setDraft(previous=>({...previous,requestId:undefined}));}
  };
  async function send(){
    if(pendingRef.current||!(draft.text.trim()||attachmentCount))return;
    if(picker&&matches.length){choose(matches[0].path);return;}
    if(!canSend){
      onError(!ready||snapshot?.phase==='connecting'?'Agent 尚未就绪，草稿已保留':'当前会话无法发送，草稿已保留');
      return;
    }
    pendingRef.current=true;setPending(true);
    const requestId=draft.requestId??crypto.randomUUID();
    setDraft(previous=>({...previous,requestId}));
    const text=draft.text.trim();
    const attachments:AcpAttachment[]=[...draft.files];
    try{
      if(enhanced){
        if(images.length&&!supportsImages)throw new Error('当前 Agent 不支持草稿中的图片');
        if(images.reduce((total,item)=>total+item.file.size,0)>4*1024*1024)throw new Error('单条消息的图片合计最多 4 MiB');
        for(const image of images){
          if(!uploaded.current.has(image.id)){
            const bytes=new Uint8Array(await image.file.arrayBuffer());
            for(let offset=0;offset<bytes.length;offset+=46080){
              const chunk=bytes.subarray(offset,offset+46080);
              const data=btoa(Array.from(chunk,byte=>String.fromCharCode(byte)).join(''));
              await call('acpImage',{imageId:image.id,mimeType:image.file.type,offset,data,last:offset+chunk.length===bytes.length});
            }
            uploaded.current.add(image.id);
          }
          attachments.push({type:'image',id:image.id,name:image.file.name.slice(0,200)||'剪贴板图片'});
        }
        await call('acpSubmit',{message:{requestId,text,attachments},queue:running});
      }else await call('acpSend',{requestId,text});
      setDraft(previous=>previous.requestId===requestId?empty:previous);
      setImages(previous=>previous.filter(item=>!images.includes(item)));
      for(const image of images)uploaded.current.delete(image.id);
      onSent();
    }catch(error){onError(String(error));}
    finally{pendingRef.current=false;setPending(false);}
  }
  function choose(path:string){
    const next=draft.text.replace(/(^|\s)@[^\s@]*$/,'$1');
    setDraft(previous=>({...previous,text:next,requestId:undefined}));
    attach({type:'file',path});setPicker(false);setQuery('');
  }
  const queue=snapshot?.queue??[];
  return <div className="acp-input-stack">
    {!!queue.length&&<details className="acp-queue" open={snapshot?.queuePaused||undefined}>
      <summary>{snapshot?.queuePaused?'队列已暂停':'待发送'} · {queue.length}</summary>
      {queue.map(item=><div className="acp-queue-item" key={item.requestId}>
        {editing?.requestId===item.requestId?<><input aria-label="编辑排队消息" maxLength={40000} value={editing.text} onChange={event=>setEditing({...editing,text:event.target.value})}/><AsyncButton onError={onError} onAction={async()=>{await call('acpQueue',{action:'edit',requestId:item.requestId,text:editing.text});setEditing(null);}}>保存</AsyncButton><button onClick={()=>setEditing(null)}>取消</button></>
          :<><span title={item.text}>{item.text||'附件'}{item.attachments?.length? ` · ${item.attachments.length} 个附件`:''}</span><button disabled={!ready} onClick={()=>setEditing(item)}>编辑</button><AsyncButton disabled={!ready} onError={onError} onAction={()=>call('acpQueue',{action:'remove',requestId:item.requestId})}>撤回</AsyncButton></>}
      </div>)}
      {snapshot?.queuePaused&&<AsyncButton disabled={!ready||snapshot.phase!=='ready'} onError={onError} onAction={()=>call('acpQueue',{action:'resume'})}>继续发送队列</AsyncButton>}
    </details>}
    <form className="acp-composer" onSubmit={event=>{event.preventDefault();void send();}} onDragOver={event=>{if(supportsImages)event.preventDefault();}} onDrop={event=>{if(supportsImages&&event.dataTransfer.files.length){event.preventDefault();addImages(event.dataTransfer.files);}}}>
      {picker&&<div className="acp-command-menu"><input aria-label="搜索要引用的工作区文件" value={query} onChange={event=>setQuery(event.target.value)} onKeyDown={event=>{if(event.key==='Escape'){event.preventDefault();setPicker(false);input.current?.focus();}if(event.key==='Enter'&&!event.nativeEvent.isComposing){event.preventDefault();if(matches[0])choose(matches[0].path);}}}/>{matches.map(file=><button type="button" key={file.path} onClick={()=>choose(file.path)}><strong>{file.name}</strong><span>{file.path}</span></button>)}</div>}
      {!picker&&draft.text.startsWith('/')&&!draft.text.includes(' ')&&!!snapshot?.availableCommands?.length&&<div className="acp-command-menu" aria-label="Agent 命令">{snapshot.availableCommands.filter(command=>('/'+command.name).startsWith(draft.text)).slice(0,8).map(command=><button type="button" key={command.name} onClick={()=>{editText('/'+command.name+' ');input.current?.focus();}}><strong>/{command.name}</strong><span>{command.description}</span></button>)}</div>}
      {!!attachmentCount&&<div className="acp-attachment-list" aria-label="消息附件">
        {draft.files.map((file,index)=><button type="button" key={index} title={file.path} disabled={pending} aria-label={'移除文件 '+file.path} onClick={()=>setDraft(previous=>({...previous,requestId:undefined,files:previous.files.filter((_,i)=>i!==index)}))}>{file.path}{file.text?' · 片段':''} ×</button>)}
        {images.map(image=><button type="button" key={image.id} disabled={pending} aria-label={'移除图片 '+image.file.name} onClick={()=>{setImages(previous=>previous.filter(item=>item!==image));setDraft(previous=>({...previous,requestId:undefined}));}}>{image.file.name||'剪贴板图片'} ×</button>)}
      </div>}
      <textarea ref={input} aria-label="发送给 Agent 的消息" placeholder="描述任务…" value={draft.text} maxLength={40000} disabled={pending} onPaste={event=>{const files=[...event.clipboardData.files];if(supportsImages&&files.length){event.preventDefault();addImages(files);}}} onChange={event=>{
        const text=event.target.value;editText(text);
        const mention=enhanced?/(?:^|\s)@([^\s@]*)$/.exec(text):null;
        if(mention){setPicker(true);setQuery(mention[1]);}else if(picker)setPicker(false);
      }} onKeyDown={event=>{if(event.key==='Escape'&&picker){event.preventDefault();setPicker(false);}else if(event.key==='Enter'&&!event.shiftKey&&!event.nativeEvent.isComposing){event.preventDefault();void send();}}}/>
      <footer>
        {enhanced&&<button type="button" className="subtle" disabled={!ready||pending} onClick={()=>{setPicker(!picker);setQuery('');}}>引用文件</button>}
        {supportsImages&&<><button type="button" className="subtle" disabled={pending} onClick={()=>fileInput.current?.click()}>添加图片</button><input ref={fileInput} type="file" hidden multiple accept={acpImageTypes.join(',')} onChange={event=>{addImages(event.target.files??[]);event.target.value='';}}/></>}
        {running&&<AsyncButton className="subtle" disabled={!ready} onError={onError} onAction={()=>call('acpCancel')}>停止任务</AsyncButton>}
        <button className="primary" disabled={!canSend}>{running&&enhanced?'加入队列':'发送'}</button>
      </footer>
    </form>
  </div>;
}
