import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import type { GitStatus, GitWorktree, Project } from '../shared/protocol';

function useWorktrees(project: Project, enabled: boolean, visible: boolean) {
  const [worktrees, setWorktrees] = useState<GitWorktree[]>([]);
  const [branches, setBranches] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const alive = useRef(true);
  const generation = useRef(0);

  const refresh = useCallback(async () => {
    if (!enabled || !visible) return;
    const token = ++generation.current;
    setLoading(true);
    try {
      const items = await window.berth.rpc<GitWorktree[]>('gitWorktrees', { projectId: project.id });
      let names: string[] = [];
      try {
        const status = await window.berth.rpc<GitStatus>('gitStatus', { projectId: project.id });
        if (status.kind === 'repository') names = status.branches;
      } catch { /* The worktree list remains useful if branch metadata is temporarily unavailable. */ }
      if (alive.current && generation.current === token) {
        setWorktrees(items);
        setBranches(names);
        setError('');
      }
    } catch (reason) {
      if (alive.current && generation.current === token) {
        setWorktrees([]);
        setBranches([]);
        setError(String(reason).replace(/^Error: /, ''));
      }
    } finally {
      if (alive.current && generation.current === token) setLoading(false);
    }
  }, [project.id, enabled, visible]);

  useEffect(() => {
    alive.current = true;
    if (enabled && visible) void refresh();
    const update = () => { if (visible) void refresh(); };
    window.addEventListener('berth:git-refresh', update);
    return () => {
      generation.current++;
      window.removeEventListener('berth:git-refresh', update);
    };
  }, [refresh, enabled, visible]);

  useEffect(() => () => { alive.current = false; generation.current++; }, []);

  const create = useCallback(async (branch: string, createBranch: boolean, baseRef?: string) => {
    const item = await window.berth.rpc<GitWorktree>('gitCreateWorktree', {
      projectId: project.id, branch, createBranch, ...(baseRef ? { baseRef } : {}),
    });
    window.dispatchEvent(new Event('berth:git-refresh'));
    await refresh();
    return item;
  }, [project.id, refresh]);

  const remove = useCallback(async (item: GitWorktree, deleteSessions: boolean) => {
    await window.berth.rpc('gitRemoveWorktree', { projectId: project.id, path: item.path, deleteSessions });
    window.dispatchEvent(new Event('berth:git-refresh'));
    await refresh();
  }, [project.id, refresh]);

  return { worktrees, branches, loading, error, refresh, create, remove };
}

function WorktreeCreateForm({
  branches, worktrees, disabled, onCreate, onCancel, onCreated,
}: {
  branches: string[];
  worktrees: GitWorktree[];
  disabled: boolean;
  onCreate: (branch: string, createBranch: boolean, baseRef?: string) => Promise<GitWorktree | null>;
  onCancel: () => void;
  onCreated: (item: GitWorktree) => void;
}) {
  const [mode, setMode] = useState<'new' | 'existing'>('new');
  const [branch, setBranch] = useState('');
  const [baseRef, setBaseRef] = useState('');
  const [busy, setBusy] = useState(false);
  const checkedOut = new Set(worktrees.map(item => item.branch).filter((value): value is string => !!value));
  const available = branches.filter(name => !checkedOut.has(name));
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!branch.trim()) return;
    setBusy(true);
    try {
      const item = await onCreate(branch.trim(), mode === 'new', mode === 'new' ? baseRef || undefined : undefined);
      if (item) onCreated(item);
    } finally { setBusy(false); }
  }
  return <form className="worktree-create-form" onSubmit={event => void submit(event)}>
    <label>分支来源
      <select value={mode} disabled={disabled || busy} onChange={event => { setMode(event.target.value as 'new' | 'existing'); setBranch(''); }}>
        <option value="new">创建新分支</option>
        <option value="existing">使用已有本地分支</option>
      </select>
    </label>
    {mode === 'new' ? <>
      <label>新分支名称
        <input autoFocus value={branch} maxLength={255} placeholder="feature/my-task" disabled={disabled || busy} onChange={event => setBranch(event.target.value)} />
      </label>
      <label>起始分支（可选）
        <select value={baseRef} disabled={disabled || busy} onChange={event => setBaseRef(event.target.value)}>
          <option value="">当前 HEAD</option>
          {branches.map(name => <option key={name} value={name}>{name}</option>)}
        </select>
      </label>
    </> : <label>选择本地分支
      <select autoFocus value={branch} disabled={disabled || busy || !available.length} onChange={event => setBranch(event.target.value)}>
        <option value="">{available.length ? '选择尚未被 Worktree 使用的分支' : '没有可用分支'}</option>
        {available.map(name => <option key={name} value={name}>{name}</option>)}
      </select>
    </label>}
    <footer>
      <button type="button" className="subtle" disabled={busy} onClick={onCancel}>取消</button>
      <button className="primary" disabled={disabled || busy || !branch.trim()}>创建 Worktree</button>
    </footer>
  </form>;
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
    if (deleteSessions && !window.confirm('此 Worktree 关联了 ' + count + ' 个会话。删除 Worktree 时也会删除这些会话及运行记录，磁盘上的其他文件不会保留。确定继续吗？')) return;
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
    {enabled && data.worktrees.length > 0 && !creating && <button type="button" className="subtle worktree-add" onClick={() => setCreating(true)}>＋ 新建 Worktree</button>}
    {creating && <WorktreeCreateForm branches={data.branches} worktrees={data.worktrees} disabled={!enabled || data.loading} onCreate={create} onCancel={() => setCreating(false)} onCreated={() => setCreating(false)} />}
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
      <select value={value ?? ''} disabled={disabled || !enabled || data.loading} onChange={event => onChange(event.target.value || null)}>
        <option value="">主工作区{main?.branch ? ' · ' + main.branch : ''}</option>
        {data.worktrees.filter(item => !item.main).map(item => <option key={item.path} value={item.workingPath}>{item.branch ?? '游离 HEAD'} · {item.workingPath}</option>)}
      </select>
    </label>
    {!enabled && <p className="form-hint">更新后台至 API 43 后可选择 Worktree。</p>}
    {data.error && <p className="form-hint">{data.error}；当前使用主工作区。</p>}
    {actionError && <p className="form-error" role="alert">{actionError}</p>}
    {enabled && data.worktrees.length > 0 && !creating && <button type="button" className="subtle" disabled={disabled} onClick={() => setCreating(true)}>新建 Worktree…</button>}
    {creating && <WorktreeCreateForm branches={data.branches} worktrees={data.worktrees} disabled={disabled || data.loading} onCreate={create} onCancel={() => setCreating(false)} onCreated={() => setCreating(false)} />}
  </section>;
}
