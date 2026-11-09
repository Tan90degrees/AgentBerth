import { createHash } from 'node:crypto';
import { dump, load, JSON_SCHEMA } from 'js-yaml';
import type { PageKind, SourceEvidence, SourceExcerpt, WikiDraft, WikiLint, WikiPage, WikiSkill, WikiSource } from './types';

export const PAGE_KINDS: PageKind[] = ['concept', 'entity', 'source', 'comparison', 'overview', 'note'];
export const SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** Slugs stay readable in both Chinese and English and are safe as filenames. */
export function slugify(value: string): string {
  const cleaned = String(value ?? '').trim().toLowerCase()
    .replace(/\[\[|\]\]/g, '')
    .replace(/[^0-9a-z\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af._-]+/g, '-')
    .replace(/[-_]{2,}/g, '-')
    // `store.file()` rejects any name containing '..'; normalise here too so a
    // model-produced slug can never make publishing fail with "名称无效".
    .replace(/\.{2,}/g, '.')
    .replace(/^[-_.]+|[-_.]+$/g, '');
  const slug = (cleaned || 'untitled').slice(0, 80).replace(/[.]+$/, '');
  return /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(slug) ? 'page-' + slug : slug;
}

export function parseDocument(text: string): { data: Record<string, unknown>; body: string } {
  const match = /^\uFEFF?---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(String(text ?? ''));
  if (!match) return { data: {}, body: String(text ?? '').replace(/^\uFEFF/, '') };
  let data: Record<string, unknown> = {};
  try {
    const value = load(match[1], { schema: JSON_SCHEMA });
    if (value && typeof value === 'object' && !Array.isArray(value)) data = value as Record<string, unknown>;
  } catch { /* A malformed header must not make the note unreadable. */ }
  // stringifyDocument separates the header and body with a blank line; drop
  // exactly that separator so parse → stringify is byte-stable.
  return { data, body: String(text ?? '').slice(match[0].length).replace(/^\r?\n/, '') };
}

export function stringifyDocument(data: Record<string, unknown>, body: string): string {
  const header = dump(data, { schema: JSON_SCHEMA, noRefs: true, sortKeys: false, lineWidth: -1 }).trimEnd();
  return `---\n${header}\n---\n\n${String(body ?? '')}`;
}

const stringList = (value: unknown): string[] => Array.isArray(value)
  ? value.filter((item): item is string => typeof item === 'string').slice(0, 100)
  : typeof value === 'string' && value.trim() ? [value] : [];

/** A compiled claim is only as trustworthy as the raw text behind it. Quotes
 * are checked against the immutable source before they are ever stored. */
const compact = (value: string): string => String(value ?? '').replace(/\s+/g, '');
/** A one-character "quote" matches almost any source and proves nothing. */
const MIN_QUOTE_CHARS = 8;

export function evidenceList(value: unknown, sourceText?: string, allowed?: Set<string>): SourceEvidence[] {
  if (!Array.isArray(value)) return [];
  const haystack = sourceText ? compact(sourceText) : '';
  const out: SourceEvidence[] = [];
  for (const item of value.slice(0, 20)) {
    if (!item || typeof item !== 'object') continue;
    const row = item as Record<string, unknown>;
    const quote = typeof row.quote === 'string' ? row.quote.trim().slice(0, 300) : '';
    const sourceId = typeof row.sourceId === 'string' ? row.sourceId.slice(0, 100) : '';
    if (compact(quote).length < MIN_QUOTE_CHARS) continue;
    if (allowed && sourceId && !allowed.has(sourceId)) continue;
    if (sourceText !== undefined && !haystack.includes(compact(quote))) continue;
    out.push({ sourceId, quote });
  }
  return out.slice(0, 20);
}

function findSpan(text: string, quote: string): { start: number; end: number } {
  const direct = text.indexOf(quote);
  if (direct >= 0) return { start: direct, end: direct + quote.length };
  const needle = compact(quote);
  if (!needle) return { start: -1, end: -1 };
  const positions: number[] = [];
  for (let i = 0; i < text.length; i++) if (!/\s/.test(text[i])) positions.push(i);
  const at = compact(text).indexOf(needle);
  if (at < 0 || positions[at] === undefined) return { start: -1, end: -1 };
  return { start: positions[at], end: (positions[at + needle.length - 1] ?? positions[at]) + 1 };
}

export function sourceExcerpt(source: Pick<WikiSource, 'id' | 'title' | 'text'>, quote: string): SourceExcerpt {
  const text = String(source.text ?? '');
  const { start, end } = findSpan(text, quote);
  const base: SourceExcerpt = { sourceId: source.id, title: source.title, quote, context: '', verified: compact(quote).length >= MIN_QUOTE_CHARS && start >= 0 };
  if (start < 0) return base;
  const from = Math.max(0, start - 180), to = Math.min(text.length, end + 180);
  return { ...base, context: (from > 0 ? '…' : '') + text.slice(from, to) + (to < text.length ? '…' : '') };
}

/** Local fallback when a page has no model-supplied quotes: pick the source
 * passage sharing the most tokens with the page body. It never invents text. */
export function bestExcerpt(source: Pick<WikiSource, 'id' | 'title' | 'text'>, pageBody: string): SourceExcerpt {
  const text = String(source.text ?? '');
  const words = tokens(pageBody);
  const chunks = text.split(/\n\s*\n|\n/).map(value => value.trim()).filter(value => compact(value).length >= MIN_QUOTE_CHARS).slice(0, 200);
  let best = '', score = 0;
  for (const chunk of chunks) {
    const lower = chunk.toLowerCase();
    const hits = words.reduce((total, word) => total + (lower.includes(word) ? 1 : 0), 0);
    if (hits > score) { score = hits; best = chunk; }
  }
  return sourceExcerpt(source, best ? best.slice(0, 300) : '');
}

export function resolveExcerpts(page: WikiPage, sources: WikiSource[], limit = 6): SourceExcerpt[] {
  const byId = new Map(sources.map(source => [source.id, source]));
  const out: SourceExcerpt[] = [];
  for (const item of page.evidence) {
    if (out.length >= limit) break;
    const source = byId.get(item.sourceId);
    if (!source) continue;
    const excerpt = sourceExcerpt(source, item.quote);
    if (excerpt.verified && !out.some(value => value.sourceId === excerpt.sourceId && value.quote === excerpt.quote)) out.push(excerpt);
  }
  for (const id of page.sources) {
    if (out.length >= limit) break;
    if (out.some(value => value.sourceId === id)) continue;
    const source = byId.get(id);
    if (source) { const excerpt = bestExcerpt(source, page.body); if (excerpt.verified) out.push(excerpt); }
  }
  return out.map(item => ({ ...item, quote: truncate(item.quote, 400), context: truncate(item.context, 1200) }));
}

/** Short context window around the first query hit, used by MCP search results. */
export function snippet(text: string, query: string, max = 360): string {
  const value = String(text ?? '').replace(/\s+/g, ' ').trim();
  const lower = value.toLowerCase();
  let at = -1;
  for (const word of tokens(query)) {
    const found = lower.indexOf(word);
    if (found >= 0 && (at < 0 || found < at)) at = found;
  }
  const from = Math.max(0, at - 80);
  return (from > 0 ? '…' : '') + value.slice(from, Math.min(value.length, from + max)) + (from + max < value.length ? '…' : '');
}

export function pageFromDocument(slug: string, text: string, fallbackTime: string): WikiPage {
  const { data, body } = parseDocument(text);
  const title = typeof data.title === 'string' && data.title.trim() ? data.title : slug;
  const kind = PAGE_KINDS.includes(data.kind as PageKind) ? data.kind as PageKind : 'note';
  const page: WikiPage = {
    slug, title, summary: typeof data.summary === 'string' ? data.summary : '',
    kind, sources: stringList(data.sources), evidence: evidenceList(data.evidence), tags: stringList(data.tags), body,
    humanEdited: data.humanEdited === true,
    hash: typeof data.hash === 'string' ? data.hash : '',
    createdAt: typeof data.createdAt === 'string' ? data.createdAt : fallbackTime,
    updatedAt: typeof data.updatedAt === 'string' ? data.updatedAt : fallbackTime,
  };
  return page;
}

export function pageToDocument(page: WikiPage): string {
  return stringifyDocument({
    title: page.title, summary: page.summary, kind: page.kind,
    sources: page.sources, evidence: page.evidence, tags: page.tags, humanEdited: page.humanEdited,
    hash: page.hash, createdAt: page.createdAt, updatedAt: page.updatedAt,
  }, page.body);
}

export function pageHash(page: Pick<WikiPage, 'title' | 'summary' | 'body' | 'sources' | 'evidence' | 'kind' | 'tags'>): string {
  return createHash('sha256').update(JSON.stringify([page.title, page.summary, page.body, page.sources, page.evidence, page.kind, page.tags])).digest('hex').slice(0, 32);
}

export function extractLinks(body: string): string[] {
  const links = new Set<string>();
  for (const match of String(body ?? '').matchAll(/\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|[^\]]*)?\]\]/g)) {
    const slug = slugify(match[1]);
    if (slug && slug !== 'untitled') links.add(slug);
  }
  return [...links];
}

export function backlinks(pages: WikiPage[]): Map<string, string[]> {
  const result = new Map<string, string[]>(pages.map(page => [page.slug, []]));
  for (const page of pages) for (const target of extractLinks(page.body)) {
    const list = result.get(target);
    if (list && !list.includes(page.slug)) list.push(page.slug);
  }
  return result;
}

/** Keyword scoring with a small link-graph boost. No embeddings by design:
 * Karpathy's index.md routing is enough at ~100 sources / hundreds of pages. */
function tokens(query: string): string[] {
  const text = String(query ?? '').toLowerCase();
  const ascii = text.match(/[a-z0-9][a-z0-9_.-]{1,}/g) ?? [];
  const cjk = text.match(/[\u4e00-\u9fff]+/g) ?? [];
  const grams: string[] = [];
  for (const run of cjk) {
    if (run.length === 1) grams.push(run);
    for (let i = 0; i + 1 < run.length; i++) grams.push(run.slice(i, i + 2));
  }
  return [...new Set([...ascii, ...grams])].filter(Boolean).slice(0, 64);
}

export function searchPages(query: string, pages: WikiPage[], limit = 8): WikiPage[] {
  const words = tokens(query);
  if (!words.length) return pages.slice().sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, limit);
  const inbound = backlinks(pages);
  const scored = pages.map(page => {
    const title = page.title.toLowerCase(), summary = page.summary.toLowerCase(), body = page.body.toLowerCase(), tags = page.tags.join(' ').toLowerCase();
    let score = 0;
    for (const word of words) {
      if (title.includes(word)) score += 8;
      if (summary.includes(word)) score += 4;
      if (tags.includes(word)) score += 3;
      const hits = body.split(word).length - 1;
      score += Math.min(hits, 6) * 1.5;
    }
    if (score > 0) score += Math.min((inbound.get(page.slug)?.length ?? 0), 8) * 0.4;
    return { page, score };
  }).filter(item => item.score > 0).sort((a, b) => b.score - a.score || b.page.updatedAt.localeCompare(a.page.updatedAt));
  return scored.slice(0, limit).map(item => item.page);
}

export function buildIndex(pages: WikiPage[]): string {
  const groups = new Map<PageKind, WikiPage[]>();
  for (const page of pages) groups.set(page.kind, [...(groups.get(page.kind) ?? []), page]);
  const labels: Record<PageKind, string> = { concept: '概念', entity: '实体', source: '来源摘要', comparison: '对比分析', overview: '总览', note: '笔记' };
  const lines = ['# Wiki 索引', '', '> 本文件由笔记扩展维护，是模型查询知识库时的第一站。每页一句话摘要。', ''];
  for (const kind of PAGE_KINDS) {
    const items = (groups.get(kind) ?? []).sort((a, b) => a.title.localeCompare(b.title, 'zh-CN'));
    if (!items.length) continue;
    lines.push(`## ${labels[kind]}（${items.length}）`, '');
    for (const page of items) lines.push(`- [[${page.slug}|${page.title}]] — ${page.summary || '（暂无摘要）'}`);
    lines.push('');
  }
  if (!pages.length) lines.push('尚无页面。添加原始素材后，编译提案会出现在「待审阅」。', '');
  lines.push(`共 ${pages.length} 页，${new Set(pages.flatMap(page => extractLinks(page.body))).size} 个链接目标。`);
  return lines.join('\n');
}

export function logLine(kind: 'ingest' | 'compile' | 'query' | 'lint' | 'publish' | 'edit', title: string, details: string[], at = new Date()): string {
  const stamp = at.toISOString().slice(0, 10);
  const body = details.filter(Boolean).map(line => `- ${line}`).join('\n');
  return `## [${stamp}] ${kind} | ${title.replace(/[\r\n]/g, ' ').slice(0, 160)}\n${body}\n`;
}

export function lintWiki(pages: WikiPage[], now = Date.now()): WikiLint {
  const slugs = new Set(pages.map(page => page.slug));
  const inbound = backlinks(pages);
  const brokenTargets = new Set<string>();
  const brokenLinks: { from: string; to: string }[] = [];
  for (const page of pages) for (const target of extractLinks(page.body)) if (!slugs.has(target)) {
    brokenLinks.push({ from: page.slug, to: target });
    brokenTargets.add(target);
  }
  const contradictions: { page: string; text: string }[] = [];
  for (const page of pages) for (const line of page.body.split(/\r?\n/)) {
    if (/^\s*>\s*(矛盾|冲突|存疑|contradiction)/i.test(line) || /^\s*[-*]\s*(矛盾|冲突|存疑)/.test(line)) {
      contradictions.push({ page: page.slug, text: line.trim().slice(0, 300) });
    }
  }
  const staleDays = 90 * 24 * 60 * 60 * 1000;
  return {
    at: new Date(now).toISOString(),
    orphans: pages.filter(page => (inbound.get(page.slug)?.length ?? 0) === 0 && page.kind !== 'overview').map(page => page.slug),
    brokenLinks: brokenLinks.slice(0, 200),
    missingSummary: pages.filter(page => !page.summary.trim()).map(page => page.slug),
    contradictions: contradictions.slice(0, 100),
    stale: pages.filter(page => now - Date.parse(page.updatedAt) > staleDays).map(page => page.slug),
    suggestions: [...brokenTargets].slice(0, 20).map(target => `「${target}」被引用但没有页面，可在编译时补上`),
  };
}

/** Models occasionally wrap JSON in prose or fences. Accept the outermost object. */
export function parseJsonResponse(text: string): Record<string, unknown> {
  const raw = String(text ?? '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
  let candidate = raw;
  if (!candidate.startsWith('{')) {
    const start = candidate.indexOf('{'), end = candidate.lastIndexOf('}');
    if (start < 0 || end <= start) throw new Error('模型返回的不是 JSON 对象');
    candidate = candidate.slice(start, end + 1);
  }
  const value = JSON.parse(candidate) as unknown;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('模型返回的不是 JSON 对象');
  return value as Record<string, unknown>;
}

export function truncate(text: string, max: number): string {
  const value = String(text ?? '');
  return value.length <= max ? value : value.slice(0, Math.max(0, max - 1)) + '…';
}

/** The plugin bridge caps a JSON result at 128 KiB; cap by bytes, not chars,
 * because Chinese Markdown costs three bytes per character. */
export function byteTruncate(text: string, maxBytes: number): string {
  const value = String(text ?? '');
  if (Buffer.byteLength(value) <= maxBytes) return value;
  const marker = '\n\n…（显示内容已截断）';
  const budget = Math.max(0, maxBytes - Buffer.byteLength(marker));
  let low = 0, high = value.length;
  while (low < high) {
    const mid = Math.floor((low + high + 1) / 2);
    if (Buffer.byteLength(value.slice(0, mid)) <= budget) low = mid; else high = mid - 1;
  }
  return value.slice(0, low) + marker;
}

export function lineDiff(before: string, after: string): { type: 'same' | 'add' | 'del'; text: string }[] {
  const a = String(before ?? '').split(/\r?\n/), b = String(after ?? '').split(/\r?\n/);
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let tail = 0;
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++;
  const result: { type: 'same' | 'add' | 'del'; text: string }[] = [];
  for (let i = 0; i < head; i++) result.push({ type: 'same', text: a[i] });
  for (let i = head; i < a.length - tail; i++) result.push({ type: 'del', text: a[i] });
  for (let i = head; i < b.length - tail; i++) result.push({ type: 'add', text: b[i] });
  for (let i = 0; i < tail; i++) result.push({ type: 'same', text: a[a.length - tail + i] });
  return result;
}

export function skillFromDocument(name: string, text: string, builtin: boolean, fallbackTime: string): WikiSkill {
  const { data, body } = parseDocument(text);
  const kind = (['ingest', 'compile', 'query', 'lint', 'synthesize', 'custom'] as const)
    .find(value => value === data.kind) ?? 'custom';
  return {
    name, description: typeof data.description === 'string' ? data.description : '',
    kind, triggers: stringList(data.triggers), body, builtin,
    updatedAt: typeof data.updatedAt === 'string' ? data.updatedAt : fallbackTime,
  };
}

export function skillToDocument(skill: WikiSkill): string {
  // The name/description header is deliberately compatible with the workbench's
  // SKILL.md reader (src/main/skills.ts), so skills can be exported to an Agent.
  return stringifyDocument({
    name: skill.name, description: skill.description, kind: skill.kind,
    triggers: skill.triggers, updatedAt: skill.updatedAt,
  }, skill.body);
}

export function validateSkillName(name: string): void {
  if (!SKILL_NAME.test(name) || name.length > 64) throw new Error('Skill 名称须为小写字母、数字和横线，最多 64 字符');
}

export function draftPages(value: unknown, pages: WikiPage[], sourceId: string | null, sourceText?: string): WikiDraft['pages'] {
  const list = Array.isArray(value) ? value.slice(0, 15) : [];
  const bySlug = new Map(pages.map(page => [page.slug, page]));
  const result: WikiDraft['pages'] = [];
  for (const item of list) {
    if (!item || typeof item !== 'object') continue;
    const row = item as Record<string, unknown>;
    const title = typeof row.title === 'string' && row.title.trim() ? row.title.trim().slice(0, 160) : '';
    if (!title) continue;
    const slug = slugify(typeof row.slug === 'string' && row.slug.trim() ? row.slug : title);
    if (result.some(page => page.slug === slug)) throw new Error('模型生成了重复的页面名称，请重试');
    const existing = bySlug.get(slug);
    const body = typeof row.body === 'string' ? row.body : '';
    if (Buffer.byteLength(body) > 48 * 1024) throw new Error('模型页面超过 48 KiB，请拆分主题后重新编译');
    if (!body.trim()) continue;
    const sources = [...new Set([...(existing?.sources ?? []), ...(sourceId ? [sourceId] : [])])].slice(0, 50);
    const quoted = evidenceList(row.evidence, sourceText, new Set(sourceId ? [sourceId] : []))
      .map(item => ({ sourceId: item.sourceId || sourceId || '', quote: item.quote }))
      .filter(item => item.sourceId);
    const next: WikiDraft['pages'][number] = {
      slug, title, summary: typeof row.summary === 'string' ? row.summary.trim().slice(0, 400) : '',
      kind: PAGE_KINDS.includes(row.kind as PageKind) ? row.kind as PageKind : 'concept',
      body, sources, evidence: [...(existing?.evidence ?? []), ...quoted].filter((item, index, all) => all.findIndex(other => other.sourceId === item.sourceId && other.quote === item.quote) === index).slice(0, 20), tags: Array.isArray(row.tags) ? row.tags.filter((value): value is string => typeof value === 'string').slice(0, 20) : [],
      previous: existing ? pageToDocument(existing) : null,
      action: existing ? (existing.humanEdited ? 'skip' : 'update') : 'create',
    };
    // A hand-edited page stays visible in the proposal as action 'skip' so the
    // reviewer knows why the model did not touch it.
    result.push(next);
  }
  return result;
}
