import type { Run } from '../shared/protocol';

export function TerminalState({ run, disabled, onOutput, recordOutput, historyAvailable }: { recordOutput: boolean; historyAvailable: boolean; run: Run | null; disabled: boolean; onOutput: () => void }) {
  const stopping = run?.status === 'stopping';
  const heading = !run ? '会话已就绪' : stopping ? '正在停止终端' : run.status === 'stopped' ? '终端已停止' : run.status === 'exited' ? '终端已结束' : run.status === 'failed' ? '终端未能启动' : '上次运行已中断';
  return <div className="terminal-state" data-testid="terminal-state" role="status">
    <div className={`terminal-state-icon ${stopping ? 'pending' : ''}`} aria-hidden="true">{stopping ? <div className="loader" /> : <svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" strokeWidth="1.5"><path d={!run ? 'm5 7 4 4-4 4m7 0h6' : 'm6 12 4 4 8-8'} /></svg>}</div>
    <h2>{heading}</h2>
    <p>{stopping ? '正在清理终端和子进程，请稍候。' : !run ? '右键左侧会话启动，或使用条目旁的 ⋯ 菜单。' : recordOutput ? '本次运行已结束。可查看终端输出；右键左侧会话重新启动。' : historyAvailable ? '本次会话已结束。右键左侧会话重新启动或恢复原生会话。' : '本次会话已结束，右键左侧会话可重新启动。'}</p>
    {run && !stopping && <div className="terminal-state-meta">{run.endedAt && <time dateTime={run.endedAt}>{new Date(run.endedAt).toLocaleString('zh-CN')}</time>}{run.exitCode !== null && <span>退出码 {run.exitCode}</span>}</div>}
    {!stopping && <div className="terminal-state-actions">{run && recordOutput && !!run.recordOutput && <button className="subtle" disabled={disabled} onClick={onOutput}>查看本次输出</button>}</div>}
  </div>;
}
