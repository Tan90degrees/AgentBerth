import { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, shell, Tray } from 'electron';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { connectDaemon, stopIdleDaemon, type DaemonConnection } from './connection';
import { requestSchema, type Method, type ServerEvent } from '../shared/protocol';

let window: BrowserWindow | null = null;
let tray: Tray | null = null;
let connection: DaemonConnection | null = null;
let connecting: Promise<void> | null = null;
let quitting = false;
let reconnectTimer: NodeJS.Timeout | null = null;
let restarting = false;
const dataDirectory = process.env.AGENTBERTH_DATA_DIR ?? path.join(app.getPath('userData'), 'data');
if (!path.isAbsolute(dataDirectory)) throw new Error('AGENTBERTH_DATA_DIR must be an absolute path');

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', showWindow);
  app.on('before-quit', () => { quitting = true; if (reconnectTimer) clearTimeout(reconnectTimer); connection?.close(); });
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
      { label: '退出工作台（终端继续运行）', click: () => app.quit() },
    ]));
    tray.on('double-click', showWindow);
    try { await reconnect(); } catch (error) { emit({ event: 'connection', data: { connected: false, error: String(error) } }); }
  });
}

function showWindow() { if (!window) createWindow(); window?.show(); window?.focus(); }
function emit(event: ServerEvent) {
  if (window && !window.isDestroyed()) window.webContents.send('berth:event', event);
  if (event.event === 'connection' && !event.data.connected && !quitting && !restarting) {
    connection = null;
    if (!reconnectTimer) reconnectTimer = setTimeout(() => { reconnectTimer = null; void reconnect().catch(error => emit({ event: 'connection', data: { connected: false, error: String(error) } })); }, 2000);
  }
}
async function reconnect(): Promise<void> {
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
  window.on('close', event => { if (!quitting) { event.preventDefault(); window?.hide(); } });
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
  const request = requestSchema.safeParse({ id: randomUUID(), method, params });
  if (!request.success) throw new Error('请求参数无效');
  if (connecting) await connecting;
  if (!connection) await reconnect();
  return connection!.rpc(method, request.data.params);
});
ipcMain.handle('berth:directory', async event => { trusted(event); const result = await dialog.showOpenDialog(window!, { properties: ['openDirectory'] }); return result.canceled ? null : result.filePaths[0]; });
ipcMain.handle('berth:transcript', async event => { trusted(event); const result = await dialog.showOpenDialog(window!, { properties: ['openFile'], filters: [{ name: 'Agent 对话记录', extensions: ['jsonl', 'json'] }] }); return result.canceled ? null : result.filePaths[0]; });
ipcMain.handle('berth:executable', async event => { trusted(event); const result = await dialog.showOpenDialog(window!, { properties: ['openFile'], ...(process.platform === 'win32' ? { filters: [{ name: '终端程序', extensions: ['exe'] }] } : {}) }); return result.canceled ? null : result.filePaths[0]; });
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
