import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { DEFAULT_SETTINGS, TERMINAL_LIMIT_MAX, type Settings, type AgentDefinition } from '../shared/protocol';
import { TerminalFields } from './TerminalFields';
import { AboutCard } from './AboutCard';
import { AppearanceControls } from './AppearanceControls';
import { PreviewSettings } from './PreviewSettings';
import { SkillManager } from './SkillManager';
import { SshConnections } from './SshConnections';
import { McpSettings } from './RemoteTerminal';
import { filterSettings, settingsCatalog, settingsCategories, type SettingsCategory, type SettingsEntry } from './settings-catalog';
import { readStored, saveStored } from './storage';

export function SettingsPage({ projects, currentProjectId, connected, apiVersion, agents, settings, draft, onChange, onDiscard, conflict, onError, error, platform, disabled, busy, restartDisabled, onSave, onRestart, running }: {
  projects: import('../shared/protocol').Project[]; currentProjectId?: string;
  connected: boolean; apiVersion: number; agents: AgentDefinition[];
  settings: Settings; draft: Settings; onChange: (value: Settings) => void; onDiscard: () => void; conflict: boolean; onError: (error: string) => void; error: string;
  platform: string; disabled: boolean; busy: boolean; restartDisabled: boolean; onSave: (value: Settings) => Promise<boolean>; onRestart: () => void; running: number;
}) {
  const [saveState,setSaveState]=useState<'idle'|'pending'|'success'|'error'>('idle');
  const [saved, setSaved] = useState(false), [query, setQuery] = useState('');
  const [category, setCategory] = useState<SettingsCategory>(() => settingsCategories.find(item => item.id === readStored('berth.settingsCategory'))?.id ?? 'common');
  const search = useRef<HTMLInputElement>(null), content = useRef<HTMLDivElement>(null), form = useRef<HTMLFormElement>(null);
  const entries = useMemo(() => settingsCatalog(agents, apiVersion), [agents, apiVersion]);
  const visible = useMemo(() => new Set(filterSettings(entries, query, category).map(entry => entry.id)), [entries, query, category]);
  const categories = settingsCategories.filter(value => value.id === 'all' || value.id === 'common' || entries.some(entry => entry.category === value.id));
  const dirty = JSON.stringify(draft) !== JSON.stringify(settings);
  const modified = (entry: SettingsEntry) => entry.field && JSON.stringify(draft[entry.field]) !== JSON.stringify(settings[entry.field]);
  const pending = entries.filter(modified).length;
  const change = (value: Settings) => { onChange(value); setSaved(false);setSaveState('idle'); };
  useEffect(() => { saveStored('berth.settingsCategory', category); content.current?.scrollTo(0, 0); }, [category]);
  useEffect(() => { if (!categories.some(item => item.id === category)) setCategory('common'); }, [category, apiVersion]);
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (document.querySelector('[role="dialog"]')) return;
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'f') { event.preventDefault(); search.current?.focus(); search.current?.select(); }
    };
    document.addEventListener('keydown', key);
    return () => document.removeEventListener('keydown', key);
  }, []);
  const show = (value: SettingsCategory) => { setCategory(value); };
  const item = (id: string, children: ReactNode) => {
    const entry = entries.find(value => value.id === id);
    if (!entry) return null;
    const field = entry.field, canReset = field && JSON.stringify(draft[field]) !== JSON.stringify(DEFAULT_SETTINGS[field]);
    return <div key={id} className={`settings-entry${modified(entry) ? ' is-dirty' : ''}`} data-setting-id={id} hidden={!visible.has(id)}>
      <div className="settings-entry-meta"><span>{settingsCategories.find(value => value.id === entry.category)?.label}</span><span className="settings-effect">{field ? modified(entry) ? '未保存' : '保存后应用' : id==='appearance'||id==='preview'?'立即生效':'管理'}</span>{canReset && <button type="button" className="text-button setting-reset" aria-label={`重置${entry.title}`} disabled={disabled} onClick={() => change({ ...draft, [field]: structuredClone(DEFAULT_SETTINGS[field]) })}>重置</button>}</div>
      {children}
    </div>;
  };
  const activeAgents=agents.filter(agent=>agent.id!=='custom');
  return <section className="settings-page settings-workbench" aria-label="应用设置">
    <header className="settings-toolbar"><div className="settings-title"><h1>核心设置</h1><span>终端、外观与资源设置</span></div>
      <div className="settings-search"><svg aria-hidden="true" viewBox="0 0 20 20" width="17" height="17" fill="none" stroke="currentColor" strokeWidth="1.5"><circle cx="8.5" cy="8.5" r="5.5"/><path d="m13 13 4 4"/></svg><input ref={search} aria-label="搜索设置" placeholder="搜索主题、Agent、SSH、终端、文件预览…" value={query} onChange={event => { setQuery(event.target.value); setCategory('all'); content.current?.scrollTo(0, 0); }} onKeyDown={event => { if (event.key === 'Escape' && query) { event.preventDefault(); event.stopPropagation(); setQuery(''); } }} />{query ? <button className="icon-button" aria-label="清除设置搜索" onClick={() => { setQuery(''); search.current?.focus(); }}>×</button> : <kbd>Ctrl+F</kbd>}</div>
    </header>
    <div className="settings-layout">
      <nav className="settings-nav" aria-label="设置分类">{categories.map(value => {
        const count = filterSettings(entries, query, value.id).length;
        return <button key={value.id} type="button" aria-label={value.label} aria-current={category === value.id ? 'page' : undefined} className={category === value.id ? 'selected' : ''} onClick={() => show(value.id)} onKeyDown={event => {
          if (!['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return;
          event.preventDefault(); const index = categories.indexOf(value), next = event.key === 'Home' ? 0 : event.key === 'End' ? categories.length - 1 : (index + (event.key === 'ArrowUp' ? categories.length - 1 : 1)) % categories.length;
          show(categories[next].id); event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>('button')[next]?.focus();
        }}><span>{value.label}</span><small aria-hidden="true">{count}</small></button>;
      })}</nav>
      <div className="settings-results" ref={content}>
        <div className="settings-result-heading"><h2>{query ? `搜索结果${category !== 'all' ? ' · ' + settingsCategories.find(value => value.id === category)?.label : ''}` : settingsCategories.find(value => value.id === category)?.label}</h2><span role="status">{visible.size} 项</span></div>
        {!connected && <p className="settings-notice" role="status">后台未连接，连接成功后才能保存终端、Agent 和 SSH 设置。</p>}
        {conflict && <p className="draft-notice" role="status">后台设置已更新，草稿已保留。保存将应用此处的值；取消修改可加载后台设置。</p>}
        {error && <div className="form-error" role="alert">{error.replace(/^Error: /, '')}</div>}
        {!visible.size && <div className="settings-no-results"><h3>没有匹配的设置</h3><p>试试“主题”“Agent”“SSH”“终端”或“文件预览”。</p><button type="button" className="subtle" onClick={() => { setQuery(''); setCategory('all'); search.current?.focus(); }}>查看全部设置</button></div>}
        <form id="workspace-settings-form" className="settings-values" ref={form} noValidate onSubmit={async event => {
          event.preventDefault();
          const invalid = Array.from(form.current?.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>('input,select,textarea') ?? []).find(element => !element.disabled && !element.checkValidity());
          if (invalid) {
            setSaveState('error');
            const entry = entries.find(value => value.id === invalid.closest<HTMLElement>('[data-setting-id]')?.dataset.settingId);
            setQuery(''); setCategory(entry?.category ?? 'common'); requestAnimationFrame(() => { invalid.focus(); invalid.reportValidity(); }); return;
          }
          setSaveState('pending');try{if(await onSave(draft)){setSaved(true);setSaveState('success');}else setSaveState('error');}catch(reason){setSaveState('error');onError(String(reason));}
        }}>
          {item('appearance', <AppearanceControls />)}
          {item('ui-font', <><label>界面字号<select aria-label="界面字号" value={String(draft.uiFontScale ?? 1)} disabled={disabled || apiVersion < 55} onChange={event=>change({...draft,uiFontScale:Number(event.target.value)})}>
            <option value="0.85">小 · 85%</option><option value="0.925">较小 · 92%</option><option value="1">标准</option><option value="1.075">较大 · 108%</option><option value="1.15">大 · 115%</option><option value="1.25">特大 · 125%</option>
          </select></label><p className="form-hint">{apiVersion < 55 ? '界面字号需要更新后台后才能调整；当前后台不支持该设置。' : '整体缩放界面文字，保存后应用；终端字号与文件预览字号独立设置。'}</p></>)}
          {item('default-agent', <><label>默认 Agent<select aria-label="默认 Agent" value={draft.defaultAgent} disabled={disabled} onChange={event=>change({...draft,defaultAgent:event.target.value as Settings['defaultAgent']})}>
            {!activeAgents.some(agent=>agent.id===draft.defaultAgent)&&draft.defaultAgent!=='shell'&&<option value={draft.defaultAgent}>已停用的 Agent（保留原设置）</option>}
            <option value="shell">普通终端</option>{activeAgents.map(agent=><option key={agent.id} value={agent.id}>{agent.name}</option>)}
          </select></label><p className="form-hint">Agent 接入能力由工作台提供；Codex、Claude Code、OpenCode 和自定义 Agent 各自通过插件接入。</p></>)}
          {item('skills', <SkillManager agents={agents} projects={projects} currentProjectId={currentProjectId} />)}
          {item('preview', <PreviewSettings />)}
          {item('ssh-limit', <><label>SSH 会话上限<input aria-label="SSH 会话上限" type="number" min={1} max={TERMINAL_LIMIT_MAX} required value={draft.maxSshTerminals} disabled={disabled} onChange={event=>change({...draft,maxSshTerminals:Number(event.target.value)})}/></label><p className="form-hint">与本机终端独立计数；降低上限不会停止已有 SSH 会话。</p></>)}
          {item('connections', <SshConnections disabled={!connected} onError={onError} />)}
          {item('mcp', <McpSettings disabled={!connected} metricsSupported={apiVersion>=33} onError={onError} />)}
          {item('shell', <><TerminalFields value={draft.terminal} platform={platform} disabled={disabled} onError={onError} onChange={terminal => change({ ...draft, terminal: terminal! })} /><p className="form-hint">用于下一次启动，运行中的终端保持不变。单个会话可覆盖默认终端。</p></>)}
          {item('terminal-font', <><label>终端字号<input aria-label="终端字号" type="number" min={10} max={24} required value={draft.fontSize} disabled={disabled} onChange={event => change({ ...draft, fontSize: Number(event.target.value) })} /></label><p className="form-hint">10–24 px。文件预览的字体和字号独立设置。</p></>)}
          {item('local-limit', <><label>本机终端上限<input aria-label="本机终端上限" type="number" min={1} max={TERMINAL_LIMIT_MAX} required value={draft.maxActiveTerminals} disabled={disabled} onChange={event => change({ ...draft, maxActiveTerminals: Number(event.target.value) })} /></label><p className="form-hint">启动中和运行中均占名额；降低上限不会停止已有终端。</p></>)}
        </form>
        {item('backend', <section className="settings-card backend-card"><h2>后台服务</h2><p>{running ? `${running} 个终端正在后台运行。先停止全部终端，再重启后台。` : '重启当前版本后台服务。不会迁移旧版数据，旧版安装必须先清理数据目录。'}</p><button className="subtle" disabled={restartDisabled || running > 0} onClick={onRestart}>重启后台</button></section>)}
        {item('about', <AboutCard connected={connected} apiVersion={apiVersion} running={running} onError={onError} />)}
      </div>
    </div>
    <footer className="settings-savebar"><div><strong role="status">{saved && !dirty ? '设置已保存' : dirty ? `${pending} 项启动或资源设置未保存` : '设置已同步'}</strong><small>{dirty ? '草稿已保留，切换分类不会丢失。' : '修改后保存以应用设置。'}</small></div><div className="settings-save-actions">{dirty && <button type="button" className="subtle" disabled={disabled} onClick={() => { onDiscard(); setSaved(false);setSaveState('idle'); }}>取消修改</button>}<button type="button" className="subtle" disabled={disabled || JSON.stringify(draft)===JSON.stringify(DEFAULT_SETTINGS)} title="恢复默认终端、Agent 及会话上限；保存后应用" onClick={() => change(structuredClone(DEFAULT_SETTINGS))}>恢复默认值</button><button form="workspace-settings-form" className="primary" aria-busy={saveState==='pending'} data-feedback={saveState} disabled={disabled || !dirty}>保存设置</button></div></footer>
  </section>;
}
