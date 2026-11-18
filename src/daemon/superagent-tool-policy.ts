// ACP agents run in their own process. This policy governs tools requested
// through the desktop host and approval granted by the desktop.
const reviewableKinds = new Set(['read', 'search', 'edit']);
const executionFields = new Set(['command', 'commands', 'cmd', 'shell', 'script', 'executable', 'argv']);
const executionTitle = /\b(shell|bash|zsh|powershell|pwsh|cmd\.exe|terminal|execute|delete|remove)\b|执行命令|运行命令|删除/i;

export function reviewableSuperagentTool(tool: unknown): boolean {
  if (!tool || typeof tool !== 'object') return false;
  const {kind,title,rawInput} = tool as {kind?: unknown; title?: unknown; rawInput?: unknown};
  if (typeof kind !== 'string' || !reviewableKinds.has(kind) || typeof title !== 'string' || executionTitle.test(title)) return false;
  if (rawInput === undefined || rawInput === null) return true;
  if (typeof rawInput !== 'object' || Array.isArray(rawInput)) return false;

  const inputs: unknown[] = [rawInput];
  for (let inspected=0; inputs.length; inspected++) {
    const input = inputs.pop();
    if (inspected >= 256) return false;
    if (!input || typeof input !== 'object') continue;
    for (const [key,value] of Object.entries(input)) {
      if (executionFields.has(key.toLowerCase())) return false;
      if (value && typeof value === 'object') inputs.push(value);
    }
  }
  return true;
}
