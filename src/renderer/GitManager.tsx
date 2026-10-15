import { useCallback, useEffect, useRef, useState } from 'react';
import type { GitOperation, GitResult, GitStatus, Project } from '../shared/protocol';
import { Dialog } from './Dialog';

function useGitStatus(project: Project, enabled: boolean) {
  const [status,setStatus]=useState<GitStatus|null>(null),[loading,setLoading]=useState(false),[error,setError]=useState('');
  const alive=useRef(true),pending=useRef(false);
  const refresh=useCallback(async()=>{
    if(!enabled || pending.current)return;
    pending.current=true;setLoading(true);
    try {const value=await window.berth.rpc<GitStatus>('gitStatus',{projectId:project.id});if(alive.current){setStatus(value);setError('');}}
    catch(reason){if(alive.current)setError(String(reason));}
    finally{pending.current=false;if(alive.current)setLoading(false);}
  },[project.id,project.path,enabled]);
  useEffect(()=>{
    alive.current=true;void refresh();
    const update=()=>{if(document.visibilityState==='visible')void refresh();};
    const timer=setInterval(()=>{if(document.visibilityState==='visible' && document.hasFocus())void refresh();},15000);
    window.addEventListener('focus',update);window.addEventListener('berth:git-refresh',update);
    return()=>{alive.current=false;clearInterval(timer);window.removeEventListener('focus',update);window.removeEventListener('berth:git-refresh',update);};
  },[refresh]);
  return{status,loading,error,refresh,setStatus};
}
const branchLabel=(status:GitStatus|null)=>status?.kind==='repository' ? status.branch || `游离 ${status.head?.slice(0,7)??'HEAD'}` : status?.kind==='not-repository'?'非 Git 项目':status?'Git 不可用':'Git…';
export function GitBranch({project,enabled,onOpen}:{project:Project;enabled:boolean;onOpen:()=>void}){
  const {status,error}=useGitStatus(project,enabled);
  return <button className="git-branch" aria-label={`Git 管理 ${project.name}`} title={!enabled?'更新后台后可使用 Git 管理':error || status?.message || `${status?.root??project.path}\n${status?.upstream??'未配置上游'} · 领先/落后以最近获取为准`} onClick={onOpen} disabled={!enabled}>
    <svg width="14" height="14" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><circle cx="5" cy="4" r="2"/><circle cx="15" cy="4" r="2"/><circle cx="5" cy="16" r="2"/><path d="M5 6v8m0-3c7 0 10-1 10-5"/></svg><span>{branchLabel(status)}</span>{status?.kind==='repository'&&<><small>{status.total?` · ${status.total} 项改动`:''}</small><small>↑{status.ahead} ↓{status.behind}</small>{status.busy&&<small>处理中…</small>}</>}
  </button>;
}
const actions={fetch:'获取远端',pull:'拉取',push:'推送',sync:'同步远端',switch:'切换分支'};
export function GitDialog({project,enabled,running,activeProjects,platform,onClose,onNotice,onError,returnFocus}:{project:Project;enabled:boolean;running:boolean;activeProjects:Project[];platform:string;onClose:()=>void;onNotice:(message:string)=>void;onError:(message:string)=>void;returnFocus:HTMLElement|null}){
  const {status,loading,error,refresh,setStatus}=useGitStatus(project,enabled);
  const [remote,setRemote]=useState(''),[branch,setBranch]=useState(''),[working,setWorking]=useState<GitOperation['action']|null>(null),[failure,setFailure]=useState(''),[output,setOutput]=useState(''),[notice,setNotice]=useState('');
  const alive=useRef(true);useEffect(()=>()=>{alive.current=false;},[]);
  useEffect(()=>{if(status){setRemote(status.upstreamRemote&&status.remotes.includes(status.upstreamRemote)?status.upstreamRemote:status.remotes.includes('origin')?'origin':status.remotes[0]??'');setBranch('');}},[status?.branch,status?.upstreamRemote,status?.remotes.join('\0')]);
  const blocked=!enabled||loading||!!working||!!status?.busy;
  const repository=status?.kind==='repository';
  const canWrite=repository&&!!status.branch&&!!status.head&&!status.operation&&!status.conflicts;
  const normalize=(value:string)=>{const result=value.replaceAll('\\','/').replace(/\/+$/,'');return platform==='win32'?result.toLowerCase():result;};
  const root=normalize(status?.root??project.path);
  const affectedRunning=running||activeProjects.some(value=>{const candidate=normalize(value.path);return candidate===root||candidate.startsWith(root+'/')||root.startsWith(candidate+'/');});
  const canChange=repository&&!status.total&&!status.operation&&!affectedRunning;
  async function act(action:GitOperation['action']){
    if(!status||!repository)return;
    setWorking(action);setFailure('');setNotice('');setOutput('');
    try{
      const result=await window.berth.rpc<GitResult>('gitOperation',{projectId:project.id,action,expected:{root:status.root,branch:status.branch,head:status.head},...(action==='switch'?{branch}:{remote,...(status.upstreamBranch||status.branch?{branch:status.upstreamBranch||status.branch}:{})})});
      if(alive.current){setStatus(result.status);setOutput(result.output);setNotice(result.message);}
      onNotice(`${project.name}：${result.message}`);
    }catch(reason){const message=String(reason).replace(/^Error: /,'');if(alive.current)setFailure(message);onError(`${project.name}：${message}`);}
    finally{if(alive.current){setWorking(null);void refresh();}window.dispatchEvent(new Event('berth:git-refresh'));}
  }
  return <Dialog title={`Git · ${project.name}`} returnFocus={returnFocus} onClose={onClose} error={failure||error}>
    <div className="git-manager">
      <div className="git-heading"><strong>{branchLabel(status)}</strong><button className="subtle" disabled={!!working||loading||!enabled} onClick={()=>void refresh()}>刷新状态</button></div>
      {loading&&!status?<p role="status">正在读取 Git 状态…</p>:!repository?<p className="form-hint">{status?.message||'更新后台后可使用 Git 管理'}{status?.kind==='not-repository'&&'。可在终端 git init，或添加已有 Git 仓库目录。'}</p>:<>
        <span className="form-hint">仓库根目录（操作作用于整个工作区）</span><code className="git-root" title={status.root}>{status.root}</code>
        <div className="git-summary"><span>已暂存 {status.staged}</span><span>未暂存 {status.modified}</span><span>未跟踪 {status.untracked}</span><span className={status.conflicts?'danger-text':''}>冲突 {status.conflicts}</span></div>
        <p className="git-tracking"><span>{status.upstream?`上游 ${status.upstream} · 领先 ${status.ahead} / 落后 ${status.behind}`:'当前分支未配置远端上游'}</span><small>领先/落后以最近获取为准{status.fetchedAt?` · ${new Date(status.fetchedAt).toLocaleString('zh-CN')}`:''}</small></p>
        {status.operation&&<p className="form-error">仓库正在{status.operation}，请先在终端完成或取消。</p>}
        <label>远端<select aria-label="Git 远端" value={remote} disabled={blocked} onChange={event=>setRemote(event.target.value)}>{!status.remotes.length&&<option value="">未配置远端</option>}{status.remotes.map(name=><option key={name} value={name}>{name}</option>)}</select></label>
        <p className="form-hint">目标：{remote?`${remote}/${status.upstreamBranch||status.branch||'—'}`:'请先在终端配置远端'}。推送只包含已提交的改动，拉取仅做快进。</p>
        <div className="git-actions"><button className="subtle" disabled={blocked||!remote} onClick={()=>void act('fetch')}>获取远端</button><button className="subtle" disabled={blocked||!remote||!canWrite||!canChange||!status.upstream} onClick={()=>void act('pull')}>拉取</button><button className="subtle" disabled={blocked||!remote||!canWrite} onClick={()=>void act('push')}>{status.upstream?'推送':'发布当前分支'}</button><button className="primary" disabled={blocked||!remote||!canWrite||!canChange} onClick={()=>void act('sync')}>同步远端</button></div>
        {affectedRunning&&<p className="form-hint">项目终端运行中，可获取远端和推送；拉取或切换分支前请先停止相关终端。</p>}
        {!!status.total&&<p className="form-hint">有未提交改动时保留工作区，暂不能拉取或切换分支。</p>}
        <details className="advanced-options"><summary>本地分支与工作区改动（{status.total}）</summary>
          <div className="git-switch"><select aria-label="切换 Git 分支" value={branch} disabled={blocked||!canChange} onChange={event=>setBranch(event.target.value)}><option value="">选择本地分支</option>{status.branches.map(name=><option key={name} value={name} disabled={name===status.branch}>{name}</option>)}</select><button className="subtle" disabled={blocked||!canChange||!branch} onClick={()=>void act('switch')}>切换分支</button></div>
          {!status.files.length?<p className="form-hint">工作区干净</p>:<ul className="git-files">{status.files.map((file,index)=><li key={index}><span className={file.conflict?'danger-text':''}>{file.conflict?'冲突':file.index==='?'?'未跟踪':`${file.index==='.'?'—':file.index} ${file.worktree==='.'?'—':file.worktree}`}</span><code>{file.originalPath?file.originalPath+' → ':''}{file.path}</code></li>)}</ul>}{status.total>status.files.length&&<p className="form-hint">只展示前 100 项，其余可在终端查看。</p>}
        </details>
      </>}
      {(working||status?.busy)&&<p role="status" className="git-progress">{working?`正在${actions[working]}…`:'此仓库正在执行 Git 操作…'} 可关闭面板，操作完成后会提示结果。</p>}
      {notice&&<p role="status" className="git-success">{notice}</p>}
      {output&&<details className="advanced-options"><summary>Git 输出</summary><pre className="git-output">{output}</pre></details>}
    </div>
    <footer><button className="subtle" onClick={onClose}>关闭 Git 面板</button></footer>
  </Dialog>;
}
