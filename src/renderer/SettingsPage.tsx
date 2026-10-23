import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { DEFAULT_SETTINGS, TERMINAL_LIMIT_MAX, type Settings, type AgentDefinition, type AgentDefinitionConfig } from '../shared/protocol';
import { agentLabels } from './labels';
import { AgentManager } from './AgentManager';
import { TerminalFields } from './TerminalFields';
import { AppearanceControls } from './AppearanceControls';
import { PreviewSettings } from './PreviewSettings';
import { McpSettings } from './RemoteTerminal';
import { AboutCard } from './AboutCard';
import { SshConnections } from './SshConnections';
import { filterSettings, settingsCatalog, settingsCategories, type SettingsCategory, type SettingsEntry } from './settings-catalog';
import { readStored, saveStored } from './storage';

export function SettingsPage({ connected, apiVersion, agents, usedAgents, onSaveAgent, onDeleteAgent, settings, draft, onChange, onDiscard, conflict, onError, error, platform, disabled, busy, restartDisabled, onSave, onRestart, running }: {
  connected: boolean; apiVersion: number; agents: AgentDefinition[]; usedAgents: string[]; onSaveAgent: (value: AgentDefinitionConfig, id?: string) => Promise<AgentDefinition | undefined>; onDeleteAgent: (id: string) => Promise<unknown>;
  settings: Settings; draft: Settings; onChange: (value: Settings) => void; onDiscard: () => void; conflict: boolean; onError: (error: string) => void; error: string;
  platform: string; disabled: boolean; busy: boolean; restartDisabled: boolean; onSave: (value: Settings) => Promise<boolean>; onRestart: () => void; running: number;
}) {
  const [saved, setSaved] = useState(false), [query, setQuery] = useState('');
  const [category, setCategory] = useState<SettingsCategory>(() => settingsCategories.find(item => item.id === readStored('berth.settingsCategory'))?.id ?? 'common');
  const search = useRef<HTMLInputElement>(null), content = useRef<HTMLDivElement>(null), form = useRef<HTMLFormElement>(null);
  const entries = useMemo(() => settingsCatalog(agents, apiVersion), [agents, apiVersion]);
  const visible = useMemo(() => new Set(filterSettings(entries, query, category).map(entry => entry.id)), [entries, query, category]);
  const categories = settingsCategories.filter(value => value.id === 'all' || value.id === 'common' || entries.some(entry => entry.category === value.id));
  const dirty = JSON.stringify(draft) !== JSON.stringify(settings);
  const modified = (entry: SettingsEntry) => entry.field && (JSON.stringify(draft[entry.field]) !== JSON.stringify(settings[entry.field]) || entry.id === 'default-agent' && draft.defaultCommand !== settings.defaultCommand);
  const pending = entries.filter(modified).length;
  const change = (value: Settings) => { onChange(value); setSaved(false); };
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
    const field = entry.field, canReset = field && (JSON.stringify(draft[field]) !== JSON.stringify(DEFAULT_SETTINGS[field]) || id === 'default-agent' && !!draft.defaultCommand);
    return <div key={id} className={`settings-entry${modified(entry) ? ' is-dirty' : ''}`} data-setting-id={id} hidden={!visible.has(id)}>
      <div className="settings-entry-meta"><span>{settingsCategories.find(value => value.id === entry.category)?.label}</span><span className="settings-effect">{field ? modified(entry) ? '未保存' : '保存后应用' : ['theme', 'preview'].includes(id) ? '自动保存' : '管理'}</span>{canReset && <button type="button" className="text-button setting-reset" aria-label={`重置${entry.title}`} disabled={disabled} onClick={() => change({ ...draft, [field]: structuredClone(DEFAULT_SETTINGS[field]), ...(id === 'default-agent' ? { defaultCommand: '' } : {}) })}>重置</button>}</div>
      {children}
    </div>;
  };
  return <section className="settings-page settings-workbench" aria-label="应用设置">
    <header className="settings-toolbar"><div className="settings-title"><h1>设置</h1><span>应用于整个工作台</span></div>
      <div className="settings-search"><svg aria-hidden="true" viewBox="0 0 20 20" width="17" height="17" fill="none" stroke="currentColor" strokeWidth="1.5"><circle cx="8.5" cy="8.5" r="5.5"/><path d="m13 13 4 4"/></svg><input ref={search} aria-label="搜索设置" placeholder="搜索设置，例如：字体、终端、SSH…" value={query} onChange={event => { setQuery(event.target.value); setCategory('all'); content.current?.scrollTo(0, 0); }} onKeyDown={event => { if (event.key === 'Escape' && query) { event.preventDefault(); event.stopPropagation(); setQuery(''); } }} />{query ? <button className="icon-button" aria-label="清除设置搜索" onClick={() => { setQuery(''); search.current?.focus(); }}>×</button> : <kbd>Ctrl+F</kbd>}</div>
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
        {!connected && <p className="settings-notice" role="status">后台未连接。外观、预览和开发指南仍可使用；连接后可保存启动设置。</p>}
        {conflict && <p className="draft-notice" role="status">后台设置已更新，草稿已保留。保存将应用此处的值；取消修改可加载后台设置。</p>}
        {error && <div className="form-error" role="alert">{error.replace(/^Error: /, '')}</div>}
        {!visible.size && <div className="settings-no-results"><h3>没有匹配的设置</h3><p>试试“终端”“字体”或“SSH”，也可以查看全部设置。</p><button type="button" className="subtle" onClick={() => { setQuery(''); setCategory('all'); search.current?.focus(); }}>查看全部设置</button></div>}
        {item('theme', <AppearanceControls />)}
        {item('preview', <PreviewSettings />)}
        <form id="workspace-settings-form" className="settings-values" ref={form} noValidate onSubmit={async event => {
          event.preventDefault();
          const invalid = Array.from(form.current?.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>('input,select,textarea') ?? []).find(element => !element.disabled && !element.checkValidity());
          if (invalid) {
            const entry = entries.find(value => value.id === invalid.closest<HTMLElement>('[data-setting-id]')?.dataset.settingId);
            setQuery(''); setCategory(entry?.category ?? 'common'); requestAnimationFrame(() => { invalid.focus(); invalid.reportValidity(); }); return;
          }
          if (await onSave(draft)) setSaved(true);
        }}>
          {item('shell', <><TerminalFields value={draft.terminal} platform={platform} disabled={disabled} onError={onError} onChange={terminal => change({ ...draft, terminal: terminal! })} /><p className="form-hint">用于下一次启动，运行中的终端保持不变。单个会话可覆盖默认终端。</p></>)}
          {item('terminal-font', <><label>终端字号<input aria-label="终端字号" type="number" min={10} max={24} required value={draft.fontSize} disabled={disabled} onChange={event => change({ ...draft, fontSize: Number(event.target.value) })} /></label><p className="form-hint">10–24 px。文件预览的字体和字号独立设置。</p></>)}
          {item('local-limit', <><label>本机终端上限<input aria-label="本机终端上限" type="number" min={1} max={TERMINAL_LIMIT_MAX} required value={draft.maxActiveTerminals} disabled={disabled} onChange={event => change({ ...draft, maxActiveTerminals: Number(event.target.value) })} /></label><p className="form-hint">启动中和运行中均占名额；降低上限不会停止已有终端。</p></>)}
          {item('default-agent', <><label>默认 Agent<select aria-label="默认 Agent" value={draft.defaultAgent} disabled={disabled} onChange={event => change({ ...draft, defaultAgent: event.target.value as Settings['defaultAgent'] })}>{Object.entries(agentLabels(agents)).map(([value, name]) => <option key={value} value={value}>{name}</option>)}</select></label><p className="form-hint">用于新建会话。自定义类型的启动命令由导入文件提供。</p>{draft.defaultAgent === 'custom' && <><label>默认启动命令<input aria-label="默认启动命令" required pattern=".*\S.*" title="请填写至少一个非空白字符" maxLength={4096} value={draft.defaultCommand} disabled={disabled} onChange={event => change({ ...draft, defaultCommand: event.target.value })} placeholder="例如 my-agent --interactive" /></label><p className="form-hint">新建自定义命令会话时自动填入，仍可按会话单独修改。</p></>}</>)}
          {item('ssh-limit', <><label>SSH 会话上限<input aria-label="SSH 会话上限" type="number" min={1} max={TERMINAL_LIMIT_MAX} required value={draft.maxSshTerminals} disabled={disabled} onChange={event => change({ ...draft, maxSshTerminals: Number(event.target.value) })} /></label><p className="form-hint">与本机终端独立计数，支持 1–{TERMINAL_LIMIT_MAX}。保存立即应用，降低上限不停止已有会话。</p></>)}
        </form>
        {item('agent-types', <AgentManager hotUpdates={apiVersion >= 15} agents={agents} used={usedAgents} defaultAgent={settings.defaultAgent} disabled={disabled} busy={busy} error={error} onError={onError} onSave={onSaveAgent} onDelete={onDeleteAgent} />)}
        {item('connections', <SshConnections disabled={!connected || busy} onError={onError} />)}
        {item('mcp', <McpSettings disabled={!connected} onError={onError} />)}
        {item('backend', <section className="settings-card backend-card"><h2>后台服务</h2><p>{running ? `${running} 个终端正在后台运行。先停止全部终端，再更新后台。` : '安装新版本后，可更新后台以加载新功能。项目、会话和设置会保留。'}</p><button className="subtle" disabled={restartDisabled || running > 0} onClick={onRestart}>更新后台</button></section>)}
        {item('about', <AboutCard connected={connected} apiVersion={apiVersion} running={running} onError={onError} />)}
      </div>
    </div>
    <footer className="settings-savebar"><div><strong role="status">{saved && !dirty ? '设置已保存' : dirty ? `${pending} 项启动或资源设置未保存` : '启动与资源设置'}</strong><small>{dirty ? '草稿已保留，切换分类不会丢失。' : '外观和文件预览自动保存，其他操作在各分类内完成。'}</small></div><div className="settings-save-actions">{dirty && <button type="button" className="subtle" disabled={disabled} onClick={() => { onDiscard(); setSaved(false); }}>取消修改</button>}<button type="button" className="subtle" disabled={disabled} title="恢复终端、默认 Agent 及会话上限；保存后应用" onClick={() => change(structuredClone(DEFAULT_SETTINGS))}>恢复默认值</button><button form="workspace-settings-form" className="primary" disabled={disabled || !dirty}>{busy ? '正在保存…' : '保存设置'}</button></div></footer>
  </section>;
}
