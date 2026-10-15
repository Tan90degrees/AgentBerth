import { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, nativeImage, shell, Tray } from 'electron';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { connectDaemon, shutdownDaemon, stopIdleDaemon, type DaemonConnection } from './connection';
import { requestSchema, type Method, type ServerEvent } from '../shared/protocol';
import { installPluginManifest, exportPluginKit, developmentPrompt } from './plugin-files';
import { externalWebUrl, MAX_CLIPBOARD_TEXT, MAX_PASTE_TEXT } from '../shared/desktop';

let window: BrowserWindow | null = null;
let tray: Tray | null = null;
let connection: DaemonConnection | null = null;
let connecting: Promise<void> | null = null;
let quitting = false;
let quitReady = false;
let exitPromise: Promise<void> | null = null;
let reconnectTimer: NodeJS.Timeout | null = null;
let restarting = false;
const dataDirectory = process.env.AGENTBERTH_DATA_DIR ?? path.join(app.getPath('userData'), 'data');
if (!path.isAbsolute(dataDirectory)) throw new Error('AGENTBERTH_DATA_DIR must be an absolute path');

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', showWindow);
  app.on('before-quit', event => { if (!quitReady) { event.preventDefault(); void quitApplication(); } });
  app.on('window-all-closed', () => { /* Tray keeps the workbench accessible. PTYs belong to the independent daemon. */ });
  app.on('activate', showWindow);
  void app.whenReady().then(async () => {
    mkdirSync(dataDirectory, { recursive: true, mode: 0o700 });
    createWindow();
    const icon = nativeImage.createFromDataURL('data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAABZElEQVQ4T6WTwU0DMRBF32ZHKAHQAU4JdIAOQAEUgFIACaAFUEJIAZQAOgAJgBLg9ziLkYy87IaFdj+f7DcznjF4FNdIkjIcOyfhaNdI79dpZaVFA+RY/yKRWNh6jDE6SEeMQmlTlziVDFURuoRTFvAaGVklMSLHMoBuDUf/hghbwDl4lNpRmJruSYMi6opGGmAUcAHUaFoBXAD1JuIWwDsQMEL4CAxAfcSBgBoKYKkoNbSAXuCrNo2VnrGTs3tuPdPMNMUgLTkJNAO2B7MACszBdt/kys/oHhAdllvqZmMS/zlgBuRPqs7VnxCuDV8KdPB9lvOrOBLcCvrtycTdYL3EErCvIF/Vsbs5+btxMEk40UqZM/l66OAh6EMWfEcVS/wWcZPgZwOWABbALbsVCyluFwoc1HUAJUJqb+RJtgezFRRnsvTHm35J9xmEnwj/jWsCV76nh2TS/eVyEpMv/POLSR4UzNwv8mr0sw1UtvEb/J/AcPtOgwdjrfAAAAAElFTkSuQmCC');
    tray = new Tray(icon);
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
    if (connecting) await connecting.catch(() => {});
    await shutdownDaemon(dataDirectory);
    connection?.close(true); connection = null;
    quitReady = true; tray?.destroy(); tray = null;
    app.quit();
  })().catch(error => {
    quitting = false;
    tray?.setToolTip('AgentBerth · 退出失败，请重试');
    showWindow();
    dialog.showErrorBox('AgentBerth 退出未完成', `${String(error)}\n请再次从托盘选择退出，确保后台及全部终端停止。`);
  }).finally(() => { exitPromise = null; });
  return exitPromise;
}
function emit(event: ServerEvent) {
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
    emit({ event: 'connection', data: { connected: true } });
    emit({ event: 'state', data: await connection.rpc('state') });
  })().finally(() => { connecting = null; });
  return connecting;
}
function createWindow() {
  window = new BrowserWindow({ width: 1440, height: 940, minWidth: 1000, minHeight: 700, title: 'AgentBerth · 泊栈', backgroundColor: '#0d1119', webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true } });
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
  if (quitting || method === 'shutdown' || method === 'shutdownIdle') throw new Error('请从托盘退出应用，或在设置中更新后台');
  const request = requestSchema.safeParse({ id: randomUUID(), method, params });
  if (!request.success) throw new Error('请求参数无效');
  if (connecting) await connecting;
  if (!connection) await reconnect();
  return connection!.rpc(method, request.data.params);
});
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
    emit({ event: 'connection', data: { connected: true } });
    emit({ event: 'state', data: await connection.rpc('state') });
  })().finally(() => { connecting = null; restarting = false; });
  try { await connecting; }
  catch (error) { if (!connection?.connected) { connection = null; emit({ event: 'connection', data: { connected: false, error: String(error) } }); } throw error; }
});

const resourceRoot = app.isPackaged ? process.resourcesPath : path.join(__dirname, '..');
ipcMain.handle('berth:importPlugin', async event => {
  trusted(event);
  const result = await dialog.showOpenDialog(window!, { title: '选择插件文件 agentberth-plugin.json', properties: ['openFile'], filters: [{ name: 'AgentBerth 插件', extensions: ['json'] }] });
  return result.canceled ? null : installPluginManifest(result.filePaths[0], dataDirectory);
});
ipcMain.handle('berth:exportPluginKit', async event => {
  trusted(event);
  const result = await dialog.showOpenDialog(window!, { title: '选择插件开发目录的保存位置', properties: ['openDirectory', 'createDirectory'] });
  return result.canceled ? null : exportPluginKit(result.filePaths[0], resourceRoot);
});
ipcMain.handle('berth:pluginPrompt', async (event, folder?: string) => {
  trusted(event);
  if (folder !== undefined && (typeof folder !== 'string' || folder.length > 4096 || /[\r\n\x00]/.test(folder))) throw new Error('插件目录无效');
  return developmentPrompt(readFileSync(path.join(resourceRoot, 'docs', 'AGENT_PLUGIN_DEVELOPMENT.md'), 'utf8'), folder);
});
