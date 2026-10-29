import type { MenuItemConstructorOptions } from 'electron';
import { petLabels, petScales, type PetSnapshot } from '../shared/pet';

export interface PetMenuActions {
  select(id: string): void; scale(value: number): void;
  alwaysOnTop(value: boolean): void; autoSwitch(value: boolean): void;
  open(): void; settings(): void; copyGuide(): void; hide(): void;
}

export function petMenuTemplate(snapshot: PetSnapshot, actions: PetMenuActions): MenuItemConstructorOptions[] {
  const { sessions, preferences } = snapshot;
  const selected = sessions.find(session => session.sessionId === preferences.selectedSessionId) ?? sessions[0];
  const label = (value: string) => value.replace(/[\r\n]/g, ' ').replaceAll('&', '&&');
  const scales = [...new Set<number>([...petScales, preferences.scale])].sort((a, b) => a - b);
  return [
    { label: selected ? label(`${selected.title} · ${petLabels[selected.status]}`) : '暂无 Agent 会话', enabled: false },
    { type: 'separator' },
    { label: '打开当前会话', enabled: !!selected, click: () => actions.open() },
    { label: '切换 Agent 会话', enabled: sessions.length > 0, submenu: sessions.map(session => ({ id: session.sessionId, label: label(`${session.project} / ${session.title} · ${petLabels[session.status]}`), type: 'radio', checked: session.sessionId === selected?.sessionId, click: () => actions.select(session.sessionId) })) },
    { label: '桌宠大小', submenu: scales.map(scale => ({ label: `${Math.round(scale * 100)}%`, type: 'radio', checked: preferences.scale === scale, click: () => actions.scale(scale) })) },
    { label: '保持置顶', type: 'checkbox', checked: preferences.alwaysOnTop, click: item => actions.alwaysOnTop(item.checked) },
    { label: '自动关注待处理会话', type: 'checkbox', checked: preferences.autoSwitch, click: item => actions.autoSwitch(item.checked) },
    { type: 'separator' },
    { label: '复制 hook 自动配置教程', click: () => actions.copyGuide() },
    { label: '桌宠设置…', click: () => actions.settings() },
    { label: '隐藏桌宠', click: () => actions.hide() },
  ];
}
