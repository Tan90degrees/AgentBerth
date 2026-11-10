import { HarnessSettings } from '../plugins/deepseek-harness/Settings';
import type { ExtensionConfig, ExtensionInfo } from '../shared/extensions';

/** The plugin config form shared by the plugin center dialog and the in-page
 * settings popover, so both always render identical fields. */
export function ExtensionConfigFields({ plugin, draft, setDraft, busy }: {
  plugin: ExtensionInfo; draft: ExtensionConfig; setDraft: (value: ExtensionConfig) => void; busy: boolean;
}) {
  if (plugin.manifest.id === 'deepseek-harness') return <HarnessSettings value={draft} onChange={setDraft} disabled={busy} />;
  return <>{Object.entries(plugin.manifest.config).map(([key, field]) => <label key={key}>{field.title}
    {field.type === 'boolean'
      ? <input disabled={busy} aria-label={plugin.manifest.name + ' ' + field.title} type="checkbox" checked={!!draft[key]} onChange={event => setDraft({ ...draft, [key]: event.target.checked })} />
      : field.enum
        ? <select disabled={busy} aria-label={plugin.manifest.name + ' ' + field.title} value={String(draft[key] ?? '')} onChange={event => setDraft({ ...draft, [key]: event.target.value })}>{field.enum.map(value => <option key={value} value={value}>{value}</option>)}</select>
        : <input disabled={busy} aria-label={plugin.manifest.name + ' ' + field.title} type={field.type === 'number' ? 'number' : 'text'} min={field.minimum} max={field.maximum} value={draft[key] as string | number ?? ''} onChange={event => setDraft({ ...draft, [key]: field.type === 'number' ? Number(event.target.value) : event.target.value })} />}
    {field.description && <small>{field.description}</small>}
  </label>)}</>;
}
