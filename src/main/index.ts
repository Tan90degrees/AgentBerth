import { SshVault } from './ssh-vault';
import { sshConnectionSchema, sshSecretSchema, type SshChallenge } from '../shared/protocol';
import { legacyProfile } from './profile';
import { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, nativeImage, nativeTheme, safeStorage, shell, Tray } from 'electron';
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
let tray: Tray | null = null;
let connection: DaemonConnection | null = null;
let connecting: Promise<void> | null = null;
let quitting = false;
let quitReady = false;
let exitPromise: Promise<void> | null = null;
let reconnectTimer: NodeJS.Timeout | null = null;
let restarting = false;
let importingPlugins = new AgentPlugins();
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
    createWindow();
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
  });
}

function refreshWindow() { if (connection?.connected && !quitting) emit({ event: 'connection', data: { connected: true } }); }
function showWindow() { if (!window) createWindow(); window?.show(); window?.focus(); refreshWindow(); }
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
  if (event.event === 'sshChallenge') { void answerSshChallenge(event.data); return; }
  if (window && !window.isDestroyed() && ((event.event !== 'output' && event.event !== 'resize') || (window.isVisible() && !window.isMinimized()))) window.webContents.send('berth:event', event);
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
function createWindow() {
  window = new BrowserWindow({ width: 1440, height: 940, minWidth: 1000, minHeight: 700, title: 'AgentBerth · 泊栈', icon: iconFile, show: false, backgroundColor: nativeTheme.shouldUseDarkColors ? '#212121' : '#ffffff', webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true } });
  window.once('ready-to-show',()=>{if(!quitting)window?.show();});
  window.setMenuBarVisibility(false);
  window.on('close', event => { if (!quitReady) { event.preventDefault(); window?.hide(); } });
  window.on('restore', refreshWindow);
  window.on('closed', () => { window = null; });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', event => { event.preventDefault(); });
  window.webContents.on('did-finish-load', () => { if (connection) { emit({ event: 'connection', data: { connected: true } }); void connection.rpc('state').then(data => emit({ event: 'state', data: data as any })); } });
  const developmentUrl = process.env.AGENTBERTH_DEV_URL;
  if (developmentUrl === 'http://127.0.0.1:5173') void window.loadURL(developmentUrl);
  else void window.loadFile(path.join(__dirname, 'renderer', 'index.html'));
}

function trusted(event: Electron.IpcMainInvokeEvent): void {
  if (!window || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame) throw new Error('无权访问本地接口');
}
ipcMain.handle('berth:rpc', async (event, method: Method, params: Record<string, unknown>) => {
  trusted(event);
  if (quitting || method === 'shutdown' || method === 'shutdownIdle' || ['registerSshProvider','sshChallengeReply','saveSshConnection','deleteSshConnection','remoteOpen'].includes(method)) throw new Error('请从托盘退出应用，或在设置中更新后台');
  const request = requestSchema.safeParse({ id: randomUUID(), method, params });
  if (!request.success) throw new Error('请求参数无效');
  if (connecting) await connecting;
  if (!connection) await reconnect();
  if(method==='resources')return connection!.rpc(method,{appPids:[...new Set([process.pid,...app.getAppMetrics().map(item=>item.pid)])].filter(pid=>Number.isSafeInteger(pid)&&pid>0).slice(0,128)});
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
ipcMain.handle('berth:sshKey', async event => { trusted(event); const result = await dialog.showOpenDialog(window!, {title:'选择 SSH 私钥文件',properties:['openFile']}); return result.canceled ? null : result.filePaths[0]; });
ipcMain.handle('berth:appearance',(event,mode:unknown)=>{trusted(event);if(typeof mode!=='string'||!['system','light','dark'].includes(mode))throw new Error('无效主题');nativeTheme.themeSource=mode as 'system'|'light'|'dark';window?.setBackgroundColor(nativeTheme.shouldUseDarkColors?'#212121':'#ffffff');});
nativeTheme.on('updated',()=>{window?.setBackgroundColor(nativeTheme.shouldUseDarkColors?'#212121':'#ffffff');});
ipcMain.handle('berth:mcpConfig', event => { trusted(event); return JSON.stringify({ mcpServers: { agentberth: { command: process.execPath, args: [app.isPackaged ? path.join(process.resourcesPath, 'mcp', 'mcp.cjs') : path.join(__dirname, 'mcp.cjs'), dataDirectory], env: { ELECTRON_RUN_AS_NODE: '1' } } } }, null, 2); });
ipcMain.handle('berth:directory', async event => { trusted(event); const result = await dialog.showOpenDialog(window!, { properties: ['openDirectory'] }); return result.canceled ? null : result.filePaths[0]; });
ipcMain.handle('berth:transcript', async event => { trusted(event); const result = await dialog.showOpenDialog(window!, { properties: ['openFile'], filters: [{ name: 'Agent 对话记录', extensions: ['jsonl', 'json'] }] }); return result.canceled ? null : result.filePaths[0]; });
ipcMain.handle('berth:executable', async event => { trusted(event); const result = await dialog.showOpenDialog(window!, { properties: ['openFile'], ...(process.platform === 'win32' ? { filters: [{ name: '终端程序', extensions: ['exe'] }] } : {}) }); return result.canceled ? null : result.filePaths[0]; });
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
  const result = await dialog.showOpenDialog(window!, { title: '导入 Agent 配置或脚本', properties: ['openFile'], filters: [{ name: 'Agent 配置或脚本', extensions: ['json', 'cjs', 'mjs', 'js'] }] });
  return result.canceled ? null : installAgentFile(result.filePaths[0], dataDirectory, importingPlugins);
});
ipcMain.handle('berth:exportPluginKit', async event => {
  trusted(event);
  const result = await dialog.showOpenDialog(window!, { title: '选择插件开发目录的保存位置', properties: ['openDirectory', 'createDirectory'] });
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
