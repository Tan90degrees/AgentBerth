import hljs from 'highlight.js';

export function highlightCode(text: string, language: string): string {
  try {
    if (language === 'auto') { const detected = hljs.highlightAuto(text.slice(0, 8000)).language; if (detected) return hljs.highlight(text, { language: detected, ignoreIllegals: true }).value; }
    if (language !== 'plaintext' && hljs.getLanguage(language)) return hljs.highlight(text, { language, ignoreIllegals: true }).value;
  } catch { /* Keep invalid/unknown syntax readable and inert. */ }
  return text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;');
}
