import { contextBridge, ipcRenderer } from 'electron';
import type { DesktopApi, ServerEvent, SshWindowState } from '../shared/protocol';

const api: DesktopApi = {
  pet: request => ipcRenderer.invoke('berth:pet', request),
  onPet: listener => {
    const callback = (_event: Electron.IpcRendererEvent, state: import('../shared/pet').PetSnapshot) => listener(state);
    ipcRenderer.on('berth:petState', callback);
    return () => ipcRenderer.removeListener('berth:petState', callback);
  },
  onPetSession: listener => {
    const callback = (_event: Electron.IpcRendererEvent, id: string) => listener(id);
    ipcRenderer.on('berth:petSession', callback);
    return () => ipcRenderer.removeListener('berth:petSession', callback);
  },
  sshWindow: (action, sessionId) => ipcRenderer.invoke('berth:sshWindow', action, sessionId),
  onSshWindow: listener => {
    const callback = (_event: Electron.IpcRendererEvent, state: SshWindowState) => listener(state);
    ipcRenderer.on('berth:sshWindowState', callback);
    return () => ipcRenderer.removeListener('berth:sshWindowState', callback);
  },
  openSshConnection: alias => ipcRenderer.invoke('berth:openSshConnection', alias),
  saveSshConnection: (config, id, secret = {}, remember = false) => ipcRenderer.invoke('berth:saveSshConnection', config, id, secret, remember),
  deleteSshConnection: id => ipcRenderer.invoke('berth:deleteSshConnection', id),
  chooseSshKey: () => ipcRenderer.invoke('berth:sshKey'),
  setAppearance: mode => ipcRenderer.invoke('berth:appearance', mode),
  mcpConfig: () => ipcRenderer.invoke('berth:mcpConfig'),
  appInfo: () => ipcRenderer.invoke('berth:appInfo'),
  openDataDirectory: () => ipcRenderer.invoke('berth:dataDirectory'),
  rpc: (method, params = {}) => ipcRenderer.invoke('berth:rpc', method, params),
  onEvent: listener => {
    const callback = (_event: Electron.IpcRendererEvent, message: ServerEvent) => listener(message);
    ipcRenderer.on('berth:event', callback);
    return () => ipcRenderer.removeListener('berth:event', callback);
  },
  skills: request => ipcRenderer.invoke('berth:skills', request),
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
