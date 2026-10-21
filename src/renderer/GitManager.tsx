import { useCallback, useEffect, useRef, useState } from 'react';
import type { GitFile, GitOperation, GitResult, GitStatus, Project } from '../shared/protocol';
import { readStored, saveStored } from './storage';

function useGitStatus(project: Project, enabled: boolean) {
  const [status,setStatus]=useState<GitStatus|null>(null),[loading,setLoading]=useState(false),[error,setError]=useState('');
  const alive=useRef(true),generation=useRef(0);
  const pending=useRef<{key:string;generation:number}|null>(null);
  const refresh=useCallback(async()=>{
    if(!enabled)return;
    const key=project.id+'\0'+project.path;
    if(pending.current?.key===key&&pending.current.generation===generation.current)return;
    const request={key,generation:generation.current};pending.current=request;setLoading(true);
    try {const value=await window.berth.rpc<GitStatus>('gitStatus',{projectId:project.id});if(alive.current&&request.generation===generation.current){setStatus(value);setError('');}}
    catch(reason){if(alive.current&&request.generation===generation.current)setError(String(reason));}
    finally{if(pending.current===request){pending.current=null;if(alive.current)setLoading(false);}}
  },[project.id,project.path,enabled]);
  const applyStatus=useCallback((value:GitStatus)=>{generation.current++;setStatus(value);setError('');},[]);
  useEffect(()=>{
    alive.current=true;void refresh();
    const update=()=>{if(document.visibilityState==='visible'){generation.current++;void refresh();}};
    const timer=setInterval(()=>{if(document.visibilityState==='visible' && document.hasFocus())void refresh();},15000);
    window.addEventListener('focus',update);window.addEventListener('berth:git-refresh',update);
    return()=>{alive.current=false;generation.current++;clearInterval(timer);window.removeEventListener('focus',update);window.removeEventListener('berth:git-refresh',update);};
  },[refresh]);
  return{status,loading,error,refresh,setStatus:applyStatus};
}
const branchLabel=(status:GitStatus|null)=>status?.kind==='repository' ? status.branch || `游离 ${status.head?.slice(0,7)??'HEAD'}` : status?.kind==='not-repository'?'非 Git 项目':status?'Git 不可用':'Git…';
export function GitBranch({project,enabled,onOpen}:{project:Project;enabled:boolean;onOpen:()=>void}){
  const {status,error}=useGitStatus(project,enabled);
  return <button className="git-branch" aria-label={`Git 管理 ${project.name}`} title={!enabled?'更新后台后可使用 Git 管理':error || status?.message || `${status?.root??project.path}\n${status?.upstream??'未配置上游'} · 领先/落后以最近获取为准`} onClick={onOpen} disabled={!enabled}>
    <svg width="14" height="14" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><circle cx="5" cy="4" r="2"/><circle cx="15" cy="4" r="2"/><circle cx="5" cy="16" r="2"/><path d="M5 6v8m0-3c7 0 10-1 10-5"/></svg><span>{branchLabel(status)}</span>{status?.kind==='repository'&&<><small>{status.total?` · ${status.total} 项改动`:''}</small><small>↑{status.ahead} ↓{status.behind}</small>{status.busy&&<small>处理中…</small>}</>}
  </button>;
}
const actions = { fetch: '获取远端', pull: '拉取', push: '推送', sync: '同步远端', switch: '切换分支', switchRemote: '切换远端分支', stage: '暂存', unstage: '取消暂存', commit: '提交' };
export function GitSidebar({ project, enabled, visible, supported, onDiff, onNotice, onError }: { project: Project; enabled: boolean; visible: boolean; supported: boolean; onDiff: (path: string, staged: boolean) => void; onNotice: (message: string) => void; onError: (message: string) => void }) {
  const { status, loading, error, refresh, setStatus } = useGitStatus(project, enabled && visible);
  const [remote, setRemote] = useState(''), [branch, setBranch] = useState('');
  const [branchScope, setBranchScope] = useState<'local' | 'remote'>('local'), [branchQuery, setBranchQuery] = useState(''), [localBranch, setLocalBranch] = useState('');
  const [working, setWorking] = useState<GitOperation['action'] | null>(null), [failure, setFailure] = useState(''), [output, setOutput] = useState(''), [notice, setNotice] = useState('');
  const [message, setMessage] = useState(() => readStored(`berth.commit.${project.id}`) ?? '');
  const [selected, setSelected] = useState<Set<string>>(new Set()), [query, setQuery] = useState(''), [pageSize, setPageSize] = useState(100);
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => { saveStored(`berth.commit.${project.id}`, message || null); }, [project.id, message]);
  useEffect(() => { if (status) { setRemote(status.upstreamRemote && status.remotes.includes(status.upstreamRemote) ? status.upstreamRemote : status.remotes.includes('origin') ? 'origin' : status.remotes[0] ?? ''); setBranch(''); } }, [status?.branch, status?.upstreamRemote, status?.remotes.join('\0')]);
  useEffect(() => { setSelected(previous => new Set([...previous].filter(key => { const [area, path] = JSON.parse(key) as string[]; return status?.files.some(file => file.path === path && (area === 'index' ? file.index !== '.' && file.index !== '?' : file.worktree !== '.' || file.conflict)); }))); }, [status]);
  useEffect(() => setPageSize(100), [query]);
  const blocked = !enabled || (!status && loading) || !!working || !!status?.busy;
  const repository = status?.kind === 'repository';
  const canWrite = repository && !!status.branch && !!status.head && !status.operation && !status.conflicts;
  const canChange = repository && !status.operation && !status.conflicts;
  const remoteSupported = status?.remoteBranches !== undefined;
  const remoteBranches = (status?.remoteBranches ?? []).filter(item => item.remote === remote);
  const selectedRemote = branchScope === 'remote' ? remoteBranches.find(item => item.ref === branch) : undefined;
  const matchesBranch = (name: string) => name.toLocaleLowerCase().includes(branchQuery.toLocaleLowerCase());
  const matchingLocal = (status?.branches ?? []).filter(matchesBranch), matchingRemote = remoteBranches.filter(item => matchesBranch(`${item.remote}/${item.branch}`));
  const switchScope = (scope: 'local' | 'remote') => { setBranchScope(scope); setBranch(''); setLocalBranch(''); setBranchQuery(''); };
  const pickBranch = (value: string) => { setBranch(value); const item = remoteBranches.find(item => item.ref === value); setLocalBranch(item ? item.localBranches.includes(item.branch) ? item.branch : item.localBranches[0] ?? item.branch : ''); };
  const remoteCollision = !!selectedRemote && !!localBranch && !!status?.branches.includes(localBranch) && !selectedRemote.localBranches.includes(localBranch);
  async function act(action: GitOperation['action'], paths?: string[]) {
    if (!status || !repository || blocked) return;
    setWorking(action); setFailure(''); setNotice(''); setOutput('');
    try {
      const result = await window.berth.rpc<GitResult>('gitOperation', { projectId: project.id, action, expected: { root: status.root, branch: status.branch, head: status.head },
        ...(action === 'stage' || action === 'unstage' ? { paths } : action === 'commit' ? { message } : action === 'switch' ? { branch } : action === 'switchRemote' && selectedRemote ? { remote: selectedRemote.remote, branch: selectedRemote.branch, remoteRef: selectedRemote.ref, remoteHead: selectedRemote.head, localBranch } : { remote, ...(status.upstreamBranch || status.branch ? { branch: status.upstreamBranch || status.branch } : {}) }) });
      if (action === 'commit') saveStored(`berth.commit.${project.id}`, null);
      if (alive.current) { setStatus(result.status); setOutput(result.output); setNotice(result.message); setSelected(new Set()); if (action === 'commit') setMessage(''); }
      onNotice(`${project.name}：${result.message}`);
    } catch (reason) {
      const detail = String(reason).replace(/^Error: /, '');
      if (alive.current) { setFailure(detail); void refresh(); }
      onError(`${project.name}：${detail}`);
    } finally { if (alive.current) setWorking(null); window.dispatchEvent(new Event('berth:git-refresh')); }
  }
  function group(staged: boolean) {
    if (!status) return null;
    const area = staged ? 'index' : 'worktree', label = staged ? '已暂存的更改' : '更改';
    const all = status.files.filter(file => staged ? file.index !== '.' && file.index !== '?' && !file.conflict : file.worktree !== '.' || file.conflict);
    const filtered = all.filter(file => file.path.toLocaleLowerCase().includes(query.toLocaleLowerCase()));
    const chosen = filtered.filter(file => selected.has(JSON.stringify([area, file.path])));
    const toggle = (file: GitFile) => setSelected(previous => { const next = new Set(previous), key = JSON.stringify([area, file.path]); if (next.has(key)) next.delete(key); else next.add(key); return next; });
    return <section className="scm-group" aria-label={label}><div className="scm-group-heading"><strong>{label}<small>{all.length}</small></strong>
      <button disabled={blocked || !supported || !chosen.length || chosen.length > 500} title={chosen.length ? `操作选中的 ${chosen.length} 个文件（每批最多 500 个）` : '先选择文件；每行按钮可单独操作'} onClick={() => void act(staged ? 'unstage' : 'stage', chosen.map(file => file.path))} aria-label={staged ? '取消暂存所选文件' : '暂存所选文件'}>{staged ? '−' : '+'}{chosen.length || ''}</button>
      <input type="checkbox" aria-label={`选择全部${label}`} title="每批最多选择 500 个文件" checked={!!filtered.length && chosen.length === Math.min(500, filtered.length)} disabled={!filtered.length || blocked} onChange={event => setSelected(previous => { const next = new Set(previous); for (const file of filtered.slice(0, 500)) { const key = JSON.stringify([area, file.path]); if (event.target.checked) next.add(key); else next.delete(key); } return next; })} />
    </div><ul className="scm-files">{filtered.slice(0, pageSize).map(file => <li key={file.path}>
      <input type="checkbox" aria-label={`选择${staged ? '已暂存' : '未暂存'}文件 ${file.path}`} checked={selected.has(JSON.stringify([area, file.path]))} disabled={blocked} onChange={() => toggle(file)} />
      <button className="scm-file" title={`${file.originalPath ? file.originalPath + ' → ' : ''}${file.path}`} aria-label={`查看${staged ? '已暂存' : '未暂存'}差异 ${file.path}`} disabled={!enabled || !supported} onClick={() => onDiff(file.path, staged)}><span>{file.path.split('/').at(-1)}</span><small>{file.path.includes('/') ? file.path.slice(0, file.path.lastIndexOf('/')) : ''}</small><b className={file.conflict ? 'danger-text' : ''}>{file.conflict ? '!' : staged ? file.index : file.index === '?' ? 'U' : file.worktree}</b></button>
      <button className="scm-file-action" disabled={blocked || !supported} aria-label={`${staged ? '取消暂存' : '暂存'} ${file.path}`} onClick={() => void act(staged ? 'unstage' : 'stage', [file.path])}>{staged ? '−' : '+'}</button>
    </li>)}</ul>{!filtered.length && <p className="scm-empty">{query && all.length ? '没有匹配文件' : staged ? '尚无已暂存文件' : '工作目录干净'}</p>}{filtered.length > pageSize && <button className="scm-more" onClick={() => setPageSize(value => value + 100)}>显示更多（{filtered.length - pageSize}）</button>}</section>;
  }
  return <section className="git-manager scm-sidebar" aria-label={`源代码管理 ${project.name}`}>
    <div className="git-heading"><strong title={status?.root ?? project.path}>{branchLabel(status)}</strong><button className="text-button" aria-label="刷新状态" title="刷新状态" disabled={!!working || loading || !enabled} onClick={() => void refresh()}>↻</button></div>
    {!supported && <p className="form-hint">更新后台后可使用文件差异、暂存和提交。</p>}
    {failure || error ? <p className="form-error" role="alert">{failure || error}</p> : null}
    {loading && !status ? <p role="status">正在读取 Git 状态…</p> : !repository ? <p className="form-hint">{status?.message || '连接后台后读取 Git 状态。'}{status?.kind === 'not-repository' && ' 可在终端 git init，或选择已有 Git 项目。'}</p> : <>
      <div className="git-summary"><span>已暂存 {status.staged}</span><span>未暂存 {status.modified}</span><span>未跟踪 {status.untracked}</span>{!!status.conflicts && <span className="danger-text">冲突 {status.conflicts}</span>}</div>
      <form className="scm-commit" onSubmit={event => { event.preventDefault(); void act('commit'); }}><textarea aria-label="Git 提交信息" placeholder="提交信息（Ctrl+Enter 提交）" maxLength={8000} value={message} disabled={!!working} onChange={event => setMessage(event.target.value)} onKeyDown={event => { if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') { event.preventDefault(); if (message.trim() && status.staged && canChange && !blocked && supported) void act('commit'); } }} /><button className="primary" disabled={blocked || !supported || !message.trim() || !status.staged || !canChange}>提交已暂存的更改{status.staged ? `（${status.staged}）` : ''}</button></form>
      {status.operation && <p className="form-error">正在{status.operation}，可暂存已解决的文件；完成操作请使用终端。</p>}
      <details className="scm-network"><summary>分支与远端</summary><code className="git-root" title={status.root}>{status.root}</code><p className="git-tracking"><span>{status.upstream ? `上游 ${status.upstream} · 领先 ${status.ahead} / 落后 ${status.behind}` : '当前分支未配置远端上游'}</span><small>领先/落后以最近获取为准</small></p>
        <label>远端<select aria-label="Git 远端" value={remote} disabled={blocked} onChange={event => { setRemote(event.target.value); if (branchScope === 'remote') { setBranch(''); setLocalBranch(''); } }}>{!status.remotes.length && <option value="">未配置远端</option>}{status.remotes.map(name => <option key={name}>{name}</option>)}</select></label>
        <div className="git-actions"><button className="subtle" disabled={blocked || !remote} onClick={() => void act('fetch')}>获取远端</button><button className="subtle" disabled={blocked || !remote || !canWrite || !status.upstream} onClick={() => void act('pull')}>拉取</button><button className="subtle" disabled={blocked || !remote || !canWrite} onClick={() => void act('push')}>{status.upstream ? '推送' : '发布当前分支'}</button><button className="subtle" disabled={blocked || !remote || !canWrite} onClick={() => void act('sync')}>同步远端</button></div>
        <div className="scm-branch-tabs" role="tablist" aria-label="Git 分支范围"><button role="tab" aria-selected={branchScope === 'local'} disabled={!!working} onClick={() => switchScope('local')}>本地分支</button><button role="tab" aria-selected={branchScope === 'remote'} disabled={!!working || !remoteSupported} title={remoteSupported ? '查看已获取的远端分支' : '更新后台后可查看和切换远端分支'} onClick={() => switchScope('remote')}>远端分支</button></div>
        {!remoteSupported && <p className="form-hint">更新后台后可查看并切换远端分支。</p>}
        <input className="scm-filter" aria-label="筛选 Git 分支" placeholder="筛选分支…" value={branchQuery} onChange={event => { setBranchQuery(event.target.value); setBranch(''); setLocalBranch(''); }} />
        <div className="git-switch"><select aria-label="切换 Git 分支" value={branch} disabled={blocked} onChange={event => pickBranch(event.target.value)}><option value="">{branchScope === 'local' ? '选择本地分支' : '选择远端分支'}</option>{branchScope === 'local' ? matchingLocal.map(name => <option key={name} value={name} disabled={name === status.branch}>{name}</option>) : matchingRemote.map(item => <option key={item.ref} value={item.ref}>{item.remote}/{item.branch}{item.localBranches.length ? ' · 已有本地跟踪分支' : ''}</option>)}</select><button className="subtle" disabled={blocked || !canChange || !branch || (branchScope === 'remote' && (!selectedRemote || !localBranch.trim() || remoteCollision || (localBranch === status.branch && selectedRemote.localBranches.includes(localBranch))))} onClick={() => void act(branchScope === 'remote' ? 'switchRemote' : 'switch')}>切换分支</button></div>
        {branchScope === 'remote' && <>
          <p className="form-hint">分支列表以最近获取为准；点击“获取远端”更新并清理已删除的分支。{status.fetchedAt ? ` 最近获取：${new Date(status.fetchedAt).toLocaleString()}` : ''}</p>
          {!remoteBranches.length && <p className="scm-empty">{remote ? '尚无已获取的远端分支，请先获取远端。' : '请先配置并选择远端。'}</p>}
          {!!remoteBranches.length && !matchingRemote.length && <p className="scm-empty">没有匹配的远端分支。</p>}
          {status.remoteBranchesTruncated && <p className="form-hint">远端分支超过 2000 个，其余请在终端查看。</p>}
          {selectedRemote && <label>本地分支名称<input aria-label="远端分支的本地名称" value={localBranch} maxLength={1024} disabled={blocked} onChange={event => setLocalBranch(event.target.value)} /><span className={remoteCollision ? 'form-error' : 'form-hint'}>{remoteCollision ? '此本地分支已存在且跟踪关系不同，请更换名称或切换至本地分支列表。' : selectedRemote.localBranches.includes(localBranch) ? '切换到已有跟踪分支，保留其本地提交。' : '将创建本地分支并自动设置远端上游。'}</span></label>}
        </>}

      </details>
      <input className="scm-filter" aria-label="筛选更改文件" placeholder="筛选更改文件…" value={query} onChange={event => setQuery(event.target.value)} />
      {group(true)}{group(false)}
      {status.total > status.files.length && <p className="form-hint">已显示前 {status.files.length} 个文件，其余可在终端查看。</p>}
    </>}
    {(working || status?.busy) && <p role="status" className="git-progress">{working ? `正在${actions[working]}…` : 'Git 操作进行中…'}</p>}
    {notice && <p role="status" className="git-success">{notice}</p>}
    {output && <details><summary>Git 输出</summary><pre className="git-output">{output}</pre></details>}
  </section>;
}
