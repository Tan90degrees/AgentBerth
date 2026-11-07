import { useRef, useState } from 'react';
import { Dialog } from './Dialog';
import type { Run, WindowsPty } from '../shared/protocol';
import { OutputView } from './TerminalView';
import { statusNames } from './labels';

const active = (run: Run) => ['running', 'stopping'].includes(run.status);
const date = (value: string) => new Date(value).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
export function RunHistory({ runs, loading, error: loadError, outputError, onRetry, outputRunId, output, windowsPty, fontSize, disabled, undoSupported, onView, onError, onDelete }: {
  runs: Run[]; loading: boolean; error: string; outputError: string; onRetry: () => void; outputRunId: string | null; output: string | null; windowsPty?: WindowsPty; fontSize: number; disabled: boolean; undoSupported: boolean;
  onView: (runId: string | null) => void; onError: (error: string) => void; onDelete: (runId?: string) => Promise<boolean>;
}) {
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<{ runId?: string } | null>(null);
  const opener = useRef<HTMLElement | null>(null);
  function requestDelete(runId?: string) {
    if (undoSupported) { void remove(runId); return; }
    // An older attached daemon deletes permanently. Keep its confirmation.
    opener.current = document.activeElement as HTMLElement;
    setPending({ runId });
  }
  async function remove(runId?: string) {
    if (busy) return;
    setBusy(true);
    try { if (await onDelete(runId)) setPending(null); } finally { setBusy(false); }
  }
  const current = runs.find(run => run.id === outputRunId);
  const outputFailure = outputRunId ? outputError || loadError : '';
  return <div className="runs-panel" aria-busy={loading}><div className="panel-toolbar"><span>{outputRunId ? '本次运行输出 · 只读' : loading && runs.length ? '正在更新运行记录…' : '每次启动都有独立记录'}</span><div>
    {outputRunId && <button className="text-button" onClick={() => onView(null)}>返回列表</button>}
    {outputRunId && current ? <button className="subtle danger-text" disabled={disabled || busy || active(current)} title={active(current) ? '请先停止终端' : undoSupported ? '删除此记录及输出日志（可在提示条中撤销）' : '删除此记录及输出日志'} onClick={() => requestDelete(current.id)}>删除此记录</button> : !outputRunId && <button className="subtle danger-text" disabled={disabled || busy || !runs.some(run => !active(run))} title={undoSupported ? '删除已结束的运行记录（可在提示条中撤销）' : '删除已结束的运行记录'} onClick={() => requestDelete()}>清除已结束记录</button>}
  </div></div>{loadError && !outputRunId && <div className="form-error runs-load-error" role="alert"><span>{loadError.replace(/^Error: /, '')}</span><button className="subtle" disabled={disabled || loading} onClick={onRetry}>重试</button></div>}{outputRunId && output === null && outputFailure ? <div className="empty-page output-error" role="alert"><h2>无法读取本次输出</h2><p>{outputFailure.replace(/^Error: /, '')}</p><button className="subtle" disabled={disabled || loading} onClick={onRetry}>重试</button></div> : outputRunId && output === null ? <div className="empty-page" role="status"><div className="loader" /><p>正在读取本次输出</p></div> : outputRunId && output !== null ? <OutputView windowsPty={windowsPty} key={outputRunId} onError={onError} fontSize={fontSize} text={output || '保留范围内没有输出；较旧日志可能已清理。'} /> : <div className="runs-list">{runs.map(run => <div className="run-row" key={run.id}>
    <button className="run-item" onClick={() => onView(run.id)}><span><code>{run.id.slice(0, 8)}</code><small title={run.shell}>{run.command || '交互式 Shell'}{run.shell ? ` · ${run.shell.split(/[\\/]/).at(-1)}` : ''}</small></span><span>{date(run.startedAt)}</span><span className="badge">{statusNames[run.status]}</span><span>退出码 {run.exitCode ?? '—'}</span><span aria-hidden="true">→</span></button>
    <button className="subtle danger-text" aria-label={`删除运行记录 ${run.id.slice(0, 8)}`} title={active(run) ? '请先停止终端' : undoSupported ? '删除此记录及输出日志（可在提示条中撤销）' : '删除此记录及输出日志'} disabled={disabled || busy || active(run)} onClick={() => requestDelete(run.id)}>删除</button>
  </div>)}{loading && !runs.length ? <div className="empty-page" role="status"><div className="loader" /><h2>正在读取运行记录</h2><p>已有记录会在读取后显示。</p></div> : !runs.length && !loadError && <div className="empty-page"><h2>尚无运行记录</h2><p>启动终端后，会在这里保留记录。</p></div>}</div>}
    {pending && <Dialog title={pending.runId ? '删除此运行记录？' : '清除已结束的运行记录？'} busy={busy} error="" returnFocus={opener.current} onClose={() => setPending(null)}>
      <p className="stop-description">当前后台不支持撤销。将永久删除{pending.runId ? '此运行记录' : '全部已结束的运行记录'}及输出日志。</p>
      <footer><button className="subtle" data-dismiss="dialog" disabled={busy}>取消</button><button className="danger" disabled={disabled || busy} onClick={() => void remove(pending.runId)}>确认删除</button></footer>
    </Dialog>}
  </div>;
}
