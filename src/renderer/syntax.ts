import hljs from 'highlight.js/lib/common';
import powershell from 'highlight.js/lib/languages/powershell';
import cmake from 'highlight.js/lib/languages/cmake';
import makefile from 'highlight.js/lib/languages/makefile';

hljs.registerLanguage('powershell', powershell);
hljs.registerLanguage('cmake', cmake);
hljs.registerLanguage('makefile', makefile);
export function highlightCode(text: string, language: string): string {
  if (language !== 'plaintext' && hljs.getLanguage(language)) {
    try { return hljs.highlight(text, { language, ignoreIllegals: true }).value; } catch { /* Keep unknown syntax readable. */ }
  }
  return text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;');
}
