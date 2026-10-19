export const previewFonts = [
  { id: 'auto', name: '默认（代码等宽）', family: '"Cascadia Mono", "Cascadia Code", Consolas, "SFMono-Regular", "Noto Sans Mono CJK SC", monospace' },
  { id: 'consolas', name: 'Consolas', family: 'Consolas, monospace' },
  { id: 'cascadia', name: 'Cascadia Code', family: '"Cascadia Code", "Cascadia Mono", monospace' },
  { id: 'jetbrains', name: 'JetBrains Mono', family: '"JetBrains Mono", monospace' },
  { id: 'fira', name: 'Fira Code', family: '"Fira Code", monospace' },
  { id: 'system', name: '系统字体', family: '"Segoe UI", "Microsoft YaHei", "Noto Sans CJK SC", sans-serif' },
  { id: 'custom', name: '自定义字体', family: 'monospace' },
] as const;
export interface PreviewAppearance { size: number; font: string; customFont: string }
export const defaultPreviewAppearance: PreviewAppearance = { size: 13, font: 'auto', customFont: '' };
export function normalizePreviewAppearance(value: unknown): PreviewAppearance {
  const data = value && typeof value === 'object' ? value as Partial<PreviewAppearance> : {};
  return { size: typeof data.size === 'number' && Number.isFinite(data.size) ? Math.max(10, Math.min(28, Math.round(data.size))) : 13,
    font: previewFonts.some(item => item.id === data.font) ? data.font! : 'auto',
    customFont: typeof data.customFont === 'string' ? data.customFont.replace(/[\x00-\x1f]/g, '').slice(0, 100) : '' };
}
export function previewFontFamily(value: PreviewAppearance): string {
  if (value.font === 'custom' && value.customFont.trim()) return `${JSON.stringify(value.customFont.trim())}, monospace`;
  return previewFonts.find(item => item.id === value.font)?.family ?? previewFonts[0].family;
}
