import { useEffect, useState } from 'react';
import type { AgentDefinition, Project } from '../shared/protocol';
import type { AcpSnapshot } from '../shared/acp';
import type { AcpHistoryEntry, AcpNativeSession } from '../shared/acp-workbench';
import { AsyncButton } from './AsyncButton';
import { Dialog } from './Dialog';
import { WorktreePicker } from './WorktreeManager';

type NativePage = {sessions:AcpNativeSession[];nextCursor?:string;resumable:boolean};
const phases:Record<string,string>={disconnected:'未连接',connecting:'连接中',ready:'已就绪',running:'执行中',permission:'待处理',error:'需处理'};

export function AcpHistory({projects,agents,projectId,onOpen,onClose,onArchive,opener}:{projects:Project[];agents:AgentDefinition[];projectId:string;onOpen:(projectId:string,sessionId:string)=>void;onClose:()=>void;onArchive:(sessionId:string,archived:boolean)=>void;opener:HTMLElement|null}){
  const [entries,setEntries]=useState<AcpHistoryEntry[]>([]),[query,setQuery]=useState(''),[project,setProject]=useState(projectId),[agent,setAgent]=useState('');
  const [filter,setFilter]=useState('active'),[native,setNative]=useState(false),[nativePage,setNativePage]=useState<NativePage|null>(null);
  const [worktreePath,setWorktreePath]=useState<string|null>(null),[busy,setBusy]=useState(false),[error,setError]=useState('');
  const localProjects=projects.filter(item=>!item.remoteWorkspace),current=localProjects.find(item=>item.id===project);
  const refresh=async()=>setEntries(await window.berth.rpc<AcpHistoryEntry[]>('acpHistory'));
  useEffect(()=>{void refresh().catch(error=>setError(String(error)));},[]);
  const names=new Map(projects.map(item=>[item.id,item.name])),agentNames=new Map(agents.map(item=>[item.id,item.name]));
  const local=entries.filter(item=>(!project||item.projectId===project)&&(!agent||item.agentId===agent)&&
    (filter==='all'||filter==='archived'&&item.archived||filter==='active'&&!item.archived||filter==='running'&&item.phase==='running'||filter==='permission'&&item.phase==='permission'||filter==='resumable'&&item.resumable)&&
    [item.title,item.nativeSessionId,item.sessionId,names.get(item.projectId),agentNames.get(item.agentId)].join(' ').toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()))
    .sort((a,b)=>(b.updatedAt??'').localeCompare(a.updatedAt??''));
  const loadNative=async(cursor?:string)=>{
    if(!current||!agent)return;
    setError('');setBusy(true);
    try{
      const next=await window.berth.rpc<NativePage>('acpNativeHistory',{projectId:project,agentId:agent,worktreePath,cursor});
      setNativePage(previous=>cursor&&previous?{...next,sessions:[...new Map([...previous.sessions,...next.sessions].map(item=>[item.sessionId,item])).values()]}:next);
    }finally{setBusy(false);}
  };
  const importSession=async(nativeId:string)=>{
    setBusy(true);
    try{
      const result=await window.berth.rpc<{imported:string;created?:boolean}>('acpNativeHistory',{projectId:project,agentId:agent,worktreePath,nativeId});
      if(result.created)await window.berth.rpc('start',{sessionId:result.imported,resume:true,cols:100,rows:30});
      onOpen(project,result.imported);onClose();
    }finally{setBusy(false);}
  };
  const exportSession=async(entry:AcpHistoryEntry)=>{
    let after=0;
    const blocks:string[]=[];
    for(;;){
      const page=await window.berth.rpc<AcpSnapshot>('acpSnapshot',{sessionId:entry.sessionId,after,limit:100});
      if(!page.events.length)break;
      for(const event of page.events){
        const who=event.kind==='assistant'?'Agent':event.kind==='user'?'用户':event.kind;
        const attachments=event.data?.attachments;
        blocks.push('### '+who+' · '+event.createdAt+'\n\n'+event.text+(Array.isArray(attachments)?'\n\n'+attachments.map(item=>'附件：'+String(item.path??item.name??'')).join('\n'):''));
      }
      const next=page.events.at(-1)!.sequence;
      if(!page.hasMore||next<=after)break;
      after=next;
    }
    const markdown='# '+entry.title+'\n\n项目：'+(names.get(entry.projectId)??'')+'\n\n会话：'+entry.sessionId+'\n\n原生 ID：'+(entry.nativeSessionId??'—')+'\n\n'+blocks.join('\n\n');
    await window.berth.saveAcpMarkdown(entry.title,markdown);
  };
  return <Dialog title="ACP 会话历史" onClose={onClose} returnFocus={opener} error={error} busy={busy}>
    <div className="acp-review-tabs"><button aria-pressed={!native} disabled={busy} onClick={()=>{setNative(false);setError('');}}>工作台历史</button><button aria-pressed={native} disabled={busy} onClick={()=>{setNative(true);setError('');}}>导入 Agent 历史</button></div>
    <div className="acp-history-filters">
      <select aria-label="筛选项目" value={project} disabled={busy} onChange={event=>{setProject(event.target.value);setWorktreePath(null);setNativePage(null);}}><option value="">全部项目</option>{localProjects.map(item=><option key={item.id} value={item.id}>{item.name}</option>)}</select>
      <select aria-label="筛选 ACP Agent" value={agent} disabled={busy} onChange={event=>{setAgent(event.target.value);setNativePage(null);}}><option value="">全部 Agent</option>{agents.map(item=><option key={item.id} value={item.id}>{item.name}</option>)}</select>
      {!native&&<><select aria-label="筛选会话状态" value={filter} onChange={event=>setFilter(event.target.value)}><option value="active">未归档</option><option value="all">全部状态</option><option value="running">执行中</option><option value="permission">待处理</option><option value="resumable">可续接</option><option value="archived">已归档</option></select><input aria-label="搜索 ACP 会话" placeholder="搜索名称或 ID" value={query} onChange={event=>setQuery(event.target.value)}/></>}
    </div>
    {native?<>
      {current&&<WorktreePicker project={current} enabled value={worktreePath} disabled={busy} onChange={value=>{setWorktreePath(value);setNativePage(null);}}/>}
      <AsyncButton disabled={!current||!agent||busy} onError={setError} onAction={()=>loadNative()}>读取原生会话</AsyncButton>
      {nativePage&&!nativePage.resumable&&<p role="status">该 Agent 能列出会话，但未开放历史内容读取</p>}
      <ul className="acp-history-list">{nativePage?.sessions.map(item=><li key={item.sessionId}><header><strong>{item.title}</strong><AsyncButton className="subtle" disabled={!nativePage.resumable||busy} onError={setError} onAction={()=>importSession(item.sessionId)}>导入并打开</AsyncButton></header><small>{item.sessionId}</small></li>)}</ul>
      {nativePage?.nextCursor&&<AsyncButton disabled={busy} onError={setError} onAction={()=>loadNative(nativePage.nextCursor)}>加载更多</AsyncButton>}
      {nativePage&&!nativePage.sessions.length&&<p role="status">当前目录没有可导入会话</p>}
    </>:<>
      <ul className="acp-history-list">{local.map(item=><li key={item.sessionId}><header><button type="button" className="text-button" onClick={()=>{onOpen(item.projectId,item.sessionId);onClose();}}>{item.title}</button><span className="badge">{phases[item.phase]??item.phase}</span><span className="badge">{item.resumable?'可续接':'仅本地记录'}</span>{item.archived&&<span className="badge">已归档</span>}</header>
        <small>{names.get(item.projectId)} · {agentNames.get(item.agentId)}{item.nativeSessionId?' · '+item.nativeSessionId:''}</small>
        <AsyncButton className="subtle" onError={setError} onAction={()=>exportSession(item)}>导出 Markdown</AsyncButton>
        <AsyncButton className="subtle" disabled={!item.archived&&item.phase!=='disconnected'} onError={setError} onAction={async()=>{await window.berth.rpc('acpArchive',{sessionId:item.sessionId,archived:!item.archived});onArchive(item.sessionId,!item.archived);await refresh();}}>{item.archived?'移出归档':'归档'}</AsyncButton>
      </li>)}</ul>
      {!local.length&&<p role="status">没有匹配的 ACP 会话</p>}
    </>}
    <footer><button className="subtle" disabled={busy} onClick={onClose}>关闭</button></footer>
  </Dialog>;
}
