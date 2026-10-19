import { useEffect, useState } from 'react';
import { API_VERSION, type AppInfo } from '../shared/protocol';
import { diagnostics } from '../shared/diagnostics';

export function AboutCard({ connected, apiVersion, running, onError }: { connected: boolean; apiVersion: number; running: number; onError: (error: string) => void }) {
  const [info, setInfo] = useState<AppInfo | null>(null);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  useEffect(() => {
    let alive = true;
    void window.berth.appInfo().then(value => { if (alive) setInfo(value); }).catch(reason => { if (alive) setError(String(reason)); });
    return () => { alive = false; };
  }, []);
  async function action(work: () => Promise<void>, success = '') {
    setMessage(''); setError('');
    try { await work(); setMessage(success); } catch (reason) { setError(String(reason)); onError(String(reason)); }
  }
  return <section className="settings-card about-card"><h2>关于与支持</h2>
    <p className="app-version">StackIsle · 栈屿 {info ? `v${info.version}` : '正在读取版本…'}</p>
    <p>后台{connected ? '已连接' : '未连接'}{apiVersion < API_VERSION ? ' · 可更新后台' : ''}</p>
    <div className="about-actions"><button className="subtle" disabled={!info} onClick={() => void action(() => window.berth.copyText(diagnostics(info!, connected, apiVersion, running)), '诊断信息已复制')}>复制诊断信息</button><button className="subtle" onClick={() => void action(() => window.berth.openDataDirectory())}>打开数据目录</button><button className="subtle" onClick={() => void action(() => window.berth.openExternal('https://github.com/Tan90degrees/AgentBerth/blob/main/README.md'))}>使用说明</button><button className="subtle" onClick={() => void action(() => window.berth.openExternal('https://github.com/Tan90degrees/AgentBerth/issues'))}>反馈问题</button></div>
    <p className="form-hint">复制诊断信息可用于反馈问题，仅包含版本、系统和后台状态。</p>
    {info && <details className="advanced-options"><summary>运行环境</summary><p>{info.platform} {info.arch} · {info.osRelease} · {info.packaged ? '安装包 / ZIP' : '开发环境'}</p><p>Electron {info.electron} · Node {info.node}</p><p>后台 API {apiVersion} / 应用 API {API_VERSION} · {running} 个运行终端</p></details>}
    {message && <p role="status">{message}</p>}{error && <p role="alert">{error}</p>}
  </section>;
}
