import { useEffect, useRef, useState } from 'react';
import { resolveExtensionConfig, type ExtensionConfig, type ExtensionSnapshot } from '../shared/extensions';
import { ExtensionConfigFields } from './ExtensionConfigFields';
import { PluginSettingsPanel } from './PluginSettingsPanel';
import type { Project } from '../shared/protocol';

/** A small floating panel for editing a plugin's config without leaving the
 * current page. The plugin center keeps the full flow (dev docs, embedded
 * settings views); this covers the common "tweak a value and go back" case. */
export function PluginSettingsPopover({ request, snapshot, projects, currentProjectId, apiVersion, onError, onClose }: {
  request: { pluginId: string; isAgent: boolean };
  snapshot?: ExtensionSnapshot;
  projects: Project[]; currentProjectId?: string; apiVersion: number;
  onError: (error: string) => void; onClose: () => void;
}) {
  const plugin = snapshot?.plugins.find(item => item.manifest.id === request.pluginId);
  const [draft, setDraft] = useState<ExtensionConfig | null>(null);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [localError, setLocalError] = useState('');
  const panel = useRef<HTMLElement | null>(null);
  // Saving bumps the plugin generation to apply the new config. Resetting the
  // draft here would race with setSaved(true) and hide the "saved" feedback.
  useEffect(() => { setDraft(plugin ? resolveExtensionConfig(plugin.manifest, plugin.config) : null); setSaved(false); setLocalError(''); }, [plugin?.manifest.id]);
  useEffect(() => {
    if (!plugin) { onClose(); return; }
    const close = (event: PointerEvent) => { if (!panel.current?.contains(event.target as Node)) onClose(); };
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose(); };
    document.addEventListener('pointerdown', close);
    document.addEventListener('keydown', escape);
    return () => { document.removeEventListener('pointerdown', close); document.removeEventListener('keydown', escape); };
  }, [plugin, onClose]);
  if (!plugin || !draft) return null;
  const dirty = JSON.stringify(draft) !== JSON.stringify(resolveExtensionConfig(plugin.manifest, plugin.config));
  const save = async () => {
    setBusy(true); onError(''); setLocalError('');
    try {
      await window.berth.extensions({ action: 'configure', id: plugin.manifest.id, config: draft });
      setSaved(true);
    } catch (error) { setLocalError(String(error)); onError(String(error)); }
    finally { setBusy(false); }
  };
  return <section className="plugin-settings-popover" role="dialog" aria-label={'配置插件 · ' + plugin.manifest.name} ref={panel}>
    <header className="plugin-settings-head">
      <div><strong>配置 · {plugin.manifest.name}</strong><small>{request.isAgent ? 'Agent 接入' : '扩展插件'}</small></div>
      <button type="button" className="icon-button" aria-label="关闭配置面板" onClick={onClose}>×</button>
    </header>
    {localError && <p className="plugin-settings-error" role="alert">{localError}</p>}
    {plugin.manifest.id === 'pet'
      ? <div className="plugin-settings-form"><PluginSettingsPanel projects={projects} currentProjectId={currentProjectId} apiVersion={apiVersion} /></div>
      : <form className="plugin-settings-form" onSubmit={event => { event.preventDefault(); void save(); }}>
          <ExtensionConfigFields plugin={plugin} draft={draft} setDraft={setDraft} busy={busy} />
          <p className="form-hint">保存后会重新载入插件视图，请先保存正在编辑的内容。</p>
          <footer>
            <span role="status">{saved && !dirty ? '已保存，即时生效' : dirty ? '有未保存的修改' : '修改后保存即可生效'}</span>
            <div className="plugin-settings-actions">
              <button type="button" className="subtle" disabled={busy} onClick={onClose}>关闭</button>
              {dirty && <button type="submit" className="primary" disabled={busy}>保存配置</button>}
            </div>
          </footer>
        </form>}
  </section>;
}
