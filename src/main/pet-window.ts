import type { BrowserWindow } from 'electron';

// Keep the transparent companion above ordinary dialogs without activating it.
// Never show a hidden window here: hiding is an explicit user action.
export function keepPetAboveWindows(target: BrowserWindow, enabled: boolean) {
  if (target.isDestroyed()) return;
  target.setAlwaysOnTop(enabled, enabled ? 'screen-saver' : 'normal');
  if (enabled && target.isVisible() && !target.isMinimized()) target.moveTop();
}
