import { useEffect, useState } from 'react';
import { defaultPetPreferences, petLabels, petStatuses, petScales, petWindowSize, type PetPreferences, type PetSnapshot, type PetStatus } from '../shared/pet';
import { AsyncButton } from './AsyncButton';
import './pet.css';

const defaults = import.meta.glob('./pet-assets/*.{webp,png}', { eager: true, query: '?url', import: 'default' }) as Record<string, string>;
const empty: PetSnapshot = { preferences: defaultPetPreferences, sessions: [], connected: false, images: {}, imageVersion: 0 };
function usePet() {
  const [snapshot, setSnapshot] = useState<PetSnapshot>(empty), [error, setError] = useState('');
  useEffect(() => {
    let alive = true, received = false;
    const off = window.berth.onPet(value => { received = true; if (alive) setSnapshot(value); });
    void window.berth.pet({ action: 'state' }).then(value => { if (alive && !received) setSnapshot(value); }).catch(reason => { if (alive) setError(String(reason)); });
    return () => { alive = false; off(); };
  }, []);
  const save = async (change: Partial<PetPreferences>) => {
    const previous = snapshot;
    const preferences = { ...snapshot.preferences, ...change };
    // Controlled inputs acknowledge the click while the native window loads.
    setSnapshot(current => ({ ...current, preferences }));
    try { const value = await window.berth.pet({ action: 'save', preferences }); setSnapshot(value); }
    catch (reason) { setSnapshot(previous); throw reason; }
  };
  return { snapshot, setSnapshot, error, setError, save };
}
function PetImage({ status, custom, revision = '', preview = false }: { status: PetStatus; custom?: string; revision?: string; preview?: boolean }) {
  const [image, setImage] = useState<string | null>(null), [still, setStill] = useState<string | null>(null);
  const [hovered, setHovered] = useState(false), [focused, setFocused] = useState(false);
  const [reduced, setReduced] = useState(() => window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  useEffect(() => {
    const media = window.matchMedia('(prefers-reduced-motion: reduce)');
    const update = () => setReduced(media.matches);
    update(); media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, []);
  useEffect(() => {
    let alive = true; setImage(null);
    if (custom) void window.berth.pet<string | null>({ action: 'image', status }).then(value => { if (alive) setImage(value); }).catch(() => {});
    return () => { alive = false; };
  }, [status, custom, revision]);
  useEffect(() => {
    setStill(null);
    if (!image) return;
    let alive = true;
    const frame = new Image();
    frame.onload = () => {
      if (!alive) return;
      const ratio = Math.min(1, 384 / frame.naturalWidth, 320 / frame.naturalHeight);
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(frame.naturalWidth * ratio));
      canvas.height = Math.max(1, Math.round(frame.naturalHeight * ratio));
      const context = canvas.getContext('2d');
      if (context) { context.drawImage(frame, 0, 0, canvas.width, canvas.height); setStill(canvas.toDataURL('image/png')); }
      frame.onload = null; frame.src = '';
    };
    frame.src = image;
    return () => { alive = false; frame.onload = null; frame.src = ''; };
  }, [image]);
  const animation = defaults[`./pet-assets/${status}.webp`], poster = defaults[`./pet-assets/${status}.png`] ?? animation;
  const animate = !reduced && (!preview || hovered || focused);
  return <img draggable={false} className={preview ? "pet-character pet-preview" : "pet-character"} src={animate ? image ?? animation : still ?? poster}
    alt={petLabels[status]} title={preview ? '悬停或聚焦预览动作' : undefined} tabIndex={preview ? 0 : undefined}
    onMouseEnter={() => setHovered(true)} onMouseLeave={() => setHovered(false)}
    onFocus={() => setFocused(true)} onBlur={() => setFocused(false)} onError={() => setImage(null)} />;
}

function PetScale({ value, disabled, onChange }: { value: number; disabled: boolean; onChange: (scale: number) => void }) {
  const scales = [...new Set<number>([...petScales, value])].sort((a, b) => a - b);
  return <select aria-label="桌宠大小" title="调整桌宠大小" value={value} disabled={disabled} onChange={event => onChange(Number(event.target.value))}>{scales.map(scale => <option key={scale} value={scale}>{Math.round(scale * 100)}%</option>)}</select>;
}

export function DesktopPet() {
  const { snapshot, error, setError, save } = usePet();
  const [busy, setBusy] = useState(false);
  const sessions = snapshot.sessions, preferences = snapshot.preferences;
  const selected = sessions.find(session => session.sessionId === preferences.selectedSessionId) ?? sessions[0];
  const status = selected?.status ?? 'idle';
  const pending = sessions.filter(session => ['waiting', 'error'].includes(session.status)).length;
  const apply = async (change: Partial<PetPreferences>) => {
    if (busy) return; setBusy(true); setError('');
    try { await save(change); } catch (reason) { setError(String(reason)); } finally { setBusy(false); }
  };
  const cycle = (direction: number) => {
    if (!sessions.length) return;
    const index = sessions.findIndex(session => session.sessionId === selected?.sessionId);
    void apply({ selectedSessionId: sessions[(index + direction + sessions.length) % sessions.length].sessionId });
  };
  return <main className="desktop-pet" style={{ zoom: preferences.scale, ...petWindowSize }}>
    <div className="pet-stage" title="拖动角色移动桌宠"><PetImage status={status} custom={snapshot.images[status]} revision={String(snapshot.imageVersion)} /></div>
    <section className="pet-card" aria-label="Agent 状态">
      <div className="pet-card-head" title="拖动状态栏移动桌宠"><div className={`pet-state pet-state-${status}`} role="status"><span>{selected ? petLabels[status] : '暂无 Agent 会话'}</span>{pending > 0 && <small aria-label={`${pending} 个 Agent 会话待处理`} title={`${pending} 个 Agent 会话待处理`}>{pending}</small>}</div><div className="pet-card-actions"><PetScale value={preferences.scale} disabled={busy} onChange={scale => void apply({ scale })} /><button className="pet-hide" aria-label="隐藏桌宠" title="隐藏桌宠" disabled={busy} onClick={() => void apply({ enabled: false })}>×</button></div></div>
      <div className="pet-session-picker"><button aria-label="上一个桌宠会话" disabled={busy || sessions.length < 2} onClick={() => cycle(-1)}>‹</button><select aria-label="桌宠展示的会话" disabled={busy || !sessions.length} value={selected?.sessionId ?? ''} onChange={event => void apply({ selectedSessionId: event.target.value })}>{!sessions.length && <option value="">从工作台启动 Agent 会话</option>}{sessions.map(session => <option key={session.sessionId} value={session.sessionId}>{session.project} / {session.title} · {petLabels[session.status]}</option>)}</select><button aria-label="下一个桌宠会话" disabled={busy || sessions.length < 2} onClick={() => cycle(1)}>›</button></div>
      <p title={selected?.label}>{error || selected?.label || (selected?.hooked ? 'Agent hook 已接入' : '仅显示 Agent 会话 · 拖动角色可移动')}</p>
      <AsyncButton className="pet-open" disabled={!selected} onError={setError} onAction={() => window.berth.pet({ action: 'showSession' })}>打开当前会话</AsyncButton>
    </section>
  </main>;
}

export function PetSettings() {
  const { snapshot, setSnapshot, error, setError, save } = usePet();
  const [busy, setBusy] = useState(false), [revision, setRevision] = useState(0), [guide, setGuide] = useState('');
  useEffect(() => {
    let alive = true;
    void window.berth.pet<string>({ action: 'hookGuide' }).then(value => { if (alive) setGuide(value); }).catch(reason => { if (alive) setError(String(reason)); });
    return () => { alive = false; };
  }, []);
  const preferences = snapshot.preferences;
  const apply = async (change: Partial<PetPreferences>) => {
    setBusy(true); setError(''); try { await save(change); } catch (reason) { setError(String(reason)); } finally { setBusy(false); }
  };
  return <section className="settings-card pet-settings"><h2>桌宠</h2><p>仅展示 Codex、Claude、OpenCode 和自定义 Agent 会话，普通终端与 SSH 不展示。拖动角色或状态栏移动桌宠。</p>
    <label className="pet-toggle"><input type="checkbox" checked={preferences.enabled} disabled={busy} onChange={event => void apply({ enabled: event.target.checked })} />显示桌宠</label>
    <label className="pet-toggle"><input type="checkbox" checked={preferences.alwaysOnTop} disabled={busy} onChange={event => void apply({ alwaysOnTop: event.target.checked })} />保持在其他窗口上方</label>
    <label className="pet-toggle"><input type="checkbox" checked={preferences.autoSwitch} disabled={busy} onChange={event => void apply({ autoSwitch: event.target.checked })} />等待处理或失败时，自动切换到对应会话</label>
    <label>桌宠大小<PetScale value={preferences.scale} disabled={busy} onChange={scale => void apply({ scale })} /></label><p className="form-hint">支持 50%–200%，也可在桌宠状态栏直接调节，自动保存。</p>
    <h3>Agent hook 自动配置</h3><p>把说明复制给正在使用的 Agent，让它自动识别配置、合并 hook 并验证。说明已包含本机安装路径和可执行命令。</p>
    <ol className="pet-hook-steps"><li>在 AgentBerth 中启动一个 Agent 类型会话。</li><li>点击“复制给 Agent 自动配置”，粘贴给该 Agent 执行。</li><li>配置完成后重新启动该 Agent 会话，检查执行、等待和完成状态。</li></ol>
    <AsyncButton className="subtle" onError={setError} onAction={async () => { const text = await window.berth.pet<string>({ action: 'hookGuide' }); setGuide(text); await window.berth.copyText(text); }}>复制给 Agent 自动配置</AsyncButton>
    <details className="pet-hook-guide"><summary>查看完整自动配置教程</summary><pre>{guide || '正在生成本机配置教程…'}</pre></details>
    <AsyncButton className="subtle" onError={setError} onAction={async () => { const config = await window.berth.pet<string>({ action: 'hookConfig' }); await window.berth.copyText(config); }}>复制 Claude Code hook 配置</AsyncButton>
    <p className="form-hint">未接入 hook 的 Agent 显示“状态待确认”。教程指导保留已有配置和 hook，不会把当前会话 ID 固定写入配置。</p>
    <h3>形象与动作</h3><p>内置完整角色动画，悬停或聚焦可预览动作。可为每种状态导入自己的 GIF；恢复默认只替换对应动作。</p>
    <div className="pet-animation-grid">{petStatuses.map(status => <div className="pet-animation" key={status}><PetImage preview status={status} custom={snapshot.images[status]} revision={String(snapshot.imageVersion) + revision} /><strong>{petLabels[status]}</strong><small>{snapshot.images[status] ?? '默认形象'}</small><div><AsyncButton className="subtle" onError={setError} onAction={async () => { const value = await window.berth.pet<PetSnapshot | null>({ action: 'importImage', status }); if (!value) return 'cancelled'; setSnapshot(value); setRevision(value => value + 1); }}>导入 GIF</AsyncButton><AsyncButton className="text-button" disabled={!snapshot.images[status]} onError={setError} onAction={async () => { setSnapshot(await window.berth.pet({ action: 'resetImage', status })); setRevision(value => value + 1); }}>恢复默认</AsyncButton></div></div>)}</div>
    <p className="form-hint">默认形象来自 dsh-pet（MIT），动作帧由 dsh-dafeiyu 提供。<AsyncButton className="text-button" onError={setError} onAction={() => window.berth.openExternal('https://github.com/PC2005-cloud/dsh-pet')}>素材来源</AsyncButton></p>
    {error && <p className="form-error" role="alert">{error.replace(/^Error: /, '')}</p>}
  </section>;
}
