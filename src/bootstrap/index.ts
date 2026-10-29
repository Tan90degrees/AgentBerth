import { app } from 'electron';
import path from 'node:path';
import { readFileSync, mkdirSync } from 'node:fs';
import { legacyProfile } from '../main/profile';
import { UpdateStore, selectUpdate, setUpdateBoot } from '../main/update-files';

if (!app.commandLine.hasSwitch('user-data-dir')) { const profile = legacyProfile(app.getPath('appData')); mkdirSync(profile, { recursive: true }); app.setPath('userData', profile); }
if (!app.requestSingleInstanceLock()) app.exit(0);
else {
  const baseResources = app.isPackaged ? process.resourcesPath : path.join(__dirname, '..');
  const version = JSON.parse(readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8')).version;
  const dataDirectory = process.env.AGENTBERTH_DATA_DIR ?? path.join(app.getPath('userData'), 'data');
  const store = new UpdateStore(dataDirectory);
  let selected: { version: string; root: string } | null = null;
  if (app.isPackaged && process.platform === 'win32') selected = selectUpdate(store, version, { electron: process.versions.electron!, platform: process.platform, arch: process.arch });
  const state = store.read();
  setUpdateBoot({ baseResources, resources: selected?.root ?? baseResources, version: selected?.version ?? version, dataDirectory, resume: state.resume, pending: !!selected && state.pending });
  try { require(selected ? path.join(selected.root, 'app.asar', 'dist', 'main.cjs') : path.join(__dirname, 'main.cjs')); }
  catch (error) {
    if (!selected) throw error;
    store.rollback('新版本启动失败，已恢复上一个版本。'); app.relaunch(); app.exit(1);
  }
  if (selected && state.pending) void app.whenReady().then(() => {
    const watchdog = setTimeout(() => { const current = store.read(); if (current.pending && current.active === selected!.version) { store.rollback('新界面启动未完成，已恢复上一个版本。'); app.relaunch(); app.exit(1); } }, 30000);
    watchdog.unref();
  });
}
