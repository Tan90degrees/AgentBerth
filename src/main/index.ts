import { PetState } from './pet-state';
import { petMenuTemplate } from './pet-menu';
import { keepPetAboveWindows } from './pet-window';
import { PetHooks } from './pet-hooks';
import { petRequestSchema, petStatuses, petWindowSize } from '../shared/pet';
import { statSync, writeFileSync } from 'node:fs';
import { petHookConfiguration, petHookSetupGuide } from './pet-config';
import { installAgentHook, integrationRoot } from './agent-integration';
import { SkillManager, skillRoot } from './skills';
import { builtinSkillProviders, skillRequestSchema } from '../shared/skills';
import { SshVault } from './ssh-vault';
import { sshConnectionSchema, sshSecretSchema, type SshChallenge, type SshWindowState } from '../shared/protocol';
import { TerminalSubscriptions } from './terminal-subscriptions';
import { legacyProfile } from './profile';
import { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, screen, nativeImage, nativeTheme, safeStorage, shell, Tray } from 'electron';
import path from 'node:path';
import { release } from 'node:os';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { connectDaemon, shutdownDaemon, stopIdleDaemon, type DaemonConnection } from './connection';
import { requestSchema, type Method, type ServerEvent } from '../shared/protocol';
import { installAgentFile, exportPluginKit, developmentPrompt } from './plugin-files';
import { AgentPlugins } from '../daemon/plugins';
import { externalWebUrl, MAX_CLIPBOARD_TEXT, MAX_PASTE_TEXT } from '../shared/desktop';

nativeTheme.themeSource = 'dark';

let window: BrowserWindow | null = null;
let sshWindow: BrowserWindow | null = null;
let petWindow: BrowserWindow | null = null;
let petDrag: { x: number; y: number } | null = null;
let pet: PetState;
let petHooks: PetHooks;
let petPublishTimer: NodeJS.Timeout | null = null;
let sshWindowSession = '';
let remoteSessionIds = new Set<string>();
let tray: Tray | null = null;
let connection: DaemonConnection | null = null;
let connecting: Promise<void> | null = null;
let quitting = false;
let quitReady = false;
let exitPromise: Promise<void> | null = null;
let reconnectTimer: NodeJS.Timeout | null = null;
let restarting = false;
let importingPlugins = new AgentPlugins();
const terminalSubscriptions = new TerminalSubscriptions(async (method, sessionId) => {
  if (!connection) throw new Error('后台连接已断开');
  return connection.rpc(method, { sessionId });
});
const resourceRoot = app.isPackaged ? process.resourcesPath : path.join(__dirname, '..');
const iconFile = path.join(resourceRoot, 'assets', process.platform === 'win32' ? 'app.ico' : 'app.png');
if (!app.commandLine.hasSwitch('user-data-dir')) { const profile = legacyProfile(app.getPath('appData')); mkdirSync(profile, { recursive: true }); app.setPath('userData', profile); }
const dataDirectory = process.env.AGENTBERTH_DATA_DIR ?? path.join(app.getPath('userData'), 'data');
const sshVault = new SshVault(path.join(dataDirectory,'ssh-secrets.json'), safeStorage);
if (!path.isAbsolute(dataDirectory)) throw new Error('AGENTBERTH_DATA_DIR must be an absolute path');

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', showWindow);
  app.on('before-quit', event => { if (!quitReady) { event.preventDefault(); void quitApplication(); } });
  app.on('window-all-closed', () => { /* Tray keeps the workbench accessible. PTYs belong to the independent daemon. */ });
  app.on('activate', showWindow);
  void app.whenReady().then(async () => {
    mkdirSync(dataDirectory, { recursive: true, mode: 0o700 });
    if (process.platform === 'win32') app.setAppUserModelId('dev.agentberth.desktop');
    pet = new PetState(path.join(dataDirectory, 'pet'), publishPet);
    pet.loadImages(petStatuses);
    petHooks = new PetHooks(dataDirectory, hook => {
      const accepted = pet.accept(hook);
      if (accepted && hook.provider && hook.nativeSessionId && hook.cwd && connection?.connected) {
        void connection.rpc('nativeSessionDetected', { sessionId: hook.sessionId, runId: hook.runId, provider: hook.provider, nativeSessionId: hook.nativeSessionId, cwd: hook.cwd }).catch(() => { /* History remains manually recoverable. */ });
      }
      return accepted;
    });
    try { await petHooks.start(); } catch (error) { console.error('桌宠 hook 启动失败', error); }
    createWindow();
    if (pet.preferences.enabled) void openPetWindow();
    setInterval(publishPet, 30_000).unref();
    const icon = nativeImage.createFromPath(iconFile);
    if (icon.isEmpty()) throw new Error('应用图标资源未正确打包');
    tray = new Tray(iconFile);
    tray.setToolTip('AgentBerth · 会话后台运行');
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: '打开 AgentBerth', click: showWindow },
      { label: '显示桌宠', click: () => { pet.save({ ...pet.preferences, enabled: true }); void openPetWindow(); } },
      { type: 'separator' },
      { label: '退出 AgentBerth（停止终端，下次恢复）', click: () => app.quit() },
    ]));
    tray.on('double-click', showWindow);
    try {
      await reconnect();
      const state = await connection!.rpc<import('../shared/protocol').State>('state');
      if (state.apiVersion >= 40) await connection!.rpc('restoreWorkspace');
    } catch (error) { emit({ event: 'connection', data: { connected: false, error: String(error) } }); }
  });
}

function refreshWindow(target = window) { if (connection?.connected && !quitting && target && !target.isDestroyed()) target.webContents.send('berth:event', { event: 'connection', data: { connected: true } }); }
function showWindow() { if (!window) createWindow(); if (window?.isMinimized()) window.restore(); window?.show(); window?.focus(); }
function quitApplication(): Promise<void> {
  if (exitPromise) return exitPromise;
  quitting = true;
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  tray?.setToolTip('AgentBerth · 正在停止终端并退出');
  exitPromise = (async () => {
    await petHooks?.close();
    await importingPlugins.close();
    if (connecting) await connecting.catch(() => {});
    await shutdownDaemon(dataDirectory, true);
    connection?.close(true); connection = null;
    quitReady = true; tray?.destroy(); tray = null;
    // All owned workers and the daemon are gone; renderer/debugger unload must not delay explicit quit.
    app.exit(0);
  })().catch(error => {
    console.error('AgentBerth 退出未完成：', error);
    quitting = false;
    importingPlugins = new AgentPlugins();
    void petHooks?.start().catch(hookError => console.error('桌宠 hook 恢复失败', hookError));
    tray?.setToolTip('AgentBerth · 退出失败，请重试');
    showWindow();
    dialog.showErrorBox('AgentBerth 退出未完成', `${String(error)}\n请再次从托盘选择退出，确保后台及全部终端停止。`);
  }).finally(() => { exitPromise = null; });
  return exitPromise;
}
async function answerSshChallenge(challenge: SshChallenge): Promise<void> {
  const provider = connection;
  if (!provider) return;
  try {
    if (challenge.kind === 'credentials') {
      await provider.rpc('sshChallengeReply', { challengeId: challenge.id, secret: sshVault.get(challenge.connectionId) });
    } else {
      showWindow();
      const result = await dialog.showMessageBox(window!, { type: 'question', title: '确认 SSH 服务器', message: `首次连接 ${challenge.alias}`, detail: `${challenge.hostname}:${challenge.port}\n主机指纹：${challenge.fingerprint}\n请与服务器管理员提供的指纹核对。信任后将为此连接记住指纹。`, buttons: ['取消连接','信任并连接'], defaultId: 0, cancelId: 0, noLink: true });
      await provider.rpc('sshChallengeReply', { challengeId: challenge.id, accepted: result.response === 1 });
    }
  } catch { await provider.rpc('sshChallengeReply', { challengeId: challenge.id, accepted: false }).catch(() => {}); }
}
async function registerSshProvider(): Promise<void> {
  const state = await connection!.rpc<import('../shared/protocol').State>('state');
  if (state.apiVersion >= 22) await connection!.rpc('registerSshProvider');
}
function emit(event: ServerEvent) {
  if (event.event === 'state') pet?.update(event.data);
  if (event.event === 'connection') pet?.connection(event.data.connected);
  if (event.event === 'sshChallenge') { void answerSshChallenge(event.data); return; }
  if (event.event === 'state') remoteSessionIds = new Set(event.data.sessions.filter(session => session.remote).map(session => session.id));
  for (const target of [window, sshWindow]) {
    if (!target || target.isDestroyed()) continue;
    const visible = target.isVisible() && !target.isMinimized();
    const subscribed = (event.event !== 'output' && event.event !== 'resize') || terminalSubscriptions.has(target.webContents.id, event.data.sessionId);
    if (event.event === 'output' && (!visible || !subscribed)) {
      const { sessionId, runId, seq } = event.data;
      target.webContents.send('berth:event', { event: 'terminalActivity', data: { sessionId, runId, seq } });
    } else if ((event.event !== 'output' && event.event !== 'resize') || (visible && subscribed)) target.webContents.send('berth:event', event);
  }
  if (event.event === 'connection' && !event.data.connected && !quitting && !restarting && !exitPromise) {
    connection = null;
    if (!reconnectTimer) reconnectTimer = setTimeout(() => { reconnectTimer = null; void reconnect().catch(error => emit({ event: 'connection', data: { connected: false, error: String(error) } })); }, 2000);
  }
}
async function reconnect(): Promise<void> {
  if (quitting) throw new Error('正在停止终端并退出');
  if (connecting) return connecting;
  connecting = (async () => {
    connection = await connectDaemon(dataDirectory, path.join(__dirname, 'daemon.cjs'), process.execPath, emit);
    await registerSshProvider();
    emit({ event: 'connection', data: { connected: true } });
    emit({ event: 'state', data: await connection.rpc('state') });
  })().finally(() => { connecting = null; });
  return connecting;
}
function secureWindow(target: BrowserWindow, detached = false) {
  target.setMenuBarVisibility(false);
  target.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  target.webContents.on('will-navigate', event => { event.preventDefault(); });
  const owner = target.webContents.id;
  target.webContents.on('destroyed', () => terminalSubscriptions.release(owner));
  target.on('restore', () => refreshWindow(target));
  // Hidden windows receive activity only. Reattach from the authoritative
  // snapshot when shown, so output produced while minimized is never lost.
  target.on('show', () => refreshWindow(target));
  target.webContents.on('did-finish-load', () => {
    if (connection) {
      refreshWindow(target);
      void connection.rpc('state').then(data => { if (!target.isDestroyed()) target.webContents.send('berth:event', { event: 'state', data }); }).catch(() => {});
    }
  });
  const developmentUrl = process.env.AGENTBERTH_DEV_URL;
  if (developmentUrl === 'http://127.0.0.1:5173') return target.loadURL(developmentUrl + (detached ? '?view=ssh' : ''));
  return target.loadFile(path.join(__dirname, 'renderer', 'index.html'), detached ? { query: { view: 'ssh' } } : {});
}
function publishPet() {
  if (petPublishTimer || !pet || quitting) return;
  petPublishTimer = setTimeout(() => {
    petPublishTimer = null;
    const snapshot = pet.snapshot();
    for (const target of [window, sshWindow, petWindow]) if (target && !target.isDestroyed()) target.webContents.send('berth:petState', snapshot);
  }, 60);
}
async function openPetWindow() {
  if (quitting) return;
  if (petWindow && !petWindow.isDestroyed()) { petWindow.showInactive(); keepPetAboveWindows(petWindow, pet.preferences.alwaysOnTop); return; }
  const width = Math.round(petWindowSize.width * pet.preferences.scale), height = Math.round(petWindowSize.height * pet.preferences.scale);
  let area = screen.getPrimaryDisplay().workArea, x = area.x + area.width - width - 20, y = area.y + area.height - height - 20;
  try {
    const saved = JSON.parse(readFileSync(path.join(dataDirectory, 'pet', 'position.json'), 'utf8'));
    if (Number.isSafeInteger(saved.x) && Number.isSafeInteger(saved.y)) { area = screen.getDisplayNearestPoint(saved).workArea; x = Math.min(Math.max(saved.x, area.x), area.x + area.width - width); y = Math.min(Math.max(saved.y, area.y), area.y + area.height - height); }
  } catch { /* First launch or unavailable monitor. */ }
  const target = new BrowserWindow({ x, y, width, height, resizable: false, frame: false, transparent: true, hasShadow: false, alwaysOnTop: pet.preferences.alwaysOnTop, skipTaskbar: true, show: false, title: 'AgentBerth · 桌宠', icon: iconFile, webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false } });
  petWindow = target;
  const keepAbove = () => keepPetAboveWindows(target, pet.preferences.alwaysOnTop);
  keepAbove();
  target.on('show', keepAbove);
  target.on('restore', keepAbove);
  target.on('blur', keepAbove);
  target.on('moved', () => { try { const { x, y } = target.getBounds(); writeFileSync(path.join(dataDirectory, 'pet', 'position.json'), JSON.stringify({ x, y }), { mode: 0o600 }); } catch { /* Position failure must not affect a terminal. */ } });
  target.setMenuBarVisibility(false);
  target.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  target.webContents.on('will-navigate', event => event.preventDefault());
  target.once('ready-to-show', () => { if (!quitting && pet.preferences.enabled) target.showInactive(); });
  target.on('closed', () => { if (petWindow === target) { petWindow = null; petDrag = null; } });
  try {
    if (process.env.AGENTBERTH_DEV_URL === 'http://127.0.0.1:5173') await target.loadURL(process.env.AGENTBERTH_DEV_URL + '?view=pet');
    else await target.loadFile(path.join(__dirname, 'renderer', 'index.html'), { query: { view: 'pet' } });
  } catch (error) { if (!target.isDestroyed()) target.destroy(); throw error; }
}
function petHookConfig(): string {
  const script = app.isPackaged ? path.join(resourceRoot, 'pet', 'pet-hook.cjs') : path.join(__dirname, 'pet-hook.cjs');
  return JSON.stringify(petHookConfiguration(process.execPath, script, dataDirectory), null, 2);
}
function petGuide(): string {
  const script = app.isPackaged ? path.join(resourceRoot, 'pet', 'pet-hook.cjs') : path.join(__dirname, 'pet-hook.cjs');
  return petHookSetupGuide(process.execPath, script, dataDirectory, process.platform, app.isPackaged ? path.join(resourceRoot, 'pet') : __dirname);
}
async function savePetPreferences(preferences: unknown) {
  pet.save(preferences);
  if (pet.preferences.enabled) {
    await openPetWindow(); if (petWindow) keepPetAboveWindows(petWindow, pet.preferences.alwaysOnTop);
    petWindow?.setSize(Math.round(petWindowSize.width * pet.preferences.scale), Math.round(petWindowSize.height * pet.preferences.scale));
    if (petWindow) { const bounds = petWindow.getBounds(), area = screen.getDisplayMatching(bounds).workArea; petWindow.setPosition(Math.round(Math.min(Math.max(bounds.x, area.x), area.x + area.width - bounds.width)), Math.round(Math.min(Math.max(bounds.y, area.y), area.y + area.height - bounds.height))); }
  } else petWindow?.close();
  return pet.snapshot();
}
function petNavigate(channel: 'berth:petSession' | 'berth:petSettings', id?: string) {
  showWindow();
  const send = () => window?.webContents.send(channel, id);
  if (window?.webContents.isLoadingMainFrame()) window.webContents.once('did-finish-load', send); else send();
}
function showPetSession() {
  const { sessions, preferences } = pet.snapshot();
  const id = sessions.find(session => session.sessionId === preferences.selectedSessionId)?.sessionId ?? sessions[0]?.sessionId;
  if (id) petNavigate('berth:petSession', id);
}
function openPetMenu() {
  if (!petWindow || petWindow.isDestroyed()) return;
  petDrag = null;
  const run = (action: () => unknown) => { void Promise.resolve().then(action).catch(error => dialog.showMessageBox({ type: 'error', title: '桌宠操作未完成', message: error instanceof Error ? error.message : String(error) })); };
  const change = (value: Partial<import('../shared/pet').PetPreferences>) => run(() => savePetPreferences({ ...pet.preferences, ...value }));
  Menu.buildFromTemplate(petMenuTemplate(pet.snapshot(), {
    select: selectedSessionId => change({ selectedSessionId }), scale: scale => change({ scale }),
    alwaysOnTop: alwaysOnTop => change({ alwaysOnTop }), autoSwitch: autoSwitch => change({ autoSwitch }),
    open: () => showPetSession(), settings: () => petNavigate('berth:petSettings'),
    copyGuide: () => clipboard.writeText(petGuide()), hide: () => change({ enabled: false }),
  })).popup({ window: petWindow });
}
ipcMain.handle('berth:pet', async (event, raw: unknown) => {
  if (![window, sshWindow, petWindow].some(target => target && !target.isDestroyed() && event.sender === target.webContents && event.senderFrame === target.webContents.mainFrame)) throw new Error('无权访问桌宠');
  if (quitting || !pet) throw new Error('应用尚未就绪');
  const request = petRequestSchema.parse(raw);
  if (['menu', 'dragStart', 'dragMove', 'dragEnd'].includes(request.action) && event.sender !== petWindow?.webContents) throw new Error('此操作仅供桌宠图像使用');
  switch (request.action) {
    case 'state': return pet.snapshot();
    case 'save': return savePetPreferences(request.preferences);
    case 'hookConfig': return petHookConfig();
    case 'hookGuide': return petGuide();
    case 'installHook': {
      trusted(event);
      let project: string | undefined;
      if (request.projectId) {
        if (connecting) await connecting;
        if (!connection) await reconnect();
        const state = await connection!.rpc<import('../shared/protocol').State>('state');
        project = state.projects.find(item => item.id === request.projectId)?.path;
        if (!project) throw new Error('项目不存在，请重新选择');
      }
      return installAgentHook({ provider: request.provider, project, version: request.opencodeVersion,
        executable: process.execPath, script: app.isPackaged ? path.join(resourceRoot, 'pet', 'pet-hook.cjs') : path.join(__dirname, 'pet-hook.cjs'),
        dataDirectory, pluginDirectory: app.isPackaged ? path.join(resourceRoot, 'pet') : __dirname });
    }
    case 'menu': openPetMenu(); return;
    case 'dragStart': {
      const cursor = screen.getCursorScreenPoint(), bounds = petWindow!.getBounds();
      petDrag = { x: cursor.x - bounds.x, y: cursor.y - bounds.y }; return;
    }
    case 'dragMove': {
      if (!petDrag) return;
      const cursor = screen.getCursorScreenPoint(), area = screen.getDisplayNearestPoint(cursor).workArea, bounds = petWindow!.getBounds();
      petWindow!.setPosition(Math.round(Math.max(area.x, Math.min(cursor.x - petDrag.x, area.x + area.width - bounds.width))), Math.round(Math.max(area.y, Math.min(cursor.y - petDrag.y, area.y + area.height - bounds.height)))); return;
    }
    case 'dragEnd': petDrag = null; return;
    case 'image': return pet.image(request.status);
    case 'resetImage': pet.resetImage(request.status); return pet.snapshot();
    case 'importImage': {
      const result = await dialog.showOpenDialog(BrowserWindow.fromWebContents(event.sender)!, { title: '选择此状态的 GIF 动画', properties: ['openFile'], filters: [{ name: 'GIF 动画', extensions: ['gif'] }] });
      if (result.canceled) return null;
      const file = result.filePaths[0];
      if (statSync(file).size > 8 * 1024 * 1024) throw new Error('GIF 不能超过 8 MiB');
      pet.importImage(request.status, readFileSync(file), file); return pet.snapshot();
    }
    case 'showSession': showPetSession(); return;
  }
});
function sshWindowState(): SshWindowState { return { detached: !!sshWindow && !sshWindow.isDestroyed(), sessionId: sshWindowSession }; }
function publishSshWindow() {
  const state = sshWindowState();
  for (const target of [window, sshWindow]) if (target && !target.isDestroyed()) target.webContents.send('berth:sshWindowState', state);
  return state;
}
async function openSshWindow() {
  if (sshWindow && !sshWindow.isDestroyed()) { if (sshWindow.isMinimized()) sshWindow.restore(); sshWindow.show(); sshWindow.focus(); return; }
  const target = new BrowserWindow({ width: 1100, height: 700, minWidth: 640, minHeight: 360, title: 'AgentBerth · SSH', icon: iconFile, show: false, backgroundColor: nativeTheme.shouldUseDarkColors ? '#212121' : '#ffffff', webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true } });
  sshWindow = target;
  publishSshWindow();
  target.once('ready-to-show', () => { if (!quitting) { target.show(); target.focus(); } });
  target.on('closed', () => { if (sshWindow === target) { sshWindow = null; publishSshWindow(); if (!quitting) showWindow(); } });
  try { await secureWindow(target, true); }
  catch (error) { if (!target.isDestroyed()) target.destroy(); throw error; }
}
function createWindow() {
  window = new BrowserWindow({ width: 1440, height: 940, minWidth: 1000, minHeight: 700, title: 'AgentBerth · 泊栈', icon: iconFile, show: false, backgroundColor: nativeTheme.shouldUseDarkColors ? '#212121' : '#ffffff', webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true } });
  window.once('ready-to-show',()=>{if(!quitting)window?.show();});
  window.on('close', event => { if (!quitReady) { event.preventDefault(); window?.hide(); } });
  window.on('closed', () => { window = null; });
  void secureWindow(window);
}

function trusted(event: Electron.IpcMainInvokeEvent): void {
  if (![window, sshWindow].some(target => target && !target.isDestroyed() && event.sender === target.webContents && event.senderFrame === target.webContents.mainFrame)) throw new Error('无权访问本地接口');
}
ipcMain.handle('berth:sshWindow', async (event, action: unknown, sessionId: unknown) => {
  trusted(event);
  if (quitting || typeof action !== 'string' || !['state','open','dock','select'].includes(action)) throw new Error('SSH 窗口操作无效');
  if (sessionId !== undefined && (typeof sessionId !== 'string' || (sessionId !== '' && !/^[a-f0-9-]{36}$/i.test(sessionId)))) throw new Error('SSH 会话无效');
  if (action === 'state') return sshWindowState();
  if (sessionId !== undefined) sshWindowSession = sessionId as string;
  if (action === 'open') await openSshWindow();
  if (action === 'dock') { sshWindow?.close(); showWindow(); }
  return publishSshWindow();
});
ipcMain.handle('berth:rpc', async (event, method: Method, params: Record<string, unknown>) => {
  trusted(event);
  if (quitting || method === 'shutdown' || method === 'shutdownIdle' || ['restoreWorkspace','registerSshProvider','sshChallengeReply','saveSshConnection','deleteSshConnection','remoteOpen','nativeSessionDetected'].includes(method)) throw new Error('请从托盘退出应用，或在设置中更新后台');
  const request = requestSchema.safeParse({ id: randomUUID(), method, params });
  if (!request.success) throw new Error('请求参数无效');
  if (connecting) await connecting;
  if (!connection) await reconnect();
  if (method === 'attach') return terminalSubscriptions.attach(event.sender.id, String(params.sessionId), () => !event.sender.isDestroyed());
  if (method === 'detach') return terminalSubscriptions.detach(event.sender.id, String(params.sessionId));
  if ((method === 'resize' || method === 'input') && remoteSessionIds.has(String(params.sessionId))) {
    const target = sshWindow ?? window;
    // Ignore already queued work from the previous viewport during a handoff.
    if (!target || event.sender !== target.webContents) return null;
  }
  if(method==='resources')return connection!.rpc(method,{appPids:[...new Set([process.pid,...app.getAppMetrics().map(item=>item.pid)])].filter(pid=>Number.isSafeInteger(pid)&&pid>0).slice(0,128)});
  if(method==='remoteTransferCancel')return connection!.rpc(method,{...request.data.params,owner:'user'});
  return connection!.rpc(method, request.data.params);
});
ipcMain.handle('berth:openSshConnection', async (event, alias: unknown) => {
  trusted(event);
  if (quitting || typeof alias !== 'string' || !alias || alias.length > 100) throw new Error('SSH 连接别名无效');
  if (connecting) await connecting;
  if (!connection) await reconnect();
  return connection!.rpc('remoteOpen', {alias, owner:'user'});
});
ipcMain.handle('berth:saveSshConnection', async (event, rawConfig: unknown, connectionId: unknown, rawSecret: unknown, remember: unknown) => {
  trusted(event);
  const config = sshConnectionSchema.safeParse(rawConfig), secret = sshSecretSchema.safeParse(rawSecret ?? {});
  if (!config.success || !secret.success || (connectionId !== undefined && (typeof connectionId !== 'string' || !/^[a-f0-9-]{36}$/.test(connectionId))) || typeof remember !== 'boolean') throw new Error('SSH 连接配置无效');
  if (!connection) await reconnect();
  const id = typeof connectionId === 'string' ? connectionId : randomUUID();
  const profiles = await connection!.rpc<import('../shared/protocol').SshConnection[]>('sshConnections');
  const previousProfile = profiles.find(profile => profile.id === id);
  const sameIdentity = previousProfile && previousProfile.hostname === config.data.hostname && previousProfile.port === config.data.port && previousProfile.username === config.data.username && previousProfile.authentication === config.data.authentication && previousProfile.privateKeyPath === config.data.privateKeyPath;
  const previous = sameIdentity ? sshVault.get(id) : {};
  const credentials = { ...previous, ...Object.fromEntries(Object.entries(secret.data).filter(([,value]) => value !== '')) };
  if (config.data.authentication === 'password' && !credentials.password) throw new Error('请输入此连接的登录密码；更换地址、用户名或登录方式后需重新输入');
  // Write secrets only after the daemon has accepted the public configuration.
  // Validate secure persistence before changing an existing public profile.
  if (remember && Object.values(credentials).some(Boolean) && (!safeStorage.isEncryptionAvailable() || (process.platform === 'linux' && safeStorage.getSelectedStorageBackend() === 'basic_text'))) throw new Error('系统安全凭据存储不可用，请取消记住密码');
  const profile = await connection!.rpc('saveSshConnection', {connectionId: id, config: config.data});
  sshVault.save(id, config.data.authentication === 'password' ? { password: credentials.password } : config.data.authentication === 'key' ? { passphrase: credentials.passphrase } : {}, remember);
  return profile;
});
ipcMain.handle('berth:deleteSshConnection', async (event, connectionId: unknown) => {
  trusted(event); if (typeof connectionId !== 'string') throw new Error('连接无效');
  if (!connection) await reconnect();
  await connection!.rpc('deleteSshConnection',{connectionId}); sshVault.delete(connectionId);
});
ipcMain.handle('berth:sshKey', async event => { trusted(event); const result = await dialog.showOpenDialog(BrowserWindow.fromWebContents(event.sender)!, {title:'选择 SSH 私钥文件',properties:['openFile']}); return result.canceled ? null : result.filePaths[0]; });
ipcMain.handle('berth:appearance',(event,mode:unknown)=>{trusted(event);if(typeof mode!=='string'||!['system','light','dark'].includes(mode))throw new Error('无效主题');nativeTheme.themeSource=mode as 'system'|'light'|'dark';for(const target of [window,sshWindow])target?.setBackgroundColor(nativeTheme.shouldUseDarkColors?'#212121':'#ffffff');});
nativeTheme.on('updated',()=>{for(const target of [window,sshWindow])target?.setBackgroundColor(nativeTheme.shouldUseDarkColors?'#212121':'#ffffff');});
ipcMain.handle('berth:mcpConfig', (event, provider: unknown = 'claude') => {
  trusted(event); if (provider !== 'claude' && provider !== 'opencode') throw new Error('不支持的 Agent 类型');
  const args = [app.isPackaged ? path.join(process.resourcesPath, 'mcp', 'mcp.cjs') : path.join(__dirname, 'mcp.cjs'), dataDirectory];
  return JSON.stringify(provider === 'opencode' ? { mcp: { agentberth: { type: 'local', command: [process.execPath, ...args], environment: { ELECTRON_RUN_AS_NODE: '1' }, enabled: true } } } : { mcpServers: { agentberth: { command: process.execPath, args, env: { ELECTRON_RUN_AS_NODE: '1' } } } }, null, 2);
});
const skillManager = new SkillManager();
ipcMain.handle('berth:skills', async (event, input: unknown) => {
  trusted(event);
  const request = skillRequestSchema.parse(input);
  let projectPath: string | undefined;
  let integration = ['claude', 'opencode'].includes(request.location.agentId) ? request.location.agentId as 'claude' | 'opencode' : undefined;
  let skills = builtinSkillProviders.find(agent => agent.id === request.location.agentId)?.skills;
  if (request.location.projectId || !skills) {
    if (connecting) await connecting;
    if (!connection) await reconnect();
    const state = await connection!.rpc<import('../shared/protocol').State>('state');
    const definition = (state.agents ?? []).find(agent => agent.id === request.location.agentId);
    if (!definition?.skills) integration ??= definition?.integration;
    skills ??= definition?.skills ?? builtinSkillProviders.find(agent => agent.id === definition?.integration)?.skills;
    projectPath = request.location.projectId ? state.projects.find(project => project.id === request.location.projectId)?.path : undefined;
    if (request.location.projectId && !projectPath) throw new Error('项目不存在，请重新选择');
  }
  if (!skills) throw new Error('此 Agent 尚未通过插件声明 Skill 管理能力，请更新同一个 Agent 配置或脚本');
  if (integration) skills = { ...skills, user: path.join(integrationRoot(integration), 'skills') };
  return skillManager.run(skillRoot(skills, projectPath), request);
});
ipcMain.handle('berth:directory', async event => { trusted(event); const result = await dialog.showOpenDialog(BrowserWindow.fromWebContents(event.sender)!, { properties: ['openDirectory'] }); return result.canceled ? null : result.filePaths[0]; });
ipcMain.handle('berth:transcript', async event => { trusted(event); const result = await dialog.showOpenDialog(BrowserWindow.fromWebContents(event.sender)!, { properties: ['openFile'], filters: [{ name: 'Agent 对话记录', extensions: ['jsonl', 'json'] }] }); return result.canceled ? null : result.filePaths[0]; });
ipcMain.handle('berth:executable', async event => { trusted(event); const result = await dialog.showOpenDialog(BrowserWindow.fromWebContents(event.sender)!, { properties: ['openFile'], ...(process.platform === 'win32' ? { filters: [{ name: '终端程序', extensions: ['exe'] }] } : {}) }); return result.canceled ? null : result.filePaths[0]; });
ipcMain.handle('berth:copy', async (event, text: string) => { trusted(event); if (typeof text !== 'string' || text.length > MAX_CLIPBOARD_TEXT) throw new Error('复制内容过长或格式无效'); await clipboard.writeText(text); });
ipcMain.handle('berth:clipboard', async event => { trusted(event); const text = await clipboard.readText(); if (text.length > MAX_PASTE_TEXT) throw new Error('剪贴板文字过长，请分段粘贴（每次最多 65536 个字符）'); return text; });
ipcMain.handle('berth:external', async (event, url: string) => { trusted(event); await shell.openExternal(externalWebUrl(url)); });
ipcMain.handle('berth:openProject', async (event, folder: string) => {
  trusted(event);
  if (!connection) await reconnect();
  const state = await connection!.rpc<any>('state');
  if (!state.projects.some((project: any) => project.path === folder)) throw new Error('只能打开已登记的项目目录');
  const error = await shell.openPath(folder);
  if (error) throw new Error(error);
});
ipcMain.handle('berth:reconnect', async event => { trusted(event); if (!connection) await reconnect(); });
ipcMain.handle('berth:restart', async event => {
  trusted(event);
  if (connecting) await connecting;
  restarting = true;
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  connecting = (async () => {
    await stopIdleDaemon(dataDirectory);
    connection?.close(true); connection = null;
    connection = await connectDaemon(dataDirectory, path.join(__dirname, 'daemon.cjs'), process.execPath, emit);
    await registerSshProvider();
    emit({ event: 'connection', data: { connected: true } });
    emit({ event: 'state', data: await connection.rpc('state') });
  })().finally(() => { connecting = null; restarting = false; });
  try { await connecting; }
  catch (error) { if (!connection?.connected) { connection = null; emit({ event: 'connection', data: { connected: false, error: String(error) } }); } throw error; }
});

ipcMain.handle('berth:importPlugin', async event => {
  trusted(event);
  if (quitting) throw new Error('应用正在退出');
  const result = await dialog.showOpenDialog(BrowserWindow.fromWebContents(event.sender)!, { title: '导入 Agent 配置或脚本', properties: ['openFile'], filters: [{ name: 'Agent 配置或脚本', extensions: ['json', 'cjs', 'mjs', 'js'] }] });
  return result.canceled ? null : installAgentFile(result.filePaths[0], dataDirectory, importingPlugins);
});
ipcMain.handle('berth:exportPluginKit', async event => {
  trusted(event);
  const result = await dialog.showOpenDialog(BrowserWindow.fromWebContents(event.sender)!, { title: '选择插件开发目录的保存位置', properties: ['openDirectory', 'createDirectory'] });
  return result.canceled ? null : exportPluginKit(result.filePaths[0], resourceRoot, path.join(resourceRoot, app.isPackaged ? 'plugin-kit' : 'dist', 'check-plugin.cjs'));
});
ipcMain.handle('berth:pluginPrompt', async (event, folder?: string) => {
  trusted(event);
  if (folder !== undefined && (typeof folder !== 'string' || folder.length > 4096 || /[\r\n\x00]/.test(folder))) throw new Error('插件目录无效');
  return developmentPrompt(readFileSync(path.join(resourceRoot, 'docs', 'AGENT_PLUGIN_DEVELOPMENT.md'), 'utf8'), folder);
});

ipcMain.handle('berth:appInfo', event => {
  trusted(event);
  return { version: app.getVersion(), platform: process.platform, arch: process.arch, osRelease: release(), electron: process.versions.electron, node: process.versions.node, packaged: app.isPackaged };
});
ipcMain.handle('berth:dataDirectory', async event => {
  trusted(event);
  const error = await shell.openPath(dataDirectory); if (error) throw new Error(error);
});
