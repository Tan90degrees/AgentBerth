import { useEffect, useRef, useState,type CSSProperties } from 'react';
import { defaultPetPreferences, petAppearances,petAppearanceLabels,naiwaClips,type PetAppearance, petLabels, petStatuses, petScales, petMonitorLayout, petWindowSize, showsPetMonitor, type PetPreferences, type PetSnapshot, type PetStatus } from '../shared/pet';
import { ACCELERATOR_REFRESH_SECONDS, HOST_METRICS_API_VERSION, MAX_MONITORED_NODES, MONITOR_FONT_SIZE } from '../shared/accelerator';
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
  const [atlas,setAtlas]=useState<string|null>(null);
  const appearance=snapshot.preferences.appearance,available=snapshot.availableAppearances?.includes('naiwa');
  useEffect(()=>{let alive=true;setAtlas(null);if(appearance==='naiwa'&&available)void window.berth.pet<string|null>({action:'appearanceImage',appearance:'naiwa'}).then(value=>{if(alive)setAtlas(value);}).catch(reason=>{if(alive)setError(String(reason));});return()=>{alive=false;};},[appearance,available]);
  return { snapshot, setSnapshot, error, setError, save,atlas };
}
function PetImage({ status, custom, revision = '', preview = false,appearance='dafeiyu',atlas }: { status: PetStatus; custom?: string; revision?: string; preview?: boolean;appearance?:PetAppearance;atlas?:string|null }) {
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
  if(appearance==='naiwa'&&!custom){
    const clip=naiwaClips[status],steps=clip.loop?clip.frames:clip.frames-1;
    const style={'--pet-row':clip.row,'--pet-end':steps,'--pet-steps':steps,'--pet-duration':clip.duration+'ms','--pet-loop':clip.loop?'infinite':1,backgroundImage:atlas?'url('+atlas+')':undefined} as CSSProperties;
    return <span role="img" aria-label={petLabels[status]} data-appearance="naiwa" data-status={status} data-ready={!!atlas} className={'pet-character pet-naiwa'+(preview?' pet-preview':'')} title={preview?'悬停或聚焦预览动作':undefined} tabIndex={preview?0:undefined}
      onMouseEnter={()=>setHovered(true)} onMouseLeave={()=>setHovered(false)} onFocus={()=>setFocused(true)} onBlur={()=>setFocused(false)}>
      <span key={status} className={'pet-naiwa-frame'+(animate?' animate':'')} style={style}/>
    </span>;
  }
  return <img draggable={false} data-appearance={custom?'custom':'dafeiyu'} className={preview ? "pet-character pet-preview" : "pet-character"} src={animate ? image ?? animation : still ?? poster}
    alt={petLabels[status]} title={preview ? '悬停或聚焦预览动作' : undefined} tabIndex={preview ? 0 : undefined}
    onMouseEnter={() => setHovered(true)} onMouseLeave={() => setHovered(false)}
    onFocus={() => setFocused(true)} onBlur={() => setFocused(false)} onError={() => setImage(null)} />;
}

function PetScale({ value, disabled, onChange }: { value: number; disabled: boolean; onChange: (scale: number) => void }) {
  const scales = [...new Set<number>([...petScales, value])].sort((a, b) => a - b);
  return <select aria-label="桌宠大小" title="调整桌宠大小" value={value} disabled={disabled} onChange={event => onChange(Number(event.target.value))}>{scales.map(scale => <option key={scale} value={scale}>{Math.round(scale * 100)}%</option>)}</select>;
}

function AcceleratorPanel({ snapshot }: { snapshot: PetSnapshot }) {
  const { preferences, monitor } = snapshot;
  const [viewport, setViewport] = useState(() => ({ width: window.innerWidth, height: window.innerHeight }));
  useEffect(() => {
    const update = () => setViewport({ width: window.innerWidth, height: window.innerHeight });
    window.addEventListener('resize', update);
    return () => window.removeEventListener('resize', update);
  }, []);
  const layout = petMonitorLayout(preferences, monitor?.readings ?? []);
  // The native window caps its outer size to the display work area.
  const zoom = Math.max(0.01, Math.min(1, (viewport.width - 24) / layout.width,
    (viewport.height - 28 - Math.ceil(160 * preferences.scale)) / layout.height));
  const percent = (value: number | null | undefined) => value == null ? '—' : value + '%';
  const gib = (value: number) => value >= 1000 ? value.toFixed(0) : value.toFixed(1);
  const style = {
    zoom, width: layout.width, fontSize: preferences.monitorFontSize,
    gridTemplateColumns: `repeat(${preferences.monitorNodeIds.length}, minmax(0, 1fr))`,
    '--monitor-row': layout.rowHeight + 'px',
  } as CSSProperties;
  return <section className="pet-accelerators" aria-label="远程资源监控" style={style}>
    {preferences.monitorNodeIds.map(id => {
      const node = monitor?.nodes.find(node => node.id === id);
      const reading = monitor?.readings.find(reading => reading.id === id);
      const sample = reading?.sample, memory = sample?.host?.memory;
      const timestamp = sample ? new Date(sample.sampledAt).toLocaleTimeString([], { hour12: false }) : '';
      const state = !monitor?.available ? '监控暂不可用' : !node ? 'SSH 连接不存在' :
        reading?.error ? (sample ? '采集失败' : reading.error) :
        sample ? (sample.warning ? '部分指标不可用' : '已更新') : '正在采集…';
      const stale = !!sample && (!monitor?.available || !!reading?.error);
      return <section className="pet-monitor-node" key={id} aria-label={node?.alias ?? '未知节点'}>
        <strong className="pet-monitor-node-name" title={node?.alias}>{node?.alias ?? '未知节点'}</strong>
        <div className="pet-monitor-state" data-stale={stale} title={reading?.error ?? sample?.warning ?? state}>
          {state}{timestamp && ` · ${stale ? '上次 ' : ''}${timestamp}`}
        </div>
        <div className="pet-monitor-host">
          <span>CPU <b>{percent(sample?.host?.cpu)}</b></span>
          <span>内存 <b>{memory ? `${gib(memory.usedKiB / 1048576)}/${gib(memory.totalKiB / 1048576)} GiB` : '—'}</b></span>
        </div>
        <table className="pet-monitor-cards" aria-label="加速卡指标">
          <thead><tr><th>卡号</th><th>利用率</th><th>显存 GiB</th><th>温度</th></tr></thead>
          <tbody>{sample?.devices.length ? sample.devices.map(device => <tr key={device.kind + device.id}
            title={[device.model, device.health, device.memory?.kind].filter(Boolean).join(' · ')}>
            <th scope="row">{device.kind.toUpperCase()} {device.id}</th>
            <td>{percent(device.utilization)}</td>
            <td>{device.memory ? gib(device.memory.used / 1024) + '/' + gib(device.memory.total / 1024) : '—'}</td>
            <td>{device.temperature === null ? '—' : device.temperature + '°C'}</td>
          </tr>) : <tr><td colSpan={4}>{sample ? '暂无 GPU / NPU 数据' : '—'}</td></tr>}</tbody>
        </table>
      </section>;
    })}
  </section>;
}

export function DesktopPet() {
  const { snapshot, error, setError,atlas } = usePet();
  const dragging = useRef(false), frame = useRef(0);
  const selected = snapshot.sessions.find(session => session.sessionId === snapshot.preferences.selectedSessionId) ?? snapshot.sessions[0];
  const status = selected?.status ?? 'idle';
  const request = (action: 'menu' | 'dragStart' | 'dragMove' | 'dragEnd') => {
    void window.berth.pet({ action }).catch(reason => setError(String(reason)));
  };
  const endDrag = () => {
    if (frame.current) { cancelAnimationFrame(frame.current); frame.current = 0; }
    if (dragging.current) { dragging.current = false; request('dragEnd'); }
  };
  useEffect(() => () => {
    if (frame.current) cancelAnimationFrame(frame.current);
    if (dragging.current) void window.berth.pet({ action: 'dragEnd' }).catch(() => {});
  }, []);
  const menu = () => { endDrag(); request('menu'); };
  const monitoring = showsPetMonitor(snapshot.preferences);
  const scale = snapshot.preferences.scale;
  return <main className={`desktop-pet pet-state-${status}`} data-session-id={selected?.sessionId ?? ''} data-monitoring={monitoring} style={monitoring ? undefined : { zoom: scale, ...petWindowSize }}>
    {monitoring && <AcceleratorPanel snapshot={snapshot} />}
    <button type="button" className="pet-stage" style={monitoring ? { zoom: scale, width: 192 } : undefined} aria-label={`桌宠：${selected?.title ?? '暂无 Agent 会话'}，${petLabels[status]}；右键打开菜单`}
      title={error || '按住图像拖动；右键打开操作菜单'}
      onContextMenu={event => { event.preventDefault(); menu(); }}
      onKeyDown={event => { if (['ContextMenu', 'Enter', ' '].includes(event.key) || event.shiftKey && event.key === 'F10') { event.preventDefault(); menu(); } }}
      onPointerDown={event => {
        if (event.button !== 0) return;
        event.preventDefault(); event.currentTarget.setPointerCapture(event.pointerId);
        dragging.current = true; request('dragStart');
      }}
      onPointerMove={event => {
        if (!dragging.current) return;
        if (!(event.buttons & 1)) { endDrag(); return; }
        if (!frame.current) frame.current = requestAnimationFrame(() => { frame.current = 0; if (dragging.current) request('dragMove'); });
      }}
      onPointerUp={event => { endDrag(); if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId); }}
      onPointerCancel={endDrag} onLostPointerCapture={endDrag}>
      <PetImage status={status} custom={snapshot.preferences.customImages?snapshot.images[status]:undefined} revision={String(snapshot.imageVersion)} appearance={snapshot.preferences.appearance} atlas={atlas}/>
    </button>
  </main>;
}

export function PetSettings({ projects = [], currentProjectId, apiVersion = 38 }: { projects?: import('../shared/protocol').Project[]; currentProjectId?: string; apiVersion?: number }) {
  const { snapshot, setSnapshot, error, setError, save,atlas } = usePet();
  const [busy, setBusy] = useState(false), [revision, setRevision] = useState(0), [guide, setGuide] = useState('');
  const [provider, setProvider] = useState<'claude' | 'opencode' | 'pi'>('claude'), [scope, setScope] = useState(currentProjectId ?? ''), [notice, setNotice] = useState('');
  useEffect(() => {
    let alive = true;
    void window.berth.pet<string>({ action: 'hookGuide' }).then(value => { if (alive) setGuide(value); }).catch(reason => { if (alive) setError(String(reason)); });
    return () => { alive = false; };
  }, []);
  const preferences = snapshot.preferences;
  const [pendingVisibility, setPendingVisibility] = useState<boolean>();
  const [refreshInput, setRefreshInput] = useState(String(preferences.monitorRefreshSeconds));
  useEffect(() => setRefreshInput(String(preferences.monitorRefreshSeconds)), [preferences.monitorRefreshSeconds]);
  const refreshSeconds = Number(refreshInput);
  const validRefresh = Number.isInteger(refreshSeconds) && refreshSeconds >= ACCELERATOR_REFRESH_SECONDS.min && refreshSeconds <= ACCELERATOR_REFRESH_SECONDS.max;
  const apply = async (change: Partial<PetPreferences>) => {
    setBusy(true); setError(''); try { await save(change); } catch (reason) { setError(String(reason)); } finally { setBusy(false); }
  };
  return <section className="settings-card pet-settings"><h2>桌宠</h2>{/* 展示 ACP、Superagent 任务以及 CLI Agent 会话，普通终端与 SSH 不展示。ACP 和 Superagent 直接同步状态，无需安装 hook。按住桌宠图像拖动，右键图像打开会话与设置菜单。 */}
    <label className="pet-toggle"><input type="checkbox" checked={preferences.enabled} disabled={busy} onChange={event => void apply({ enabled: event.target.checked })} />显示桌宠</label>
    <label className="pet-toggle"><input type="checkbox" checked={preferences.alwaysOnTop} disabled={busy} onChange={event => void apply({ alwaysOnTop: event.target.checked })} />保持在其他窗口上方</label>
    <label className="pet-toggle"><input type="checkbox" checked={preferences.autoSwitch} disabled={busy} onChange={event => void apply({ autoSwitch: event.target.checked })} />等待处理或失败时，自动切换到对应会话</label>
    <label>桌宠大小<PetScale value={preferences.scale} disabled={busy} onChange={scale => void apply({ scale })} /></label>{/* 支持 50%–200%，也可右键桌宠图像，在“桌宠大小”中调节，自动保存。 */}
    <h3>远程资源监控 · {preferences.monitorNodeIds.length}/{MAX_MONITORED_NODES}</h3>
    <label className="pet-toggle"><input type="checkbox" checked={pendingVisibility ?? preferences.monitorVisible} disabled={busy} onChange={event => {
      const visible = event.target.checked;
      setPendingVisibility(visible); setBusy(true); setError('');
      void window.berth.pet<PetSnapshot>({ action: 'showMonitor', visible })
        .then(setSnapshot).catch(reason => setError(String(reason))).finally(() => { setPendingVisibility(undefined); setBusy(false); });
    }} />显示远程资源</label>
    <label>监控字号<select aria-label="监控字号" value={preferences.monitorFontSize} disabled={busy} onChange={event => {
      const size = Number(event.target.value);
      setBusy(true); setError('');
      void window.berth.pet<PetSnapshot>({ action: 'saveMonitorFontSize', size })
        .then(setSnapshot).catch(reason => setError(String(reason))).finally(() => setBusy(false));
    }}>{Array.from({ length: MONITOR_FONT_SIZE.max - MONITOR_FONT_SIZE.min + 1 }, (_, index) => MONITOR_FONT_SIZE.min + index)
      .map(size => <option key={size} value={size}>{size} px</option>)}</select></label>
    <label>添加 SSH 节点<select aria-label="添加监控节点" value="" disabled={busy || !snapshot.monitor?.available || preferences.monitorNodeIds.length >= MAX_MONITORED_NODES} onChange={event => {
      const id = event.target.value;
      setBusy(true); setError('');
      void window.berth.pet<PetSnapshot>({ action: 'saveMonitor', ids: [...preferences.monitorNodeIds, id] })
        .then(setSnapshot).catch(reason => setError(String(reason))).finally(() => setBusy(false));
    }}>
      <option value="">{snapshot.monitor?.nodes.length ? '选择 SSH 连接' : '请先在 SSH 设置中保存连接'}</option>
      {snapshot.monitor?.nodes.filter(node => !preferences.monitorNodeIds.includes(node.id)).map(node => <option key={node.id} value={node.id}>{node.alias}</option>)}
    </select></label>
    <div className="pet-monitor-interval">
      <label>刷新间隔（秒）<input aria-label="监控刷新间隔（秒）" type="number" value={refreshInput} disabled={busy}
        min={ACCELERATOR_REFRESH_SECONDS.min} max={ACCELERATOR_REFRESH_SECONDS.max} step={1}
        onChange={event => setRefreshInput(event.target.value)} /></label>
      <AsyncButton className="subtle" disabled={busy || !validRefresh || refreshSeconds === preferences.monitorRefreshSeconds} onError={setError}
        onAction={async () => {
          setBusy(true); setError('');
          try { setSnapshot(await window.berth.pet({ action: 'saveMonitorInterval', seconds: refreshSeconds })); }
          finally { setBusy(false); }
        }}>保存刷新间隔</AsyncButton>
    </div>
    {!validRefresh && <p className="form-error" role="alert">请输入 {ACCELERATOR_REFRESH_SECONDS.min}–{ACCELERATOR_REFRESH_SECONDS.max} 之间的整数秒。</p>}
    {apiVersion < HOST_METRICS_API_VERSION && <p className="form-hint" role="status">更新空闲后台后可查看 CPU 与内存。</p>}
    <div className="pet-monitor-settings">
      {preferences.monitorNodeIds.map(id => {
        const alias = snapshot.monitor?.nodes.find(node => node.id === id)?.alias ?? '未知节点';
        return <div key={id}><span>{alias}</span><AsyncButton className="text-button" disabled={busy} onError={setError} onAction={async () => {
          setBusy(true); setError('');
          try { setSnapshot(await window.berth.pet({ action: 'saveMonitor', ids: preferences.monitorNodeIds.filter(nodeId => nodeId !== id) })); }
          finally { setBusy(false); }
        }}>移除</AsyncButton></div>;
      })}
    </div>
    <h3>形象与动作</h3><label>桌宠形象<select aria-label="桌宠形象" value={preferences.appearance} disabled={busy} onChange={event=>{const appearance=event.target.value as PetAppearance;setBusy(true);setError('');void window.berth.pet({action:'selectAppearance',appearance}).then(setSnapshot).catch(reason=>setError(String(reason))).finally(()=>setBusy(false));}}>{petAppearances.map(appearance=><option key={appearance} value={appearance}>{petAppearanceLabels[appearance]}{appearance==='naiwa'&&!snapshot.availableAppearances?.includes('naiwa')?'（首次下载）':''}</option>)}</select></label>
    {busy&&<p role="status" className="form-hint">正在更新桌宠…</p>}
    <p className="form-hint">奶蛙首次选择时下载完整动作图集，之后可离线使用。素材来源：<AsyncButton className="text-button" onError={setError} onAction={()=>window.berth.openExternal('https://github.com/timerring/codex-pet-naiwa')}>codex-pet-naiwa</AsyncButton>。</p>
    {Object.keys(snapshot.images).length>0&&<label className="pet-toggle"><input type="checkbox" checked={preferences.customImages} disabled={busy} onChange={event=>void apply({customImages:event.target.checked})}/>使用已导入的自定义动作</label>}
    {/* 悬停或聚焦预览动作；导入 GIF 可替换对应状态，恢复默认回到当前形象的动作。 */}
    <div className="pet-animation-grid">{petStatuses.map(status => <div className="pet-animation" key={status}><PetImage preview status={status} custom={preferences.customImages?snapshot.images[status]:undefined} revision={String(snapshot.imageVersion) + revision} appearance={preferences.appearance} atlas={atlas}/><strong>{petLabels[status]}</strong><small>{preferences.customImages&&snapshot.images[status]||petAppearanceLabels[preferences.appearance]}</small><div><AsyncButton className="subtle" onError={setError} onAction={async () => { const value = await window.berth.pet<PetSnapshot | null>({ action: 'importImage', status }); if (!value) return 'cancelled'; setSnapshot(value); setRevision(value => value + 1); }}>导入 GIF</AsyncButton><AsyncButton className="text-button" disabled={!snapshot.images[status]} onError={setError} onAction={async () => { setSnapshot(await window.berth.pet({ action: 'resetImage', status })); setRevision(value => value + 1); }}>恢复默认</AsyncButton></div></div>)}</div>
    <p className="form-hint">大肥鱼形象来自 dsh-pet（MIT），动作帧由 dsh-dafeiyu 提供。<AsyncButton className="text-button" onError={setError} onAction={() => window.berth.openExternal('https://github.com/PC2005-cloud/dsh-pet')}>素材来源</AsyncButton></p>
    <h3>Agent hook 自动配置</h3>{/* 适配已安装的 Claude Code 和 OpenCode，不安装 Agent、不修改模型与账号。安装后重新启动对应 Agent 会话。 */}
    <div className="skill-filters"><label>适配 Agent<select aria-label="桌宠适配 Agent" value={provider} onChange={event => { setProvider(event.target.value as typeof provider); setNotice(''); }}><option value="claude">Claude Code</option><option value="opencode">OpenCode</option><option value="pi">Pi</option></select></label><label>安装范围<select aria-label="桌宠适配范围" value={scope} onChange={event => { setScope(event.target.value); setNotice(''); }}><option value="">用户级 · 所有项目</option>{projects.map(project => <option key={project.id} value={project.id}>项目 · {project.name}</option>)}</select></label></div>
    <AsyncButton className="subtle" disabled={apiVersion < 38} onError={setError} onAction={async () => {
      setError(''); setNotice('');
      const result = await window.berth.pet<import('../main/agent-integration').HookInstallation>({ action: 'installHook', provider, projectId: scope || null, opencodeVersion: 'auto' });
      setNotice(`${result.message}\n${result.path}${result.backup ? '\n备份：' + result.backup : ''}`);
    }}>安装/更新适配</AsyncButton>
    {notice && <p className="form-hint" role="status" aria-label="适配安装结果" style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{notice}</p>}
    {apiVersion < 38 && <p className="form-hint">请先在设置中更新空闲后台，再安装适配。</p>}
    {/* 保留已有配置与 hook，有变更时自动备份。OpenCode 自动检测 1.x / 2.x 插件接口。也可以把以下说明复制给 Agent 自行配置；项目和用户范围任选一个即可。 */}
    <ol className="pet-hook-steps"><li>在 AgentBerth 中启动一个 Agent 类型会话。</li><li>点击“复制给 Agent 自动配置”，粘贴给该 Agent 执行。</li><li>配置完成后重新启动该 Agent 会话，检查执行、等待和完成状态。</li></ol>
    <AsyncButton className="subtle" onError={setError} onAction={async () => { const text = await window.berth.pet<string>({ action: 'hookGuide' }); setGuide(text); await window.berth.copyText(text); }}>复制给 Agent 自动配置</AsyncButton>
    <details className="pet-hook-guide"><summary>查看完整自动配置教程</summary><pre>{guide || '正在生成本机配置教程…'}</pre></details>
    <AsyncButton className="subtle" onError={setError} onAction={async () => { const config = await window.berth.pet<string>({ action: 'hookConfig' }); await window.berth.copyText(config); }}>复制 Claude Code hook 配置</AsyncButton>
    {/* CLI Agent 需配置 hook 才能显示精确状态；ACP 与 Superagent 自动同步状态。 */}
    {error && <p className="form-error" role="alert">{error.replace(/^Error: /, '')}</p>}
  </section>;
}
