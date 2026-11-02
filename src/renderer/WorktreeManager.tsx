import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { createPortal } from 'react-dom';
import { Dialog } from './Dialog';
import { AsyncButton } from './AsyncButton';
import type { GitStatus, GitWorktree, Project } from '../shared/protocol';

function useWorktrees(project: Project, enabled: boolean, visible: boolean) {
  const [worktrees, setWorktrees] = useState<GitWorktree[]>([]);
  const [status, setStatus] = useState<GitStatus | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const alive = useRef(true), generation = useRef(0);
  const refresh = useCallback(async () => {
    if (!enabled || !visible) return;
    const token = ++generation.current;
    setLoading(true);
    try {
      const [items, metadata] = await Promise.all([
        window.berth.rpc<GitWorktree[]>('gitWorktrees', { projectId: project.id }),
        window.berth.rpc<GitStatus>('gitStatus', { projectId: project.id }),
      ]);
      if (alive.current && generation.current === token) {
        setWorktrees(items); setStatus(metadata.kind === 'repository' ? metadata : null);
        setError(metadata.kind === 'repository' ? '' : metadata.message ?? '无法读取分支，请刷新重试');
      }
    } catch (reason) {
      if (alive.current && generation.current === token) {
        setStatus(null); setError(String(reason).replace(/^Error: /, ''));
      }
    } finally { if (alive.current && generation.current === token) setLoading(false); }
  }, [project.id, enabled, visible]);
  useEffect(() => {
    alive.current = true;
    if (enabled && visible) void refresh();
    const update = () => { if (visible) void refresh(); };
    window.addEventListener('berth:worktree-refresh', update);
    return () => { generation.current++; window.removeEventListener('berth:worktree-refresh', update); };
  }, [refresh, enabled, visible]);
  useEffect(() => () => { alive.current = false; generation.current++; }, []);
  const changed = () => {
    window.dispatchEvent(new Event('berth:worktree-refresh'));
    window.dispatchEvent(new Event('berth:git-refresh'));
  };
  const create = useCallback(async (branch: string, createBranch: boolean, baseRef?: string) => {
    const item = await window.berth.rpc<GitWorktree>('gitCreateWorktree', {
      projectId: project.id, branch, createBranch, ...(baseRef ? { baseRef } : {}),
    });
    changed(); await refresh(); return item;
  }, [project.id, refresh]);
  const remove = useCallback(async (item: GitWorktree, deleteSessions: boolean) => {
    await window.berth.rpc('gitRemoveWorktree', { projectId: project.id, path: item.path, deleteSessions });
    changed(); await refresh();
  }, [project.id, refresh]);
  const fetchRemote = useCallback(async (remote: string) => {
    const current = await window.berth.rpc<GitStatus>('gitStatus', { projectId: project.id });
    if (current.kind !== 'repository') throw new Error(current.message ?? '无法读取仓库');
    await window.berth.rpc('gitOperation', { projectId: project.id, action: 'fetch', remote,
      expected: { root: current.root, branch: current.branch, head: current.head } });
    changed(); await refresh();
  }, [project.id, refresh]);
  return { worktrees, status, loading, error, refresh, create, remove, fetchRemote };
}

function WorktreeCreateDialog({ status, worktrees, disabled, error, onFetch, onCreate, onCancel, onCreated }: {
  status: GitStatus | null; worktrees: GitWorktree[]; disabled: boolean; error: string;
  onFetch: (remote: string) => Promise<void>;
  onCreate: (branch: string, createBranch: boolean, baseRef?: string) => Promise<GitWorktree | null>;
  onCancel: () => void; onCreated: (item: GitWorktree) => void;
}) {
  const [mode, setMode] = useState<'new' | 'existing' | 'remote'>('new');
  const [branch, setBranch] = useState(''), [baseRef, setBaseRef] = useState(''), [remoteKey, setRemoteKey] = useState('');
  const [remote, setRemote] = useState(status?.remotes.includes('origin') ? 'origin' : status?.remotes[0] ?? '');
  const [busy, setBusy] = useState(false), [fetching, setFetching] = useState(false), [localError, setLocalError] = useState('');
  const [returnFocus] = useState(() => document.activeElement as HTMLElement | null);
  const branches = status?.branches ?? [], remoteBranches = status?.remoteBranches ?? [];
  const key = (item: (typeof remoteBranches)[number]) => JSON.stringify([item.remote, item.ref]);
  const source = remoteBranches.find(item => key(item) === remoteKey);
  const checkedOut = new Set(worktrees.map(item => item.branch).filter((value): value is string => !!value));
  const available = branches.filter(name => !checkedOut.has(name));
  const locked = disabled || busy || fetching;
  async function submit(event: FormEvent) {
    event.preventDefault(); event.stopPropagation();
    if (locked || !branch.trim()) return;
    if (mode === 'remote' && !source) { setLocalError('请选择远端分支；列表变化后请重新选择'); return; }
    if (mode === 'existing' && !available.includes(branch)) { setLocalError('该本地分支已被占用，请重新选择'); return; }
    setBusy(true); setLocalError('');
    try {
      const item = await onCreate(branch.trim(), mode !== 'existing', mode === 'remote' ? source!.ref : mode === 'new' ? baseRef || undefined : undefined);
      if (item) onCreated(item);
    } catch (reason) { setLocalError(String(reason)); }
    finally { setBusy(false); }
  }
  const suggested = (name: string) => {
    if (!branches.includes(name)) return name;
    let value = name + '-worktree', suffix = 2;
    while (branches.includes(value)) value = name + '-worktree-' + suffix++;
    return value;
  };
  return createPortal(<Dialog title="创建 Worktree" onClose={onCancel} returnFocus={returnFocus} busy={busy || fetching} dirty={!!branch.trim()} error={localError || error}>
    <form className="worktree-create-form" onSubmit={event => void submit(event)}>
      <label>分支来源
        <select aria-label="分支来源" value={mode} disabled={locked} onChange={event => { setMode(event.target.value as typeof mode); setBranch(''); setRemoteKey(''); setLocalError(''); }}>
          <option value="new">创建新分支</option><option value="existing">使用已有本地分支</option><option value="remote">从远端分支创建</option>
        </select>
      </label>
      {mode === 'existing' ? <label>选择本地分支
        <select aria-label="选择本地分支" autoFocus value={branch} disabled={locked || !available.length} onChange={event => setBranch(event.target.value)}>
          <option value="">{available.length ? '选择尚未被 Worktree 使用的分支' : '没有可用分支'}</option>
          {available.map(name => <option key={name} value={name}>{name}</option>)}
        </select>
      </label> : <>
        {mode === 'remote' && <label>远端分支
          <select aria-label="远端分支" value={remoteKey} disabled={locked} onChange={event => {
            const item = remoteBranches.find(item => key(item) === event.target.value);
            setRemoteKey(event.target.value); setBranch(item ? suggested(item.branch) : ''); if (item) setRemote(item.remote);
          }}>
            <option value="">{remoteBranches.length ? '选择远端分支' : '暂无远端分支，请先获取远端更新'}</option>
            {(status?.remotes ?? []).map(name => <optgroup key={name} label={name}>{remoteBranches.filter(item => item.remote === name).map(item => <option key={key(item)} value={key(item)}>{item.remote}/{item.branch}</option>)}</optgroup>)}
          </select>
        </label>}
        <label>{mode === 'remote' ? '本地分支名称' : '新分支名称'}
          <input autoFocus={mode === 'new'} required value={branch} maxLength={255} placeholder="feature/my-task" disabled={locked} onChange={event => setBranch(event.target.value)} />
        </label>
        {mode === 'new' && <label>起始分支（可选）
          <select aria-label="起始分支（可选）" value={baseRef} disabled={locked} onChange={event => setBaseRef(event.target.value)}>
            <option value="">当前 HEAD</option>
            <optgroup label="本地分支">{branches.map(name => <option key={name} value={'refs/heads/' + name}>{name}</option>)}</optgroup>
            <optgroup label="远端分支">{remoteBranches.map(item => <option key={key(item)} value={item.ref}>{item.remote}/{item.branch}</option>)}</optgroup>
          </select>
        </label>}
      </>}
      <div className="worktree-fetch">
        <label>获取远端<select aria-label="获取 Worktree 远端" value={remote} disabled={locked || !status?.remotes.length} onChange={event => setRemote(event.target.value)}>
          {!status?.remotes.length && <option value="">未配置远端</option>}{status?.remotes.map(name => <option key={name}>{name}</option>)}
        </select></label>
        <AsyncButton className="subtle" disabled={locked || !remote} onError={setLocalError} onAction={async () => { setFetching(true); try { await onFetch(remote); } finally { setFetching(false); } }}>获取远端分支</AsyncButton>
      </div>
      <p className="form-hint">{mode === 'remote' ? '创建本地跟踪分支和独立工作目录。可修改本地分支名称。' : '新工作区使用独立目录；创建成功后会自动选中。'}{status?.remoteBranchesTruncated && ' 远端分支较多，当前显示前 2000 条。'}</p>
      <footer><button type="button" className="subtle" disabled={busy || fetching} onClick={onCancel}>取消</button><button type="submit" className="primary" aria-busy={busy} disabled={locked || !branch.trim() || mode === 'remote' && !source}>{busy ? '正在创建…' : '创建 Worktree'}</button></footer>
    </form>
  </Dialog>, document.body);
}

export function WorktreeManager({
  project, enabled, visible, selectedPath, onSelect, onNewSession, onNotice, onError,
}: {
  project: Project;
  enabled: boolean;
  visible: boolean;
  selectedPath: string | null;
  onSelect: (path: string | null) => void;
  onNewSession: (path: string | null) => void;
  onNotice: (message: string) => void;
  onError: (message: string) => void;
}) {
  const data = useWorktrees(project, enabled, visible);
  const [creating, setCreating] = useState(false);
  const [actionError, setActionError] = useState('');
  useEffect(() => {
    if (selectedPath && data.worktrees.length && !data.worktrees.some(item => !item.main && item.workingPath === selectedPath)) onSelect(null);
  }, [selectedPath, data.worktrees, onSelect]);

  async function create(branch: string, createBranch: boolean, baseRef?: string) {
    setActionError('');
    try {
      const item = await data.create(branch, createBranch, baseRef);
      onSelect(item.workingPath);
      onNotice('已创建 Worktree：' + (item.branch ?? branch));
      return item;
    } catch (reason) {
      const message = String(reason).replace(/^Error: /, '');
      setActionError(message);
      onError(message);
      return null;
    }
  }
  async function remove(item: GitWorktree) {
    const count = item.sessionCount ?? 0;
    const deleteSessions = count > 0;
    if (deleteSessions && !window.confirm('此 Worktree 关联了 ' + count + ' 个会话。删除 Worktree 时也会删除这些会话及运行记录；Git 会拒绝移除仍有未提交改动的工作区。确定继续吗？')) return;
    setActionError('');
    try {
      await data.remove(item, deleteSessions);
      if (selectedPath === item.workingPath) onSelect(null);
      onNotice('已移除 Worktree：' + (item.branch ?? item.path));
    } catch (reason) {
      const message = String(reason).replace(/^Error: /, '');
      setActionError(message);
      onError(message);
    }
  }

  return <section className="worktree-manager" aria-label="Git Worktree 管理">
    <div className="worktree-heading">
      <strong>Worktree</strong>
      <button type="button" className="text-button" aria-label="刷新 Worktree" title="刷新 Worktree" disabled={!enabled || data.loading} onClick={() => void data.refresh()}>↻</button>
    </div>
    {!enabled && <p className="form-hint">更新后台至 API 43 后可使用 Worktree。</p>}
    {data.loading && !data.worktrees.length && <p className="form-hint">正在读取 Worktree…</p>}
    {data.error && <p className="form-hint" role="status">{data.error}。请确认项目目录是 Git 仓库。</p>}
    {!!data.worktrees.length && <div className="worktree-list">
      {data.worktrees.map(item => {
        const selected = item.main ? selectedPath === null : selectedPath === item.workingPath;
        return <div className={'worktree-row' + (selected ? ' selected' : '')} key={item.path}>
          <button type="button" className="worktree-select" aria-pressed={selected} onClick={() => onSelect(item.main ? null : item.workingPath)}>
            <span className="worktree-name">{item.main ? '主工作区' : item.branch ?? '游离 HEAD'}{item.locked ? ' · 已锁定' : ''}{item.prunable ? ' · 已失效' : ''}</span>
            <small className="worktree-path" title={item.workingPath}>{item.workingPath}</small>
            <small>{item.main ? '项目默认目录' : (item.sessionCount ?? 0) + ' 个关联会话'}</small>
          </button>
          <div className="worktree-actions">
            <button type="button" className="subtle" onClick={() => onNewSession(item.main ? null : item.workingPath)}>新建终端</button>
            {!item.main && <button type="button" className="text-button danger-text" disabled={item.locked || item.prunable} title={item.locked ? '请先解除 Worktree 锁定' : item.prunable ? '请先清理失效的 Worktree 元数据' : '移除 Worktree'} onClick={() => void remove(item)}>删除</button>}
          </div>
        </div>;
      })}
    </div>}
    {actionError && <p className="form-error" role="alert">{actionError}</p>}
    {enabled && data.worktrees.length > 0 && <button type="button" className="subtle worktree-add" disabled={creating} onClick={() => setCreating(true)}>＋ 新建 Worktree</button>}
    {creating && <WorktreeCreateDialog status={data.status} worktrees={data.worktrees} error={actionError || data.error} onFetch={data.fetchRemote} disabled={!enabled || data.loading} onCreate={create} onCancel={() => setCreating(false)} onCreated={() => setCreating(false)} />}
  </section>;
}

export function WorktreePicker({
  project, enabled, value, onChange, disabled = false,
}: {
  project: Project;
  enabled: boolean;
  value: string | null;
  onChange: (path: string | null) => void;
  disabled?: boolean;
}) {
  const data = useWorktrees(project, enabled, true);
  const [creating, setCreating] = useState(false);
  const [actionError, setActionError] = useState('');
  const main = data.worktrees.find(item => item.main);
  useEffect(() => {
    if (!data.loading && value && data.worktrees.length && !data.worktrees.some(item => !item.main && item.workingPath === value)) onChange(null);
  }, [data.loading, data.worktrees, value, onChange]);

  async function create(branch: string, createBranch: boolean, baseRef?: string) {
    setActionError('');
    try {
      const item = await data.create(branch, createBranch, baseRef);
      onChange(item.main ? null : item.workingPath);
      return item;
    } catch (reason) {
      const message = String(reason).replace(/^Error: /, '');
      setActionError(message);
      return null;
    }
  }

  return <section className="worktree-picker" aria-label="会话工作区">
    <label>Git 工作区
      <select aria-label="Git 工作区" value={value ?? ''} disabled={disabled || !enabled || data.loading} onChange={event => onChange(event.target.value || null)}>
        <option value="">主工作区{main?.branch ? ' · ' + main.branch : ''}</option>
        {data.worktrees.filter(item => !item.main).map(item => <option key={item.path} value={item.workingPath}>{item.branch ?? '游离 HEAD'} · {item.workingPath}</option>)}
      </select>
    </label>
    {!enabled && <p className="form-hint">更新后台至 API 43 后可选择 Worktree。</p>}
    {data.error && <p className="form-hint">{data.error}；当前使用主工作区。</p>}
    {actionError && <p className="form-error" role="alert">{actionError}</p>}
    {enabled && data.worktrees.length > 0 && <button type="button" className="subtle" disabled={disabled || creating} onClick={() => setCreating(true)}>新建 Worktree…</button>}
    {creating && <WorktreeCreateDialog status={data.status} worktrees={data.worktrees} error={actionError || data.error} onFetch={data.fetchRemote} disabled={disabled || data.loading} onCreate={create} onCancel={() => setCreating(false)} onCreated={() => setCreating(false)} />}
  </section>;
}
