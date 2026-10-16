import { contextBridge, ipcRenderer } from 'electron';
import type { DesktopApi, ServerEvent } from '../shared/protocol';

const api: DesktopApi = {
  setAppearance: mode => ipcRenderer.invoke('berth:appearance', mode),
  appInfo: () => ipcRenderer.invoke('berth:appInfo'),
  openDataDirectory: () => ipcRenderer.invoke('berth:dataDirectory'),
  rpc: (method, params = {}) => ipcRenderer.invoke('berth:rpc', method, params),
  onEvent: listener => {
    const callback = (_event: Electron.IpcRendererEvent, message: ServerEvent) => listener(message);
    ipcRenderer.on('berth:event', callback);
    return () => ipcRenderer.removeListener('berth:event', callback);
  },
  chooseDirectory: () => ipcRenderer.invoke('berth:directory'),
  chooseTranscript: () => ipcRenderer.invoke('berth:transcript'),
  importAgentPlugin: () => ipcRenderer.invoke('berth:importPlugin'),
  exportPluginKit: () => ipcRenderer.invoke('berth:exportPluginKit'),
  pluginDevelopmentPrompt: folder => ipcRenderer.invoke('berth:pluginPrompt', folder),
  chooseExecutable: () => ipcRenderer.invoke('berth:executable'),
  copyText: text => ipcRenderer.invoke('berth:copy', text),
  readClipboard: () => ipcRenderer.invoke('berth:clipboard'),
  openExternal: url => ipcRenderer.invoke('berth:external', url),
  openProject: folder => ipcRenderer.invoke('berth:openProject', folder),
  reconnect: () => ipcRenderer.invoke('berth:reconnect'),
  restartBackend: () => ipcRenderer.invoke('berth:restart'),
};
contextBridge.exposeInMainWorld('berth', api);
