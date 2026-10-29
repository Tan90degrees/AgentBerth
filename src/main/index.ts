import { SkillManager, skillRoot } from './skills';
import { builtinSkillProviders, skillRequestSchema } from '../shared/skills';
import { SshVault } from './ssh-vault';
import { sshConnectionSchema, sshSecretSchema, type SshChallenge, type SshWindowState } from '../shared/protocol';
import { TerminalSubscriptions } from './terminal-subscriptions';
import { legacyProfile } from './profile';
import { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, nativeImage, nativeTheme, net, safeStorage, screen, shell, Tray } from 'electron';
import { AppUpdates } from './app-updates';
import { extractUpdate } from './update-extract';
import { cleanStorage, updateBoot, UpdateStore } from './update-files';
import type { AppUpdateState, UpdateResume, UpdateWindow } from '../shared/updates';
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
const boot = updateBoot();
const resourceRoot = boot?.resources ?? (app.isPackaged ? path.dirname(path.dirname(__dirname)) : path.join(__dirname, '..'));
const applicationVersion = boot?.version ?? JSON.parse(readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8')).version;
const iconFile = path.join(resourceRoot, 'assets', process.platform === 'win32' ? 'app.ico' : 'app.png');
if (!app.commandLine.hasSwitch('user-data-dir')) { const profile = legacyProfile(app.getPath('appData')); mkdirSync(profile, { recursive: true }); app.setPath('userData', profile); }
const dataDirectory = process.env.AGENTBERTH_DATA_DIR ?? path.join(app.getPath('userData'), 'data');
const updateStore = new UpdateStore(dataDirectory);
const appUpdates = new AppUpdates({ store: updateStore, version: applicationVersion, electron: process.versions.electron!, platform: process.platform, arch: process.arch, supported: app.isPackaged && process.platform === 'win32' && process.arch === 'x64', fetch: (url, options) => net.fetch(url, options), extract: extractUpdate, publish: publishUpdate });
const initialResume = boot?.resume ?? null;
let resumeStorage: Record<string,string> | null = initialResume?.storage ?? null;
const restoredKinds = new Set<string>();
let mainLoaded = false, backendSeen = false, bootConfirmed = false;
let backendUpdateTimer: NodeJS.Timeout | null = null;
let pendingSshChallenges = 0;
let applyingUpdate = false;
const sshVault = new SshVault(path.join(dataDirectory,'ssh-secrets.json'), safeStorage);
if (!path.isAbsolute(dataDirectory)) throw new Error('AGENTBERTH_DATA_DIR must be an absolute path');

if (!app.hasSingleInstanceLock() && !app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', showWindow);
  app.on('before-quit', event => { if (!quitReady) { event.preventDefault(); void quitApplication(); } });
  app.on('window-all-closed', () => { /* Tray keeps the workbench accessible. PTYs belong to the independent daemon. */ });
  app.on('activate', showWindow);
  void app.whenReady().then(async () => {
    mkdirSync(dataDirectory, { recursive: true, mode: 0o700 });
    if (process.platform === 'win32') app.setAppUserModelId('dev.agentberth.desktop');
    createWindow();
    if (initialResume?.ssh) { sshWindowSession = initialResume.sshSession; void openSshWindow(); }
    const icon = nativeImage.createFromPath(iconFile);
    if (icon.isEmpty()) throw new Error('应用图标资源未正确打包');
    tray = new Tray(iconFile);
    tray.setToolTip('AgentBerth · 会话后台运行');
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: '打开 AgentBerth', click: showWindow },
      { type: 'separator' },
      { label: '退出 AgentBerth（停止全部终端）', click: () => app.quit() },
    ]));
    tray.on('double-click', showWindow);
    try { await reconnect(); } catch (error) { emit({ event: 'connection', data: { connected: false, error: String(error) } }); }
    const check = async () => { if (appUpdates.state().automatic && !quitting) { const value = await appUpdates.check(); if (value.phase === 'available' && value.automatic) await appUpdates.download(); } };
    const initialCheck = setTimeout(() => void check(), 15000); initialCheck.unref();
    const checks = setInterval(() => void check(), 6 * 60 * 60 * 1000); checks.unref();
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
    await importingPlugins.close();
    if (connecting) await connecting.catch(() => {});
    await shutdownDaemon(dataDirectory);
    connection?.close(true); connection = null;
    quitReady = true; tray?.destroy(); tray = null;
    // All owned workers and the daemon are gone; renderer/debugger unload must not delay explicit quit.
    app.exit(0);
  })().catch(error => {
    console.error('AgentBerth 退出未完成：', error);
    quitting = false;
    importingPlugins = new AgentPlugins();
    tray?.setToolTip('AgentBerth · 退出失败，请重试');
    showWindow();
    dialog.showErrorBox('AgentBerth 退出未完成', `${String(error)}\n请再次从托盘选择退出，确保后台及全部终端停止。`);
  }).finally(() => { exitPromise = null; });
  return exitPromise;
}
async function answerSshChallenge(challenge: SshChallenge): Promise<void> {
  const provider = connection;
  if (!provider) return;
  pendingSshChallenges++;
  try {
    if (challenge.kind === 'credentials') {
      await provider.rpc('sshChallengeReply', { challengeId: challenge.id, secret: sshVault.get(challenge.connectionId) });
    } else {
      showWindow();
      const result = await dialog.showMessageBox(window!, { type: 'question', title: '确认 SSH 服务器', message: `首次连接 ${challenge.alias}`, detail: `${challenge.hostname}:${challenge.port}\n主机指纹：${challenge.fingerprint}\n请与服务器管理员提供的指纹核对。信任后将为此连接记住指纹。`, buttons: ['取消连接','信任并连接'], defaultId: 0, cancelId: 0, noLink: true });
      await provider.rpc('sshChallengeReply', { challengeId: challenge.id, accepted: result.response === 1 });
    }
  } catch { await provider.rpc('sshChallengeReply', { challengeId: challenge.id, accepted: false }).catch(() => {}); }
  finally { pendingSshChallenges--; }
}
async function registerSshProvider(): Promise<void> {
  const state = await connection!.rpc<import('../shared/protocol').State>('state');
  if (state.apiVersion >= 22) await connection!.rpc('registerSshProvider');
}
function emit(event: ServerEvent) {
  if (event.event === 'sshChallenge') { void answerSshChallenge(event.data); return; }
  if (event.event === 'state') { remoteSessionIds = new Set(event.data.sessions.filter(session => session.remote).map(session => session.id)); backendSeen = true; confirmUpdateBoot(); scheduleBackendUpdate(); }
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
  const resume = initialResume?.ssh && !restoredKinds.has('ssh') ? initialResume.ssh : null;
  if (resume) restoreWindow(target, resume);
  publishSshWindow();
  target.once('ready-to-show', () => showUpdatedWindow(target, resume, true));
  target.on('closed', () => { if (sshWindow === target) { sshWindow = null; publishSshWindow(); if (!quitting) showWindow(); } });
  try { await secureWindow(target, true); }
  catch (error) { if (!target.isDestroyed()) target.destroy(); throw error; }
}
function createWindow() {
  window = new BrowserWindow({ width: 1440, height: 940, minWidth: 1000, minHeight: 700, title: 'AgentBerth · 泊栈', icon: iconFile, show: false, backgroundColor: nativeTheme.shouldUseDarkColors ? '#212121' : '#ffffff', webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true } });
  const resume = initialResume?.main && !restoredKinds.has('main') ? initialResume.main : null;
  if (resume) restoreWindow(window, resume);
  window.once('ready-to-show',()=>{if(window)showUpdatedWindow(window,resume,false);});
  window.on('close', event => { if (!quitReady) { event.preventDefault(); window?.hide(); } });
  window.on('closed', () => { window = null; });
  void secureWindow(window);
}

function trusted(event: Electron.IpcMainInvokeEvent | Electron.IpcMainEvent): void {
  if (![window, sshWindow].some(target => target && !target.isDestroyed() && event.sender === target.webContents && event.senderFrame === target.webContents.mainFrame)) throw new Error('无权访问本地接口');
}
function publishUpdate(value: AppUpdateState) { for (const target of [window, sshWindow]) if (target && !target.isDestroyed()) target.webContents.send('berth:updates', value); }
function captureWindow(target: BrowserWindow | null): UpdateWindow | null { return target && !target.isDestroyed() ? { bounds: target.getNormalBounds(), maximized: target.isMaximized(), minimized: target.isMinimized(), visible: target.isVisible() } : null; }
function restoreWindow(target: BrowserWindow, saved: UpdateWindow) {
  const b = saved?.bounds;
  if (!b || ![b.x,b.y,b.width,b.height].every(Number.isFinite) || b.width < 100 || b.height < 100 || b.width > 20000 || b.height > 20000) return;
  const visible = screen.getAllDisplays().some(({ workArea: a }) => b.x + b.width > a.x + 40 && b.y + b.height > a.y + 40 && b.x < a.x + a.width - 40 && b.y < a.y + a.height - 40);
  target.setBounds(visible ? b : { width: b.width, height: b.height });
}
function showUpdatedWindow(target: BrowserWindow, saved: UpdateWindow | null, detached: boolean) {
  if (quitting) return;
  if (saved?.maximized) target.maximize();
  if (saved?.visible !== false) { if (saved && detached) target.showInactive(); else target.show(); }
  if (saved?.minimized) target.minimize();
}
function confirmUpdateBoot() {
  if (bootConfirmed || !mainLoaded || !backendSeen) return;
  bootConfirmed = true;
  const state = updateStore.read(); if (state.pending || state.resume) updateStore.confirm();
  scheduleBackendUpdate();
}
function scheduleBackendUpdate(delay = 1000) {
  if (!bootConfirmed || quitting || backendUpdateTimer || !updateStore.read().backendPending) return;
  backendUpdateTimer = setTimeout(async () => {
    backendUpdateTimer = null;
    if (quitting || !connection?.connected || !updateStore.read().backendPending) return;
    if (connecting || restarting) { scheduleBackendUpdate(1000); return; }
    try {
      const state = await connection.rpc<import('../shared/protocol').State>('state');
      if (state.sessions.some(s => ['running','stopping'].includes(s.latestRun?.status ?? ''))) return;
      await restartBackend(); appUpdates.backendApplied();
    } catch { scheduleBackendUpdate(30000); }
  }, delay); backendUpdateTimer.unref();
}
ipcMain.on('berth:updatePreferences', event => {
  try {
    trusted(event); const kind = event.sender === sshWindow?.webContents ? 'ssh' : 'main';
    event.returnValue = !restoredKinds.has(kind) && resumeStorage && (kind === 'main' || initialResume?.ssh) ? cleanStorage(resumeStorage) : null;
    restoredKinds.add(kind);
    if (restoredKinds.has('main') && (!initialResume?.ssh || restoredKinds.has('ssh'))) resumeStorage = null;
  } catch { event.returnValue = null; }
});
ipcMain.handle('berth:updateReady', event => { trusted(event); if (event.sender === window?.webContents) { mainLoaded = true; confirmUpdateBoot(); } });
ipcMain.handle('berth:updates', async (event, request: unknown) => {
  trusted(event);
  if (!request || typeof request !== 'object' || !('action' in request) || typeof request.action !== 'string' || !['state','check','download','cancel','apply','automatic'].includes(request.action)) throw new Error('更新操作无效');
  const args = request as { action: string; automatic?: unknown; storage?: unknown };
  if (args.action === 'state') return appUpdates.state();
  if (quitting || applyingUpdate) throw new Error('应用正在退出或更新');
  if (args.action === 'check') return appUpdates.check();
  if (args.action === 'download') return appUpdates.download();
  if (args.action === 'cancel') return appUpdates.cancel();
  if (args.action === 'automatic') { if (typeof args.automatic !== 'boolean') throw new Error('更新设置无效'); return appUpdates.automatic(args.automatic); }
  applyingUpdate = true;
  try {
    if (pendingSshChallenges) throw new Error('请先完成 SSH 登录或指纹确认，再应用更新');
    const storage = cleanStorage(args.storage);
    if (connecting) await connecting;
    if (!connection?.connected) throw new Error('请恢复后台连接后再应用更新');
    const state = await connection.rpc<import('../shared/protocol').State>('state');
    const active = state.sessions.some(s => ['running','stopping'].includes(s.latestRun?.status ?? ''));
    if (appUpdates.needsIdleBackend(state.apiVersion) && active) throw new Error('此版本需要同时更新后台，请等终端结束后应用，更新包已保留。');
    const resume: UpdateResume = { storage, main: captureWindow(window), ssh: captureWindow(sshWindow), sshSession: sshWindowSession };
    let activated = false;
    try {
      await importingPlugins.close();
      if (pendingSshChallenges) throw new Error('请先完成 SSH 登录或指纹确认，再应用更新');
      if (appUpdates.needsIdleBackend(state.apiVersion)) { restarting = true; await stopIdleDaemon(dataDirectory); connection.close(true); connection = null; }
      appUpdates.prepare(resume, { apiVersion: state.apiVersion, active }); activated = true;
      // This is a UI relaunch only. The normal tray Quit path still shuts down
      // the daemon; update never calls shutdownDaemon for live terminals.
      quitting = true; quitReady = true;
      if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
      if (backendUpdateTimer) { clearTimeout(backendUpdateTimer); backendUpdateTimer = null; }
      connection?.close(true); connection = null;
      app.relaunch(); tray?.destroy(); tray = null;
      setTimeout(() => app.exit(0), 80);
      return appUpdates.state();
    } catch (error) {
      if (activated) { updateStore.rollback('应用更新未完成，原版本仍在运行。'); appUpdates.applyFailed(); }
      quitting = false; quitReady = false; restarting = false; importingPlugins = new AgentPlugins();
      if (!connection?.connected) void reconnect().catch(() => {});
      throw error;
    }
  } finally { applyingUpdate = false; }
});
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
  if (quitting || method === 'shutdown' || method === 'shutdownIdle' || ['registerSshProvider','sshChallengeReply','saveSshConnection','deleteSshConnection','remoteOpen'].includes(method)) throw new Error('请从托盘退出应用，或在设置中更新后台');
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
ipcMain.handle('berth:mcpConfig', event => { trusted(event); return JSON.stringify({ mcpServers: { agentberth: { command: process.execPath, args: [app.isPackaged ? path.join(process.resourcesPath, 'mcp', 'mcp.cjs') : path.join(__dirname, 'mcp.cjs'), dataDirectory], env: { ELECTRON_RUN_AS_NODE: '1' } } } }, null, 2); });
const skillManager = new SkillManager();
ipcMain.handle('berth:skills', async (event, input: unknown) => {
  trusted(event);
  const request = skillRequestSchema.parse(input);
  let projectPath: string | undefined;
  let skills = builtinSkillProviders.find(agent => agent.id === request.location.agentId)?.skills;
  if (request.location.projectId || !skills) {
    if (connecting) await connecting;
    if (!connection) await reconnect();
    const state = await connection!.rpc<import('../shared/protocol').State>('state');
    skills ??= (state.agents ?? []).find(agent => agent.id === request.location.agentId)?.skills;
    projectPath = request.location.projectId ? state.projects.find(project => project.id === request.location.projectId)?.path : undefined;
    if (request.location.projectId && !projectPath) throw new Error('项目不存在，请重新选择');
  }
  if (!skills) throw new Error('此 Agent 尚未通过插件声明 Skill 管理能力，请更新同一个 Agent 配置或脚本');
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
  await restartBackend(); appUpdates.backendApplied();
});
async function restartBackend(): Promise<void> {
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
}

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
  return { version: applicationVersion, platform: process.platform, arch: process.arch, osRelease: release(), electron: process.versions.electron, node: process.versions.node, packaged: app.isPackaged };
});
ipcMain.handle('berth:dataDirectory', async event => {
  trusted(event);
  const error = await shell.openPath(dataDirectory); if (error) throw new Error(error);
});
