import { settingsSchema, type Settings } from '../shared/protocol';

type ReadableStorage = Pick<Storage, 'getItem'>;
type WritableStorage = Pick<Storage, 'setItem' | 'removeItem'>;
export function readStored(key: string, storage?: ReadableStorage): string | null {
  try { return (storage ?? globalThis.localStorage)?.getItem(key) ?? null; } catch { return null; }
}
export function saveStored(key: string, value: string | null, storage?: WritableStorage): void {
  try { const target = storage ?? globalThis.localStorage; if (value === null) target?.removeItem(key); else target?.setItem(key, value); } catch { /* A full/unavailable cache must not interrupt the workbench. */ }
}
function readJson(key: string, storage?: ReadableStorage): unknown {
  try { const text = readStored(key, storage); return text && text.length < 1024 * 1024 ? JSON.parse(text) : null; } catch { return null; }
}
export function loadSelections(storage?: ReadableStorage): Record<string, string> {
  const value = readJson('berth.selections', storage);
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
  return Object.fromEntries(Object.entries(value).filter(([key, id]) => uuid.test(key) && typeof id === 'string' && uuid.test(id)).slice(0, 200));
}
export interface SettingsDraft { base: Settings; value: Settings }
export function loadSettingsDraft(storage?: ReadableStorage): SettingsDraft | null {
  const value = readJson('berth.settingsDraft', storage);
  if (!value || typeof value !== 'object' || !('base' in value) || !('value' in value)) return null;
  const base = settingsSchema.safeParse(value.base), draft = settingsSchema.safeParse(value.value);
  return base.success && draft.success ? { base: base.data, value: draft.data } : null;
}
