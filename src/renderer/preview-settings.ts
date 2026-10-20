import { useSyncExternalStore, type CSSProperties } from 'react';
import { defaultPreviewAppearance, normalizePreviewAppearance, previewFontFamily, type PreviewAppearance } from '../shared/preview-appearance';
import { readStored, saveStored } from './storage';

const key = 'berth.previewAppearance';
function load(): PreviewAppearance {
  try { return normalizePreviewAppearance(JSON.parse(readStored(key) ?? 'null')); }
  catch { return { ...defaultPreviewAppearance }; }
}
let value = load();
const listeners = new Set<() => void>();
const changed = (event: StorageEvent) => { if (event.key === key || event.key === null) { value = load(); for (const notify of listeners) notify(); } };
function subscribe(listener: () => void) {
  if (!listeners.size) value = load();
  listeners.add(listener);
  if (listeners.size === 1) window.addEventListener('storage', changed);
  return () => { listeners.delete(listener); if (!listeners.size) window.removeEventListener('storage', changed); };
}
export function setPreviewAppearance(next: PreviewAppearance) {
  value = normalizePreviewAppearance(next);
  saveStored(key, JSON.stringify(value));
  for (const notify of listeners) notify();
}
export const usePreviewAppearance = () => useSyncExternalStore(subscribe, () => value);
export function previewStyle(value: PreviewAppearance): CSSProperties {
  const fontFamily = previewFontFamily(value);
  return { '--preview-font-size': `${value.size}px`, '--preview-font-family': fontFamily,
    '--preview-document-font': value.font === 'auto' ? '"Segoe UI", "Microsoft YaHei", "Noto Sans CJK SC", sans-serif' : fontFamily } as CSSProperties;
}
