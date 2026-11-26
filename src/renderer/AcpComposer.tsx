import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import type { AcpSnapshot } from '../shared/acp';
import type { Method, ProjectFile, ProjectFilePage, Session } from '../shared/protocol';
import { ACP_MEDIA_LIMIT, acpCapability, acpAudioTypes, acpImageTypes, type AcpAttachment, type AcpMessage } from '../shared/acp-workbench';
import { AcpEmpty, AcpIcon } from './AcpUi';
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

export function AcpComposer({session,snapshot,ready,enhanced,richMedia,onError,onSent,call}:{session:Session;snapshot:AcpSnapshot|null;ready:boolean;enhanced:boolean;richMedia:boolean;onError:(value:string)=>void;onSent:()=>void;call:(method:Method,params?:Record<string,unknown>)=>Promise<unknown>}){
  const [draft,setDraft]=useState(()=>loadDraft(session.id)),[images,setImages]=useState<ImageAttachment[]>([]),[imagesLoaded,setImagesLoaded]=useState(false);
  const [pending,setPending]=useState(false),[picker,setPicker]=useState<'mention'|'button'|null>(null),[query,setQuery]=useState(''),[matches,setMatches]=useState<ProjectFile[]>([]);
  const pendingRef=useRef(false),fileInput=useRef<HTMLInputElement>(null),input=useRef<HTMLTextAreaElement>(null),uploaded=useRef(new Set<string>());
  const [pickState,setPickState]=useState<'loading'|'ready'|'error'>('loading'),[highlight,setHighlight]=useState(0);
  const [queueOpen,setQueueOpen]=useState(false),[dragging,setDragging]=useState(false);
  const form=useRef<HTMLFormElement>(null),searchInput=useRef<HTMLInputElement>(null),fileTrigger=useRef<HTMLButtonElement>(null);
  const mentionRange=useRef<{start:number;end:number}|null>(null);
  const [editing,setEditing]=useState<AcpMessage|null>(null);
  const running=snapshot?.phase==='running'||snapshot?.phase==='permission';
  const supportsImages=enhanced&&imagesLoaded&&acpCapability(snapshot?.capabilities,'promptCapabilities','image');
  const supportsAudio=richMedia&&imagesLoaded&&acpCapability(snapshot?.capabilities,'promptCapabilities','audio');
  const supportsEmbedded=richMedia&&acpCapability(snapshot?.capabilities,'promptCapabilities','embeddedContext');
  const mediaTypes:string[]=[...(supportsImages?acpImageTypes:[]),...(supportsAudio?acpAudioTypes:[])];
  const attachmentCount=draft.files.length+images.length;
  const canEdit=ready&&(!enhanced||imagesLoaded)&&!pending&&snapshot?.phase!=='disconnected'&&snapshot?.phase!=='error';
  const canSend=canEdit&&!!(draft.text.trim()||attachmentCount)&&(snapshot?.phase==='ready'||enhanced&&running);
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
    setDraft(previous=>{
      if(previous.files.some(file=>file.path===attachment.path&&file.text===attachment.text)||previous.files.length+images.length>=8)return previous;
      return {...previous,requestId:undefined,files:[...previous.files,attachment]};
    });
    requestAnimationFrame(()=>input.current?.focus());
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
    if(!picker||!ready)return;
    let current=true;
    setMatches([]);setHighlight(0);setPickState('loading');
    const scope={projectId:session.projectId,worktreePath:session.worktreePath??null};
    const term=query.trim();
    const timer=setTimeout(()=>{
      const listing=term
        ? window.berth.rpc<{matches:ProjectFile[]}>('findProjectFiles',{...scope,query:term}).then(result=>result.matches)
        : window.berth.rpc<ProjectFilePage>('projectFiles',{...scope,limit:150}).then(result=>result.entries.filter(file=>!file.ignored));
      void listing.then(files=>{
        if(!current)return;
        setMatches(files.filter(file=>file.kind==='file'&&!file.unavailable).slice(0,30));setPickState('ready');
      }).catch(()=>{if(current)setPickState('error');});
    },term?150:0);
    return ()=>{current=false;clearTimeout(timer);};
  },[query,picker,ready,session.projectId,session.worktreePath]);
  useEffect(()=>{
    if(picker==='button')searchInput.current?.focus();
    if(!picker)return;
    const outside=(event:PointerEvent)=>{if(!form.current?.contains(event.target as Node))closePicker();};
    document.addEventListener('pointerdown',outside);
    return ()=>document.removeEventListener('pointerdown',outside);
  },[picker]);
  useEffect(()=>{if(snapshot?.queuePaused)setQueueOpen(true);},[snapshot?.queuePaused]);
  useEffect(()=>{
    form.current?.querySelector('.acp-picker-row[data-current="true"]')?.scrollIntoView({block:'nearest'});
  },[highlight]);
  function closePicker(){
    setPicker(null);setQuery('');setMatches([]);mentionRange.current=null;
  }
  const editText=(text:string)=>setDraft(value=>({...value,text,requestId:undefined}));
  const addMedia=(files:Iterable<File>)=>{
    if(!mediaTypes.length)return;
    const added:ImageAttachment[]=[];
    for(const file of files){
      if(!mediaTypes.includes(file.type)||file.size<=0||file.size>ACP_MEDIA_LIMIT){onError('请选择 Agent 支持的、2 MiB 以内的图片或音频');continue;}
      if(attachmentCount+added.length>=8){onError('一条消息最多添加 8 个附件');break;}
      added.push({id:crypto.randomUUID(),file});
    }
    if(added.length){setImages(previous=>[...previous,...added]);setDraft(previous=>({...previous,requestId:undefined}));}
  };
  async function send(){
    if(pendingRef.current||!(draft.text.trim()||attachmentCount))return;
    if(picker)return;
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
        if(draft.files.some(file=>file.embed)&&!supportsEmbedded)throw new Error('当前 Agent 不支持内嵌文本，请改为文件引用');
        if(images.some(item=>!mediaTypes.includes(item.file.type)))throw new Error('当前 Agent 不支持草稿中的媒体附件');
        if(images.reduce((total,item)=>total+item.file.size,0)>4*1024*1024)throw new Error('单条消息的媒体附件合计最多 4 MiB');
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
          attachments.push({type:image.file.type.startsWith('audio/')?'audio':'image',id:image.id,name:image.file.name.slice(0,200)||'媒体附件'});
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
    const range=mentionRange.current;
    if(attachmentCount>=8&&!draft.files.some(file=>file.path===path&&!file.text)){onError('一条消息最多添加 8 个附件');return;}
    if(picker==='mention'&&range){
      setDraft(previous=>{
        const before=previous.text.slice(0,range.start),after=previous.text.slice(range.end);
        return {...previous,text:before+(before.endsWith(' ')&&after.startsWith(' ')?after.slice(1):after),requestId:undefined};
      });
      requestAnimationFrame(()=>input.current?.setSelectionRange(range.start,range.start));
    }
    attach({type:'file',path});closePicker();
  }
  const commands=(!picker&&draft.text.startsWith('/')&&!/\s/.test(draft.text)?snapshot?.availableCommands??[]:[])
    .filter(command=>('/'+command.name).startsWith(draft.text)).slice(0,8);
  const selectCommand=(name:string)=>{editText('/'+name+' ');input.current?.focus();};
  const queue=snapshot?.queue??[];
  const pickerKey=(event:KeyboardEvent)=>{
    if(event.nativeEvent.isComposing)return false;
    const count=picker?matches.length:commands.length;
    if(event.key==='Escape'&&picker){
      event.preventDefault();
      if(picker==='button')fileTrigger.current?.focus();else input.current?.focus();
      closePicker();return true;
    }
    if((picker||count)&&['ArrowDown','ArrowUp','Enter'].includes(event.key)&&!event.shiftKey){
      event.preventDefault();
      if(!count)return true;
      if(event.key==='ArrowDown'||event.key==='ArrowUp')setHighlight(position=>(Math.min(position,count-1)+(event.key==='ArrowDown'?1:count-1))%count);
      else if(picker)choose(matches[Math.min(highlight,count-1)].path);
      else selectCommand(commands[Math.min(highlight,count-1)].name);
      return true;
    }
    return false;
  };
  const pickerId='acp-picker-'+session.id;
  return <div className="acp-input-stack">
    {!!queue.length&&<section className="acp-queue" data-open={queueOpen} aria-label="待发送消息">
      <button className="acp-queue-toggle" type="button" aria-expanded={queueOpen} aria-controls={'acp-queue-'+session.id} onClick={()=>setQueueOpen(!queueOpen)}>
        <AcpIcon name="history"/><strong>{snapshot?.queuePaused?'队列已暂停':'待发送'}</strong><span>{queue.length}</span><AcpIcon name="chevron"/>
      </button>
      <div className="acp-queue-reveal" id={'acp-queue-'+session.id} inert={!queueOpen}><div className="acp-queue-items">
        {queue.map(item=><div className="acp-queue-item" key={item.requestId}>
          {editing?.requestId===item.requestId?<><textarea aria-label="编辑排队消息" rows={2} maxLength={40000} value={editing.text} onChange={event=>setEditing({...editing,text:event.target.value})}/><AsyncButton className="subtle" onError={onError} onAction={async()=>{await call('acpQueue',{action:'edit',requestId:item.requestId,text:editing.text});setEditing(null);}}>保存</AsyncButton><button type="button" className="subtle" onClick={()=>setEditing(null)}>取消</button></>
            :<><span title={item.text}>{item.text||'附件'}{item.attachments?.length?` · ${item.attachments.length} 个附件`:''}</span><button type="button" className="subtle" disabled={!ready} onClick={()=>setEditing(item)}>编辑</button><AsyncButton className="subtle" disabled={!ready} onError={onError} onAction={()=>call('acpQueue',{action:'remove',requestId:item.requestId})}>撤回</AsyncButton></>}
        </div>)}
        {snapshot?.queuePaused&&<AsyncButton className="subtle" disabled={!ready||snapshot.phase!=='ready'} onError={onError} onAction={()=>call('acpQueue',{action:'resume'})}>继续发送队列</AsyncButton>}
      </div></div>
    </section>}
    <form ref={form} className="acp-composer" data-dragging={dragging||undefined} onSubmit={event=>{event.preventDefault();void send();}}
      onDragOver={event=>{if(supportsImages&&event.dataTransfer.types.includes('Files')){event.preventDefault();setDragging(true);}}}
      onDragLeave={event=>{if(!event.currentTarget.contains(event.relatedTarget as Node|null))setDragging(false);}}
      onDrop={event=>{setDragging(false);if(mediaTypes.length&&event.dataTransfer.files.length){event.preventDefault();addMedia(event.dataTransfer.files);}}}>
      {picker?<div className="acp-command-menu acp-picker" id={pickerId} aria-label="工作区文件" data-acp-motion>
        <label className="acp-picker-search"><AcpIcon name="search"/><input ref={searchInput} aria-label="搜索要引用的工作区文件" placeholder="搜索工作区文件" value={query} onChange={event=>{setQuery(event.target.value);setHighlight(0);}} onKeyDown={pickerKey}/></label>
        <div className="acp-picker-results">
          {matches.map((file,index)=><button className="acp-picker-row" data-current={highlight===index} type="button" key={file.path} onMouseMove={()=>setHighlight(index)} onClick={()=>choose(file.path)}><AcpIcon name="file"/><span><strong>{file.name}</strong>{file.path!==file.name&&<small>{file.path}</small>}</span></button>)}
          {!matches.length&&<AcpEmpty icon="file" busy={pickState==='loading'}>{pickState==='loading'?'正在读取文件…':pickState==='error'?'读取工作区失败':query.trim()?'没有匹配的文件':'根目录没有可引用的文件'}</AcpEmpty>}
        </div>
      </div>:!!commands.length&&<div className="acp-command-menu acp-picker" aria-label="Agent 命令" data-acp-motion>
        <div className="acp-picker-results">{commands.map((command,index)=><button className="acp-picker-row" data-current={highlight===index} type="button" key={command.name} onMouseMove={()=>setHighlight(index)} onClick={()=>selectCommand(command.name)}><AcpIcon name="terminal"/><span><strong>/{command.name}</strong><small>{command.description}</small></span></button>)}</div>
      </div>}
      {!!attachmentCount&&<div className="acp-attachment-list acp-draft-attachments" aria-label="消息附件">
        {draft.files.map((file,index)=><span className="acp-file-attachment" key={file.path+'#'+index}><button type="button" title={file.path} disabled={pending} aria-label={'移除文件 '+file.path} onClick={()=>setDraft(previous=>({...previous,requestId:undefined,files:previous.files.filter((_,i)=>i!==index)}))}><AcpIcon name="file"/><span>{file.path.split(/[\\/]/).at(-1)}{file.embed?' · 内嵌':file.text?' · 片段':''}</span><AcpIcon name="close"/></button>{supportsEmbedded&&!file.text&&<button type="button" className="subtle" aria-pressed={file.embed===true} disabled={pending} onClick={()=>setDraft(previous=>({...previous,requestId:undefined,files:previous.files.map((item,i)=>i===index?{...item,embed:item.embed?undefined:true}:item)}))}>{file.embed?'改为引用':'内嵌正文'}</button>}</span>)}
        {images.map(image=><button type="button" key={image.id} disabled={pending} aria-label={'移除附件 '+image.file.name} onClick={()=>{setImages(previous=>previous.filter(item=>item!==image));setDraft(previous=>({...previous,requestId:undefined}));}}><AcpIcon name={image.file.type.startsWith('audio/')?'file':'image'}/><span>{image.file.name||'媒体附件'}</span><AcpIcon name="close"/></button>)}
      </div>}
      <textarea ref={input} aria-label="发送给 Agent 的消息" placeholder="描述任务…" value={draft.text} maxLength={40000} disabled={!canEdit}
        onPaste={event=>{const files=[...event.clipboardData.files];if(mediaTypes.length&&files.length){event.preventDefault();addMedia(files);}}}
        onChange={event=>{
          const {value,selectionStart}=event.target;editText(value);setHighlight(0);
          const mention=enhanced?/(?:^|\s)@([^\s@]*)$/.exec(value.slice(0,selectionStart)):null;
          if(mention){mentionRange.current={start:selectionStart-mention[1].length-1,end:selectionStart};setPicker('mention');setQuery(mention[1]);}
          else if(picker)closePicker();
        }} onKeyDown={event=>{
          if(!pickerKey(event)&&event.key==='Enter'&&!event.shiftKey&&!event.nativeEvent.isComposing){event.preventDefault();void send();}
        }}/>
      <footer>
        <div className="acp-composer-tools">
          {enhanced&&<button ref={fileTrigger} type="button" className="subtle acp-icon-action" aria-expanded={!!picker} aria-controls={picker?pickerId:undefined} disabled={!ready||pending} onClick={()=>{if(picker){closePicker();input.current?.focus();}else{setQuery('');setPicker('button');}}}><AcpIcon name="file"/>引用文件</button>}
          {!!mediaTypes.length&&<><button type="button" className="subtle acp-icon-action" disabled={pending} onClick={()=>fileInput.current?.click()}><AcpIcon name="image"/>{supportsImages&&supportsAudio?'添加图片 / 音频':supportsAudio?'添加音频':'添加图片'}</button><input ref={fileInput} type="file" hidden multiple accept={mediaTypes.join(',')} onChange={event=>{addMedia(event.target.files??[]);event.target.value='';}}/></>}
        </div>
        <div className="acp-composer-actions">
          {running&&<AsyncButton className="subtle acp-icon-action" disabled={!ready} onError={onError} onAction={()=>call('acpCancel')}><AcpIcon name="stop"/>停止任务</AsyncButton>}
          <button type="submit" className="primary acp-icon-action" disabled={!canSend||!!picker}><AcpIcon name="send"/>{running&&enhanced?'加入队列':'发送'}</button>
        </div>
      </footer>
    </form>
  </div>;
}
