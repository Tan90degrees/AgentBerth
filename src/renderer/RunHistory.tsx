import { useRef, useState } from 'react';
import type { Run, WindowsPty } from '../shared/protocol';
import { Dialog } from './Dialog';
import { OutputView } from './TerminalView';
import { statusNames } from './labels';

const active = (run: Run) => ['running', 'stopping'].includes(run.status);
const date = (value: string) => new Date(value).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
export function RunHistory({ runs, outputRunId, output, windowsPty, fontSize, disabled, onView, onError, onDelete }: {
  runs: Run[]; outputRunId: string | null; output: string | null; windowsPty?: WindowsPty; fontSize: number; disabled: boolean;
  onView: (runId: string | null) => void; onError: (error: string) => void; onDelete: (runId?: string) => Promise<boolean>;
}) {
  const [target, setTarget] = useState<Run | 'all' | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const opener = useRef<HTMLElement | null>(null);
  function confirm(value: Run | 'all') { opener.current = document.activeElement as HTMLElement; setError(''); setTarget(value); }
  const current = runs.find(run => run.id === outputRunId);
  return <div className="runs-panel"><div className="panel-toolbar"><span>{outputRunId ? '本次运行输出 · 只读' : '每次启动都有独立记录'}</span><div>
    {outputRunId && <button className="text-button" onClick={() => onView(null)}>返回列表</button>}
    {outputRunId && current ? <button className="subtle danger-text" disabled={disabled || busy || active(current)} title={active(current) ? '请先停止终端' : '删除此记录及输出日志'} onClick={() => confirm(current)}>删除此记录</button> : !outputRunId && <button className="subtle danger-text" disabled={disabled || busy || !runs.some(run => !active(run))} onClick={() => confirm('all')}>清除已结束记录</button>}
  </div></div>{outputRunId && output === null ? <div className="empty-page"><div className="loader" /><p>正在读取本次输出</p></div> : outputRunId && output !== null ? <OutputView windowsPty={windowsPty} key={outputRunId} onError={onError} fontSize={fontSize} text={output || '保留范围内没有输出；较旧日志可能已清理。'} /> : <div className="runs-list">{runs.map(run => <div className="run-row" key={run.id}>
    <button className="run-item" onClick={() => onView(run.id)}><span><code>{run.id.slice(0, 8)}</code><small title={run.shell}>{run.command || '交互式 Shell'}{run.shell ? ` · ${run.shell.split(/[\\/]/).at(-1)}` : ''}</small></span><span>{date(run.startedAt)}</span><span className="badge">{statusNames[run.status]}</span><span>退出码 {run.exitCode ?? '—'}</span><span aria-hidden="true">→</span></button>
    <button className="subtle danger-text" aria-label={`删除运行记录 ${run.id.slice(0, 8)}`} title={active(run) ? '请先停止终端' : '删除此记录及输出日志'} disabled={disabled || busy || active(run)} onClick={() => confirm(run)}>删除</button>
  </div>)}{!runs.length && <div className="empty-page"><h2>尚无运行记录</h2><p>启动终端后，会在这里保留记录。</p></div>}</div>}
    {target && <Dialog title={target === 'all' ? '清除已结束的运行记录？' : '删除此运行记录？'} busy={busy} error={error} returnFocus={opener.current} onClose={() => setTarget(null)}><p className="stop-description">{target === 'all' ? '删除当前会话全部已结束的记录及其输出日志，正在运行的终端会保留。' : `删除运行 ${target.id.slice(0, 8)} 的记录及输出日志。`}此操作无法撤销。</p><footer><button className="subtle" data-dismiss="dialog" disabled={busy}>取消</button><button className="danger" disabled={disabled || busy} onClick={async () => {
      setBusy(true); setError('');
      try { if (await onDelete(target === 'all' ? undefined : target.id)) setTarget(null); else setError('删除未完成，请查看错误提示后重试'); }
      catch (reason) { setError(String(reason)); } finally { setBusy(false); }
    }}>{target === 'all' ? '确认清除记录' : '确认删除记录'}</button></footer></Dialog>}
  </div>;
}
