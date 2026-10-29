import { useEffect, useState } from 'react';
import type { AppUpdateState, UpdateAction } from '../shared/updates';
import { AsyncButton } from './AsyncButton';

function useAppUpdates() {
  const [state, setState] = useState<AppUpdateState | null>(null);
  useEffect(() => {
    let alive = true, changed = false;
    const off = window.berth.onUpdates(value => { changed = true; setState(value); });
    void window.berth.updates('state').then(value => { if (alive && !changed) setState(value); }).catch(() => {});
    return () => { alive = false; off(); };
  }, []);
  return state;
}
export function AppUpdateNotice({ onError }: { onError: (message: string) => void }) {
  const state = useAppUpdates();
  if (state?.phase !== 'ready') return null;
  return <AsyncButton className="subtle app-update-notice" title="更新界面并自动接回运行中的终端" onError={onError} onAction={async () => { await window.berth.updates('apply'); }}>更新 v{state.latestVersion}</AsyncButton>;
}
export function AppUpdateCard() {
  const state = useAppUpdates(); const [error, setError] = useState('');
  const working = state && ['checking','downloading','extracting','applying'].includes(state.phase);
  async function action(kind: UpdateAction) { setError(''); const result = await window.berth.updates(kind); return result.phase !== 'error'; }
  return <section className="settings-card app-updates"><h2>软件更新</h2>
    <p>当前版本 {state ? `v${state.currentVersion}` : '正在读取…'}{state?.latestVersion ? ` · 可更新到 v${state.latestVersion}` : ''}</p>
    <p className="form-hint">日常更新只下载应用代码。一键应用后界面会自动重载，正在运行的终端与 SSH 保持；后台代码等所有终端结束后自动更新。</p>
    <label className="checkbox-label"><input type="checkbox" checked={state?.automatic ?? true} disabled={!state?.supported} onChange={event => { void window.berth.updates('automatic', event.target.checked).catch(error => setError(String(error))); }} />自动检查并后台下载更新</label>
    <div className="about-actions">
      <AsyncButton className="subtle" disabled={!state?.supported || !!working} onError={setError} onAction={() => action('check')}>检查更新</AsyncButton>
      {state?.phase === 'available' && <AsyncButton className="subtle" onError={setError} onAction={() => action('download')}>下载更新</AsyncButton>}
      {state?.phase === 'ready' && <AsyncButton className="primary" onError={setError} onAction={() => action('apply')}>立即更新（终端继续运行）</AsyncButton>}
      {working && state?.phase !== 'applying' && <AsyncButton className="subtle" onError={setError} onAction={() => action('cancel')}>取消</AsyncButton>}
      {state?.phase === 'runtime_required' && <AsyncButton className="subtle" onError={setError} onAction={() => window.berth.openExternal(state.releaseUrl)}>打开完整版本下载页</AsyncButton>}
    </div>
    {state?.phase === 'downloading' && <div className="app-update-progress"><progress aria-label="软件更新下载进度" max={Math.max(state.total, 1)} value={state.total ? state.downloaded : undefined} /><span>{(state.downloaded / 1024 / 1024).toFixed(1)} / {(state.total / 1024 / 1024).toFixed(1)} MiB</span></div>}
    {state?.message && <p role={state.phase === 'error' ? 'alert' : 'status'}>{state.message}</p>}
    {state?.backendPending && <p className="form-hint" role="status">界面已更新。后台将在全部终端结束后自动更新，当前任务不会被停止。</p>}
    {error && <p role="alert">{error}</p>}
    {!!state?.notes && <details className="advanced-options"><summary>此版本更新内容</summary><pre className="update-notes">{state.notes}</pre></details>}
  </section>;
}
