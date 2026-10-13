import type { Run } from '../shared/protocol';

export function TerminalState({ run, disabled, onStart, onOutput }: { run: Run | null; disabled: boolean; onStart: () => void; onOutput: () => void }) {
  const stopping = run?.status === 'stopping';
  const heading = !run ? '会话已就绪' : stopping ? '正在停止终端' : run.status === 'stopped' ? '终端已停止' : run.status === 'exited' ? '终端已结束' : run.status === 'failed' ? '终端未能启动' : '上次运行已中断';
  return <div className="terminal-state" data-testid="terminal-state" role="status">
    <div className={`terminal-state-icon ${stopping ? 'pending' : ''}`} aria-hidden="true">{stopping ? <div className="loader" /> : <svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" strokeWidth="1.5"><path d={!run ? 'm5 7 4 4-4 4m7 0h6' : 'm6 12 4 4 8-8'} /></svg>}</div>
    <h2>{heading}</h2>
    <p>{stopping ? '正在清理终端和子进程，请稍候。' : !run ? '启动终端，开始这个项目的工作。' : '本次运行已结束。输出和运行记录已保留，可以查看或重新启动。'}</p>
    {run && !stopping && <div className="terminal-state-meta">{run.endedAt && <time dateTime={run.endedAt}>{new Date(run.endedAt).toLocaleString('zh-CN')}</time>}{run.exitCode !== null && <span>退出码 {run.exitCode}</span>}</div>}
    {!stopping && <div className="terminal-state-actions">{run && <button className="subtle" disabled={disabled} onClick={onOutput}>查看本次输出</button>}<button className="primary" disabled={disabled} onClick={onStart}>{run ? '重新启动终端' : '开始会话'}</button></div>}
  </div>;
}
