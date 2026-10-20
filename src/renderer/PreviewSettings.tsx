import { useEffect, useState } from 'react';
import { defaultPreviewAppearance, normalizePreviewAppearance, previewFonts } from '../shared/preview-appearance';
import { previewStyle, setPreviewAppearance, usePreviewAppearance } from './preview-settings';

export function PreviewSettings() {
  const value = usePreviewAppearance();
  const [sizeInput, setSizeInput] = useState(String(value.size));
  useEffect(() => setSizeInput(String(value.size)), [value.size]);
  const commitSize = () => {
    const next = normalizePreviewAppearance({ ...value, size: sizeInput ? Number(sizeInput) : value.size });
    setSizeInput(String(next.size)); setPreviewAppearance(next);
  };
  return <section className="settings-card preview-settings" aria-label="文件预览设置">
    <h2>文件预览</h2><p className="form-hint">统一用于所有项目的源码、Markdown 和 Git 差异。立即生效，自动保存。</p>
    <label>预览字体<select aria-label="预览字体" value={value.font} onChange={event => setPreviewAppearance({ ...value, font: event.target.value })}>{previewFonts.map(font => <option key={font.id} value={font.id}>{font.name}</option>)}</select></label>
    {value.font === 'custom' && <label>字体名称<input aria-label="自定义预览字体" maxLength={100} placeholder="例如 Sarasa Mono SC" value={value.customFont} onChange={event => setPreviewAppearance({ ...value, customFont: event.target.value })} /></label>}
    <label>预览字号<div className="preview-size-control"><button type="button" aria-label="减小预览字号" disabled={value.size <= 10} onClick={() => setPreviewAppearance({ ...value, size: value.size - 1 })}>−</button><input aria-label="预览字号" type="number" min="10" max="28" value={sizeInput} onBlur={commitSize} onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); commitSize(); } }} onChange={event => { setSizeInput(event.target.value); const size = Number(event.target.value); if (event.target.value && size >= 10 && size <= 28) setPreviewAppearance({ ...value, size }); }} /><span>px</span><button type="button" aria-label="增大预览字号" disabled={value.size >= 28} onClick={() => setPreviewAppearance({ ...value, size: value.size + 1 })}>＋</button></div></label>
    <p className="preview-font-sample" style={previewStyle(value)}>const ready = true; // 文件预览示例</p>
    <p className="form-hint">字体使用本机安装，未安装时自动回退。终端字号独立设置。</p>
    <button type="button" className="subtle" onClick={() => setPreviewAppearance({ ...defaultPreviewAppearance })}>恢复默认预览字体</button>
  </section>;
}
