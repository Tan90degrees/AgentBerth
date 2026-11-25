import { useEffect, useState } from 'react';
import type { AgentDefinition, Project } from '../shared/protocol';
import type { AcpSnapshot } from '../shared/acp';
import type { AcpHistoryEntry, AcpNativeSession } from '../shared/acp-workbench';
import { AcpEmpty, AcpIcon } from './AcpUi';
import { AsyncButton } from './AsyncButton';
import { Dialog } from './Dialog';
import { WorktreePicker } from './WorktreeManager';

type NativePage = {sessions:AcpNativeSession[];nextCursor?:string;resumable:boolean;deletable?:boolean};
const phases:Record<string,string>={disconnected:'未连接',connecting:'连接中',ready:'已就绪',running:'执行中',permission:'待处理',error:'需处理'};

export function AcpHistory({projects,agents,projectId,onOpen,onClose,onArchive,opener}:{projects:Project[];agents:AgentDefinition[];projectId:string;onOpen:(projectId:string,sessionId:string)=>void;onClose:()=>void;onArchive:(sessionId:string,archived:boolean)=>void;opener:HTMLElement|null}){
  const [entries,setEntries]=useState<AcpHistoryEntry[]>([]),[query,setQuery]=useState(''),[project,setProject]=useState(projectId),[agent,setAgent]=useState('');
  const [filter,setFilter]=useState('active'),[native,setNative]=useState(false),[nativePage,setNativePage]=useState<NativePage|null>(null);
  const [loading,setLoading]=useState(true),[nativeProject,setNativeProject]=useState(projectId),[nativeAgent,setNativeAgent]=useState('');
  const [worktreePath,setWorktreePath]=useState<string|null>(null),[busy,setBusy]=useState(false),[error,setError]=useState('');
  const localProjects=projects.filter(item=>!item.remoteWorkspace),current=localProjects.find(item=>item.id===nativeProject);
  const refresh=async()=>setEntries(await window.berth.rpc<AcpHistoryEntry[]>('acpHistory'));
  useEffect(()=>{
    let current=true;
    void window.berth.rpc<AcpHistoryEntry[]>('acpHistory').then(result=>{if(current)setEntries(result);})
      .catch(error=>{if(current)setError(String(error));}).finally(()=>{if(current)setLoading(false);});
    return ()=>{current=false;};
  },[]);
  const names=new Map(projects.map(item=>[item.id,item.name])),agentNames=new Map(agents.map(item=>[item.id,item.name]));
  const local=entries.filter(item=>(!project||item.projectId===project)&&(!agent||item.agentId===agent)&&
    (filter==='all'||filter==='archived'&&item.archived||filter==='active'&&!item.archived||filter==='running'&&item.phase==='running'||filter==='permission'&&item.phase==='permission'||filter==='resumable'&&item.resumable)&&
    [item.title,item.nativeSessionId,item.sessionId,names.get(item.projectId),agentNames.get(item.agentId)].join(' ').toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()))
    .sort((a,b)=>(b.updatedAt??'').localeCompare(a.updatedAt??''));
  const loadNative=async(cursor?:string)=>{
    if(!current||!nativeAgent)return;
    setError('');setBusy(true);
    try{
      const next=await window.berth.rpc<NativePage>('acpNativeHistory',{projectId:nativeProject,agentId:nativeAgent,worktreePath,cursor});
      setNativePage(previous=>cursor&&previous?{...next,sessions:[...new Map([...previous.sessions,...next.sessions].map(item=>[item.sessionId,item])).values()]}:next);
    }finally{setBusy(false);}
  };
  const importSession=async(nativeId:string)=>{
    setBusy(true);
    try{
      const result=await window.berth.rpc<{imported:string;created?:boolean}>('acpNativeHistory',{projectId:nativeProject,agentId:nativeAgent,worktreePath,nativeId});
      if(result.created)await window.berth.rpc('start',{sessionId:result.imported,resume:true,cols:100,rows:30});
      onOpen(nativeProject,result.imported);onClose();
    }finally{setBusy(false);}
  };
  const removeNative=async(item:AcpNativeSession)=>{
    if(!window.confirm('从 Agent 原生历史删除「'+item.title+'」？此操作无法撤销，工作台已保存的记录会保留。'))return;
    setBusy(true);
    try{
      await window.berth.rpc('acpNativeHistory',{projectId:nativeProject,agentId:nativeAgent,worktreePath,nativeId:item.sessionId,remove:true});
      setNativePage(previous=>previous?{...previous,sessions:previous.sessions.filter(session=>session.sessionId!==item.sessionId)}:previous);
      await refresh();
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
  return <Dialog variant="acp-wide" title="ACP 会话历史" onClose={onClose} returnFocus={opener} error={error} busy={busy}>
    <div className="acp-review-tabs" role="group" aria-label="历史来源">
      <button type="button" aria-pressed={!native} disabled={busy} onClick={()=>{setNative(false);setError('');}}>工作台历史</button>
      <button type="button" aria-pressed={native} disabled={busy} onClick={()=>{if(!nativeAgent)setNativeAgent(agent||agents[0]?.id||'');setNative(true);setError('');}}>导入 Agent 历史</button>
    </div>
    <div className="acp-history-content" key={native?'native':'local'} data-acp-motion>
      {!native&&<label className="acp-search-field"><AcpIcon name="search"/><input aria-label="搜索 ACP 会话" placeholder="搜索名称或 ID" value={query} onChange={event=>setQuery(event.target.value)}/></label>}
      <div className="acp-history-filters">
        <label>项目<select aria-label="筛选项目" value={native?nativeProject:project} disabled={busy} onChange={event=>{
          if(native){setNativeProject(event.target.value);setWorktreePath(null);setNativePage(null);}else setProject(event.target.value);
        }}><option value="">{native?'选择项目':'全部项目'}</option>{localProjects.map(item=><option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
        <label>Agent<select aria-label="筛选 ACP Agent" value={native?nativeAgent:agent} disabled={busy} onChange={event=>{
          if(native){setNativeAgent(event.target.value);setNativePage(null);}else setAgent(event.target.value);
        }}><option value="">{native?'选择 Agent':'全部 Agent'}</option>{agents.map(item=><option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
        {!native&&<label>状态<select aria-label="筛选会话状态" value={filter} onChange={event=>setFilter(event.target.value)}><option value="active">未归档</option><option value="all">全部状态</option><option value="running">执行中</option><option value="permission">待处理</option><option value="resumable">可续接</option><option value="archived">已归档</option></select></label>}
      </div>
      {native?<>
        <div className="acp-native-options">
          {current&&<WorktreePicker project={current} enabled value={worktreePath} disabled={busy} onChange={value=>{setWorktreePath(value);setNativePage(null);}}/>}
          <AsyncButton className="primary" disabled={!current||!nativeAgent||busy} onError={setError} onAction={()=>loadNative()}>读取原生会话</AsyncButton>
        </div>
        {nativePage&&!nativePage.resumable&&<p role="status">该 Agent 未开放历史内容读取</p>}
        <ul className="acp-history-list">{nativePage?.sessions.map(item=><li key={item.sessionId}>
          <div className="acp-list-icon"><AcpIcon name="chat"/></div>
          <div className="acp-list-main"><strong>{item.title}</strong><small title={item.sessionId}>{item.sessionId}</small></div>
          <AsyncButton className="subtle" disabled={!nativePage.resumable||busy} onError={setError} onAction={()=>importSession(item.sessionId)}>导入并打开</AsyncButton>
          {nativePage.deletable&&<details className="acp-row-actions"><summary className="acp-icon-action acp-square" aria-label={'管理 '+item.title}><AcpIcon name="more"/></summary><div><AsyncButton className="subtle" disabled={busy} onError={setError} onAction={()=>removeNative(item)}>删除原生会话</AsyncButton></div></details>}
        </li>)}</ul>
        {nativePage?.nextCursor&&<AsyncButton disabled={busy} onError={setError} onAction={()=>loadNative(nativePage.nextCursor)}>加载更多</AsyncButton>}
        {nativePage&&!nativePage.sessions.length&&<AcpEmpty icon="history">当前目录没有可导入会话</AcpEmpty>}
      </>:<>
        <ul className="acp-history-list">{local.map(item=><li key={item.sessionId}>
          <div className="acp-list-icon"><AcpIcon name="chat"/></div>
          <div className="acp-list-main">
            <button type="button" className="acp-list-title" onClick={()=>{onOpen(item.projectId,item.sessionId);onClose();}}>{item.title}</button>
            <small title={item.nativeSessionId??undefined}>{names.get(item.projectId)} · {agentNames.get(item.agentId)}{item.nativeSessionId?' · '+item.nativeSessionId:''}</small>
          </div>
          <div className="acp-history-status"><span className="badge">{item.archived?'已归档':phases[item.phase]??item.phase}</span><small>{item.resumable?'可续接':'本地记录'}</small></div>
          <details className="acp-row-actions">
            <summary className="acp-icon-action acp-square" aria-label={'管理 '+item.title} title="会话操作"><AcpIcon name="more"/></summary>
            <div>
              <AsyncButton className="subtle" onError={setError} onAction={()=>exportSession(item)}>导出 Markdown</AsyncButton>
              <AsyncButton className="subtle" disabled={!item.archived&&item.phase!=='disconnected'} onError={setError} onAction={async()=>{await window.berth.rpc('acpArchive',{sessionId:item.sessionId,archived:!item.archived});onArchive(item.sessionId,!item.archived);await refresh();}}>{item.archived?'移出归档':'归档'}</AsyncButton>
            </div>
          </details>
        </li>)}</ul>
        {!local.length&&<AcpEmpty icon="history" busy={loading}>{loading?'正在读取会话…':'没有匹配的 ACP 会话'}</AcpEmpty>}
      </>}
    </div>
    <footer><button type="button" className="subtle" disabled={busy} data-dismiss="dialog">关闭</button></footer>
  </Dialog>;
}
