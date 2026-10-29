/** Explicit shell choice makes paths with spaces work under Windows Git Bash as well. */
export function petHookConfiguration(executable: string, script: string, directory: string, platform = process.platform) {
  const quoteSh = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
  const quotePs = (value: string) => "'" + value.replaceAll("'", "''") + "'";
  const command = platform === 'win32'
    ? `$env:ELECTRON_RUN_AS_NODE='1'; $input | & ${quotePs(executable)} ${quotePs(script)} --data-dir ${quotePs(directory)}; exit 0`
    : `ELECTRON_RUN_AS_NODE=1 ${quoteSh(executable)} ${quoteSh(script)} --data-dir ${quoteSh(directory)}`;
  const handler = { type: 'command', command, timeout: 3, onFailure: 'continue', ...(platform === 'win32' ? { shell: 'powershell' } : {}) };
  return { hooks: Object.fromEntries(['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'PermissionRequest', 'Notification', 'Stop', 'StopFailure', 'SessionEnd'].map(event => [event, [{ hooks: [handler] }]])) };
}
