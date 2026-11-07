import { useRef, useState, type FormEvent } from 'react';
import { Dialog } from './Dialog';
import { RemoteFields } from './RemoteTerminal';
import { TerminalFields } from './TerminalFields';
import { WorktreePicker } from './WorktreeManager';
import { extensionEnabled } from '../shared/extensions';
import { isCustomAgent, type Agent, type DeletionUndo, type Method, type Project, type Session, type State } from '../shared/protocol';
import { modalFormInitial, modalFormValue, type ModalRequest, type ProjectFormValues, type SessionFormValues } from './modal-form';

const active = (session: Session) => ['running', 'stopping'].includes(session.latestRun?.status ?? '');

export interface ModalLayerProps {
  request: ModalRequest;
  state: State;
  agentNames: Record<string, string>;
  features: { agents: boolean };
  actionProject?: Project;
  actionSession?: Session;
  actionProjectSessions: Session[];
  session?: Session;
  busy: boolean;
  error: string;
  connected: boolean;
  running: number;
  returnFocus: HTMLElement | null;
  perform: <T>(method: Method, params: Record<string, unknown>, scope?: string) => Promise<T | undefined>;
  onError: (message: string) => void;
  onClose: () => void;
  onSubmitProject: (values: ProjectFormValues) => void;
  onSubmitSession: (values: SessionFormValues) => void;
  onSubmitRename: (kind: 'renameSession' | 'renameProject', value: string) => void;
  onSubmitLink: (value: string) => void;
  onDeleted: (undo: DeletionUndo | null, label: string) => void;
  onRestart: () => void;
}

// The form lives here, not in App: typing in a dialog no longer reconciles the
// whole workbench. App mounts this with key=request.token, so every open gets a
// fresh form and a fresh initial snapshot without an effect or a reset race.
export function ModalLayer(props: ModalLayerProps) {
  const { request, state, agentNames, features, actionProject, actionSession, actionProjectSessions, session, busy, error, connected, running, returnFocus, perform, onError, onClose } = props;
  const kind = request.kind;
  const [values, setValues] = useState(() => modalFormInitial(kind, request.initial));
  const patch = (next: Partial<typeof values>) => setValues(previous => ({ ...previous, ...next }));
  const { name, folder, title, agent, command, terminal, startNow, remote, worktreePath, service, nativeId } = values;
  const currentForm = modalFormValue(kind, values);
  const initialForm = useRef(currentForm);
  const dirtyForm = !!currentForm && currentForm !== initialForm.current;
  const cancelButton = <button type="button" data-dismiss="dialog" className="subtle" disabled={busy} onClick={onClose}>取消</button>;
  const common = { dirty: dirtyForm, error, returnFocus, busy, onClose };

  async function selectFolder() {
    try {
      const value = await window.berth.chooseDirectory();
      if (value) patch({ folder: value, ...(name ? {} : { name: value.split(/[\\/]/).filter(Boolean).at(-1) ?? '项目' }) });
    } catch (reason) { onError(String(reason)); }
  }
  const submit = (event: FormEvent, run: () => void) => { event.preventDefault(); run(); };
  const sessionValues = (): SessionFormValues => ({ title, agent, command, terminal, startNow, remote, worktreePath, service });

  if (kind === 'renameSession' || kind === 'renameProject') return <Dialog {...common} title={kind === 'renameSession' ? '重命名会话' : '重命名项目'}><form onSubmit={event => submit(event, () => props.onSubmitRename(kind, kind === 'renameSession' ? title : name))}><label>{kind === 'renameSession' ? '会话名称' : '项目名称'}<input aria-label={kind === 'renameSession' ? '会话名称' : '项目名称'} autoFocus required maxLength={100} value={kind === 'renameSession' ? title : name} onChange={event => patch(kind === 'renameSession' ? { title: event.target.value } : { name: event.target.value })} /></label><footer>{cancelButton}<button className="primary" disabled={busy}>保存名称</button></footer></form></Dialog>;

  if (kind === 'project' || kind === 'editProject') return <Dialog {...common} title={kind === 'project' ? '添加项目目录' : '编辑项目'}><form onSubmit={event => submit(event, () => props.onSubmitProject({ name, folder }))}><label>项目名称（可选）<input aria-label="项目名称" autoFocus maxLength={100} value={name} onChange={event => patch({ name: event.target.value })} placeholder="留空按目录自动命名" /></label><label>项目目录<div className="input-with-button"><input aria-label="项目目录" required disabled={kind === 'editProject' && actionProjectSessions.some(active)} value={folder} onChange={event => patch({ folder: event.target.value })} placeholder={state.platform === 'win32' ? 'D:\\Projects\\my-project' : '/home/user/projects/my-project'} /><button type="button" className="subtle" disabled={kind === 'editProject' && actionProjectSessions.some(active)} onClick={() => void selectFolder()}>选择目录</button></div></label><p className="form-hint">{kind === 'editProject' ? '运行中的项目可以修改名称。修改目录前请停止全部终端；修改后会清除原生对话关联，避免从错误目录恢复。' : '会话从这个目录启动，同一路径自动去重。'}</p><footer>{cancelButton}<button className="primary" disabled={busy}>{busy ? '正在提交…' : kind === 'project' ? '添加项目' : '保存项目'}</button></footer></form></Dialog>;

  if (kind === 'session' || kind === 'editSession') return <Dialog {...common} title={kind === 'session' ? '新建项目会话' : '编辑会话'}><form onSubmit={event => submit(event, () => props.onSubmitSession(sessionValues()))}><label>会话名称（可选）<input aria-label="会话名称" autoFocus maxLength={100} value={title} onChange={event => patch({ title: event.target.value })} placeholder={`${agentNames[agent]} 会话（留空自动命名）`} /></label><label>Agent 类型<select aria-label="Agent 类型" disabled={kind === 'editSession' && !!actionSession && active(actionSession)} value={agent} onChange={event => { const value = event.target.value as Agent; patch({ agent: value, service: value === 'shell' ? service : false, command: value === 'custom' ? state.settings.defaultCommand : state.agents?.find(item => item.id === value)?.command ?? '' }); }}>{Object.entries(agentNames).filter(([value])=>value==='shell'||value!=='custom'&&features.agents&&(!['codex','claude','opencode'].includes(value)||extensionEnabled(state.extensions,'agent.'+value))).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>{agent !== 'shell' && <p className="form-hint">请确认本机已安装并配置 {agentNames[agent]}，且可从所选终端调用。首次使用可查看「设置 → 关于与支持 → 使用说明」。</p>}{actionProject && <WorktreePicker project={actionProject} enabled={connected && state.apiVersion >= 43} value={worktreePath} onChange={value => patch({ worktreePath: value })} disabled={kind === 'editSession' && !!actionSession && active(actionSession)} />}{agent==='shell'&&state.apiVersion>=51&&<label>终端模式<select aria-label="终端模式" value={service?'service':'interactive'} disabled={kind==='editSession'&&!!actionSession&&active(actionSession)} onChange={event=>patch({ service: event.target.value==='service' })}><option value="interactive">交互终端</option><option value="service">服务 · 只读输出</option></select></label>}{(isCustomAgent(agent)||agent==='shell'&&service) && !state.agents?.find(item=>item.id===agent)?.acp && <label>启动命令<input aria-label="启动命令" required maxLength={4096} disabled={kind === 'editSession' && !!actionSession && active(actionSession)} value={command} onChange={event => patch({ command: event.target.value })} placeholder={service?"例如 npm run dev":"你的 Agent TUI 启动命令"} /></label>}{!state.agents?.find(item=>item.id===agent)?.acp&&<details className="advanced-options" open={kind === 'editSession'}><summary>会话终端（默认跟随设置）</summary><TerminalFields value={terminal} onError={onError} platform={state.platform} inherit disabled={kind === 'editSession' && !!actionSession && active(actionSession)} onChange={value => patch({ terminal: value })} /></details>}<p className="form-hint">工作目录：{worktreePath ?? actionProject?.path}<br />{kind === 'editSession' ? '启动配置需在停止终端后修改；更换 Agent 会清除原生对话关联。' : 'Agent 使用本机已有安装和登录状态。'}{agent === 'opencode' && <><br />启动 opencode；关联会话后使用 opencode --session ID 恢复。</>}</p>{kind === 'session' && <label className="checkbox-label"><input type="checkbox" checked={startNow} onChange={event => patch({ startNow: event.target.checked })} />创建后立即启动</label>}<footer>{cancelButton}<button className="primary" disabled={busy}>{busy ? '正在提交…' : kind === 'editSession' ? '保存会话' : startNow ? '创建并启动' : '创建会话'}</button></footer></form></Dialog>;

  if (kind === 'sshSession' || kind === 'editSshSession') return remote ? <Dialog {...common} title={kind === 'sshSession' ? '新建 SSH 会话' : '编辑 SSH 会话'}>
    <form onSubmit={event => submit(event, () => props.onSubmitSession(sessionValues()))}>
      <label>会话名称（可选）<input aria-label="会话名称" autoFocus maxLength={100} value={title} onChange={event=>patch({ title: event.target.value })} placeholder="SSH 会话（留空自动命名）" /></label>
      <RemoteFields value={remote} disabled={kind === 'editSshSession' && !!actionSession && active(actionSession)} onError={onError} onChange={value => patch({ remote: value })} />
      {kind === 'editSshSession' && <p className="form-hint">停止此 SSH 终端后可修改连接与远端目录；本机 Agent 会话不受影响。</p>}
      {kind === 'sshSession' && <label className="checkbox-label"><input type="checkbox" checked={startNow} onChange={event=>patch({ startNow: event.target.checked })} />创建后立即启动</label>}
      <footer>{cancelButton}<button className="primary" disabled={busy}>{busy ? '正在提交…' : kind === 'editSshSession' ? '保存会话' : startNow ? '创建并启动' : '创建会话'}</button></footer>
    </form>
  </Dialog> : null;

  const remove = async (method: 'deleteSession' | 'deleteProject', params: Record<string, unknown>, label: string) => {
    // Older daemons return null: the delete still succeeds, there is simply no undo receipt.
    const result = await perform<DeletionUndo | null>(method, params);
    if (result === undefined) return;
    props.onDeleted(result, label); onClose();
  };

  if (kind === 'deleteSession') return <Dialog {...common} title="删除此会话？"><p className="stop-description">删除「{actionSession?.title}」及其运行记录、工作台日志和导入的对话副本。{state.apiVersion >= 53 ? '删除后可在提示条中点「撤销」恢复。' : '当前后台不支持撤销，删除后无法恢复。'}<br />项目文件和 Agent 原生记录会保留。</p><footer>{cancelButton}<button className="danger" disabled={busy} onClick={() => void remove('deleteSession', { sessionId: actionSession!.id }, actionSession?.title ?? '会话')}>确认删除会话</button></footer></Dialog>;

  if (kind === 'deleteProject') return <Dialog {...common} title="删除此项目？"><p className="stop-description">删除「{actionProject?.name}」的项目登记及全部 {actionProjectSessions.length} 个会话、运行记录和工作台日志。{state.apiVersion >= 53 ? '删除后可在提示条中点「撤销」恢复。' : '当前后台不支持撤销，删除后无法恢复。'}<br />磁盘上的项目目录和 Agent 原生记录会保留。</p><footer>{cancelButton}<button className="danger" disabled={busy} onClick={() => void remove('deleteProject', { projectId: actionProject!.id }, actionProject?.name ?? '项目')}>确认删除项目</button></footer></Dialog>;

  if (kind === 'stop') return <Dialog {...common} title="停止此终端？"><p className="stop-description">「{actionSession?.title}」{actionSession?.remote ? '将关闭 SSH 连接；远端任务可能继续运行，需在远端确认停止。' : '正在执行的任务会中断。'}<br />如需保留后台任务，可以收起终端或关闭窗口。</p><footer><button className="subtle" disabled={busy} onClick={onClose}>继续运行</button><button className="danger" disabled={busy} onClick={async () => { if (await perform('stop', { sessionId: actionSession!.id }) !== undefined) onClose(); }}>停止终端</button></footer></Dialog>;

  if (kind === 'link') return <Dialog {...common} title="关联原生会话 ID"><form onSubmit={event => submit(event, () => props.onSubmitLink(nativeId.trim()))}><label>原生会话 ID<input aria-label="原生会话 ID" autoFocus required maxLength={128} pattern="[a-zA-Z0-9_-]+" value={nativeId} onChange={event => patch({ nativeId: event.target.value })} /></label><p className="form-hint">请填写本机 {session ? agentNames[session.agent] : 'Agent'} 在此项目中已有的会话 ID。可在终端运行时关联，用于历史查看与下次恢复；不会切换当前 CLI。原有历史仍保留在列表中。</p><footer>{cancelButton}<button className="primary" disabled={busy}>保存关联</button></footer></form></Dialog>;

  return <Dialog {...common} title="重启后台服务？"><p className="stop-description">仅重启当前版本后台服务，不执行旧版本数据迁移。<br />所有终端都需要先停止。</p><footer>{cancelButton}<button className="primary" disabled={busy || running > 0 || !connected} onClick={() => props.onRestart()}>确认重启后台</button></footer></Dialog>;
}
