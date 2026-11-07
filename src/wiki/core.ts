import { createHash } from 'node:crypto';
import { dump, load, JSON_SCHEMA } from 'js-yaml';
import type { PageKind, WikiDraft, WikiLint, WikiPage, WikiSkill } from './types';

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
  return (cleaned || 'untitled').slice(0, 80);
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
  return `---\n${header}\n---\n\n${String(body ?? '').replace(/^\s+/, '')}`;
}

const stringList = (value: unknown): string[] => Array.isArray(value)
  ? value.filter((item): item is string => typeof item === 'string').slice(0, 100)
  : typeof value === 'string' && value.trim() ? [value] : [];

export function pageFromDocument(slug: string, text: string, fallbackTime: string): WikiPage {
  const { data, body } = parseDocument(text);
  const title = typeof data.title === 'string' && data.title.trim() ? data.title : slug;
  const kind = PAGE_KINDS.includes(data.kind as PageKind) ? data.kind as PageKind : 'note';
  const page: WikiPage = {
    slug, title, summary: typeof data.summary === 'string' ? data.summary : '',
    kind, sources: stringList(data.sources), tags: stringList(data.tags), body,
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
    sources: page.sources, tags: page.tags, humanEdited: page.humanEdited,
    hash: page.hash, createdAt: page.createdAt, updatedAt: page.updatedAt,
  }, page.body);
}

export function pageHash(page: Pick<WikiPage, 'title' | 'summary' | 'body' | 'sources'>): string {
  return createHash('sha256').update(JSON.stringify([page.title, page.summary, page.body, page.sources])).digest('hex').slice(0, 32);
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
    score += Math.min((inbound.get(page.slug)?.length ?? 0), 8) * 0.4;
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
  const marker = '\n\n…（内容已截断，完整版本保存在本地文件中）';
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
  return result.slice(0, 400);
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

export function draftPages(value: unknown, pages: WikiPage[], sourceId: string | null): WikiDraft['pages'] {
  const list = Array.isArray(value) ? value.slice(0, 15) : [];
  const bySlug = new Map(pages.map(page => [page.slug, page]));
  const result: WikiDraft['pages'] = [];
  for (const item of list) {
    if (!item || typeof item !== 'object') continue;
    const row = item as Record<string, unknown>;
    const title = typeof row.title === 'string' && row.title.trim() ? row.title.trim().slice(0, 160) : '';
    if (!title) continue;
    const slug = slugify(typeof row.slug === 'string' && row.slug.trim() ? row.slug : title);
    const existing = bySlug.get(slug);
    const body = typeof row.body === 'string' ? byteTruncate(row.body, 48 * 1024) : '';
    const sources = [...new Set([...(Array.isArray(row.sources) ? row.sources.filter((value): value is string => typeof value === 'string') : []), ...(sourceId ? [sourceId] : [])])].slice(0, 50);
    const next: WikiDraft['pages'][number] = {
      slug, title, summary: typeof row.summary === 'string' ? row.summary.trim().slice(0, 400) : '',
      kind: PAGE_KINDS.includes(row.kind as PageKind) ? row.kind as PageKind : 'concept',
      body, sources, tags: Array.isArray(row.tags) ? row.tags.filter((value): value is string => typeof value === 'string').slice(0, 20) : [],
      previous: existing ? pageToDocument(existing) : null,
      action: existing ? (existing.humanEdited ? 'skip' : 'update') : 'create',
    };
    // A hand-edited page stays visible in the proposal as action 'skip' so the
    // reviewer knows why the model did not touch it.
    result.push(next);
  }
  return result;
}
