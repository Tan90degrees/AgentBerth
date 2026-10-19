import { syntaxLanguages } from './syntax-languages';
const languages: Record<string, string> = {
  js: 'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript', ts: 'typescript', tsx: 'typescript',
  py: 'python', pyw: 'python', rb: 'ruby', rs: 'rust', go: 'go', java: 'java', kt: 'kotlin', kts: 'kotlin',
  cu: 'cpp', cuh: 'cpp', csproj: 'xml', fsproj: 'xml', props: 'xml', vue: 'xml', svelte: 'xml', ipynb: 'json', tf: 'plaintext',
  c: 'c', h: 'c', cc: 'cpp', cpp: 'cpp', cxx: 'cpp', hpp: 'cpp', cs: 'csharp', swift: 'swift',
  json: 'json', jsonc: 'javascript', yaml: 'yaml', yml: 'yaml', toml: 'ini', ini: 'ini', conf: 'ini',
  md: 'markdown', markdown: 'markdown', mdx: 'markdown', html: 'xml', htm: 'xml', xml: 'xml', svg: 'xml',
  css: 'css', scss: 'scss', less: 'less', sql: 'sql', graphql: 'graphql', gql: 'graphql',
  sh: 'bash', bash: 'bash', zsh: 'bash', fish: 'bash', ps1: 'powershell', psm1: 'powershell', psd1: 'powershell',
  bat: 'dos', cmd: 'dos', diff: 'diff', patch: 'diff', lua: 'lua', php: 'php', r: 'r', cmake: 'cmake',
};
const aliases = new Map<string, string>(syntaxLanguages.flatMap(item => [item.id, ...item.aliases].map(alias => [alias.toLowerCase(), item.id] as [string, string])));
export function fileLanguage(filename: string, content = ''): string {
  const name = filename.split(/[\\/]/).at(-1)?.toLowerCase() ?? '';
  if (/^dockerfile(?:\.|$)/.test(name)) return 'dockerfile';
  if (name === 'makefile' || name === 'gnumakefile') return 'makefile';
  if (/^(?:nginx\.conf|nginx\.conf\..*)$/.test(name)) return 'nginx';
  if (/^(?:\.gitignore|\.gitattributes|\.editorconfig|\.npmrc|\.yarnrc)$/.test(name)) return 'ini';
  if (name === 'cmakelists.txt') return 'cmake';
  if (/^\.env(?:\.|$)/.test(name)) return 'ini';
  const extension = name.split('.').at(-1) ?? '';
  if (languages[extension] || aliases.has(extension)) return languages[extension] ?? aliases.get(extension)!;
  const interpreter = /^#![^\n]*?\b(python[23]?|node|ruby|perl|php|bash|sh|zsh|fish|pwsh)\b/.exec(content.slice(0, 200))?.[1];
  return interpreter ? ({ node: 'javascript', pwsh: 'powershell', sh: 'bash', zsh: 'bash', fish: 'bash', python3: 'python', python2: 'python' } as Record<string, string>)[interpreter] ?? interpreter : 'plaintext';
}
export const isMarkdown = (filename: string) => /\.(?:md|markdown|mdown)$/i.test(filename);
export function fileSize(bytes: number): string {
  return bytes < 1024 ? `${bytes} B` : bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
export function previewLink(current: string, href: string): { path: string; anchor: string } | null {
  if (/^[a-z][a-z\d+.-]*:/i.test(href) || href.startsWith('//') || /[\x00-\x1f\\]/.test(href)) return null;
  const hash = href.indexOf('#');
  let name: string, anchor: string;
  try { name = decodeURIComponent((hash < 0 ? href : href.slice(0, hash)).split('?')[0]); anchor = hash < 0 ? '' : decodeURIComponent(href.slice(hash + 1)); }
  catch { return null; }
  if (/[\x00-\x1f\\]/.test(name)) return null;
  const parts = name.startsWith('/') ? [] : current.split('/').slice(0, -1);
  if (!name) return { path: current, anchor };
  for (const part of name.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') { if (!parts.length) return null; parts.pop(); }
    else { if (part.includes(':')) return null; parts.push(part); }
  }
  return parts.length ? { path: parts.join('/'), anchor } : null;
}
