import type { TerminalConfig } from '../shared/protocol';
import { terminalNames } from './labels';

export function TerminalFields({ value, onChange, platform, inherit = false, disabled = false }: {
  value: TerminalConfig | null; onChange: (value: TerminalConfig | null) => void; platform: string; inherit?: boolean; disabled?: boolean;
}) {
  const label = inherit ? '会话终端' : '默认终端';
  return <>
    <label>{label}<select aria-label={label} value={value?.profile ?? 'inherit'} disabled={disabled} onChange={event => onChange(event.target.value === 'inherit' ? null : { profile: event.target.value as TerminalConfig['profile'], executable: '', args: [] })}>
      {inherit && <option value="inherit">跟随默认终端</option>}
      {Object.entries(terminalNames).filter(([profile]) => platform === 'win32' || !['powershell', 'cmd'].includes(profile)).map(([profile, name]) => <option key={profile} value={profile}>{name}</option>)}
    </select></label>
    {value?.profile === 'custom' && <>
      <label>终端程序<div className="input-with-button"><input aria-label="终端程序" required maxLength={4096} value={value.executable} disabled={disabled} onChange={event => onChange({ ...value, executable: event.target.value })} placeholder={platform === 'win32' ? 'C:\\Program Files\\PowerShell\\7\\pwsh.exe' : '/bin/zsh'} /><button type="button" className="subtle" disabled={disabled} onClick={() => void window.berth.chooseExecutable().then(file => { if (file) onChange({ ...value, executable: file }); }).catch(() => {})}>选择程序</button></div></label>
      <label>启动参数<textarea aria-label="启动参数" rows={3} value={value.args.join('\n')} disabled={disabled} onChange={event => onChange({ ...value, args: event.target.value.split('\n') })} placeholder="每行一个参数，例如 -NoLogo 和 -NoExit" /></label>
      <p className="form-hint">程序路径直接填写，无需引号。参数每行一个，路径中的空格会完整保留；终端程序中不要填写 Agent 命令。</p>
    </>}
  </>;
}
