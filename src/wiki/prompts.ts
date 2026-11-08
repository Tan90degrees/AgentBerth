import { buildIndex, extractLinks, truncate } from './core';
import type { ChatMessage } from './llm';
import type { WikiPage, WikiSkill, WikiSource } from './types';

// Karpathy's schema layer: a plain Markdown file both the human and the model
// can read and revise. It is prepended to every system prompt.
export const DEFAULT_SCHEMA = `# 笔记 Wiki 约定（Schema）

你的角色是知识库的维护者，而不是聊天机器人。知识被**编译一次并持续更新**，而不是每次提问重新从原始资料推导。

## 三层
- \`raw/\`：人类策展的原始素材（文字、图片），不可变，只读不改。
- \`wiki/\`：由你维护的 Markdown 页面（概念、实体、来源摘要、对比、总览）。你写，人读。
- \`skills/\`：可复用的工作流指令模板；\`schema.md\`：本文件，约定与边界。

## 页面规范
- 每页一个主题，标题简洁；用 \`[[页面 slug]]\` 或 \`[[页面 slug|显示名]]\` 做双向链接。
- 先给结论与要点，再给证据；每个论断尽量标明来自哪个素材。
- 页面的 evidence 记录逐字摘自素材的引文，读者可借此回溯到原文；不要改写或编造引文。
- 新旧资料冲突时，不要抹掉旧结论，用引用块写 \`> 矛盾：…\` 并指出两种说法。
- 不要虚构来源、数字或引用。资料不足时明确写「资料不足」。
- 回答与编译一律使用中文，除非素材本身是其它语言。

## 导航文件
- \`index.md\` 是内容导向目录（每页链接 + 一句话摘要），查询时先读它。
- \`log.md\` 是时间导向的只追加操作记录（ingest / query / lint / publish）。

## 边界
- 编译产物是**提案**，需要人审阅后才会发布；人手改过的页面不要覆盖。
- 一次编译可以触达多个相关页面，但不要为了凑数创建低价值页面。
`;

const builtin = (name: string, description: string, kind: WikiSkill['kind'], triggers: string[], body: string): WikiSkill => ({
  name, description, kind, triggers, body, builtin: true, updatedAt: '2026-01-01T00:00:00.000Z',
});

export const BUILTIN_SKILLS: WikiSkill[] = [
  builtin('wiki-ingest', '读取一份原始素材，抽取概念、别名、摘要与要点', 'ingest', ['新素材', '摄入', '抽取概念'],
    `# 任务：素材摄入（Ingest）
你是知识库的第一道工序。阅读用户给出的原始素材（可能含图片描述），抽取值得沉淀的概念。

严格返回 JSON 对象，不要输出 JSON 以外的文字：
{
  "summary": "这份素材的一句话摘要",
  "concepts": [
    {"title":"概念或实体名","kind":"concept|entity|source|comparison|overview","summary":"一句话说明","relevance":0.9}
  ],
  "claims": ["值得记录的关键论断，尽量保留原始措辞"],
  "contradictions": ["与已有索引明显冲突的地方，没有则留空数组"]
}
规则：只抽取素材中真实出现的内容；概念名用素材原文；最多 8 个概念；按相关性降序。`),
  builtin('wiki-compile', '把素材编译成带双向链接的 wiki 页面提案', 'compile', ['编译', '更新页面', '整理笔记'],
    `# 任务：编译（Compile）
把摄入结果整合进已有 wiki。你可以新建页面，也可以更新已有页面，但**绝不直接发布**：返回值是待审阅提案。

严格返回 JSON 对象，不要输出 JSON 以外的文字：
{
  "summary": "本次编译做了什么（一句话）",
  "pages": [
    {
      "slug":"小写横线或中文短名","title":"页面标题","kind":"concept|entity|source|comparison|overview|note",
      "summary":"一句话摘要","tags":["标签"],
      "body":"完整的 Markdown 正文，必须含 [[双向链接]]，必要时用 > 矛盾：… 标记冲突",
      "sources":["素材 ID"],
      "evidence":[{"quote":"逐字摘自本次素材原文的一段话，用于回溯证据"}]
    }
  ],
  "contradictions": ["新资料与既有结论的冲突，没有则空数组"],
  "log": "写给 log.md 的一句话"
}
规则：
- 优先更新已有页面并保留其中仍然正确的结论；一次编译最多 10 个页面。
- body 必须是完整页面内容，不是 diff，也不是「略」；每个页面至少链接一个已有页面或一个新页面。
- 不要创建内容重复或只有一两句话的页面。
- evidence 中的 quote 必须是素材原文里逐字出现的连续片段（至少 8 字，建议 20–200 字）；系统发布前会校验，编造或过短的引文会被丢弃。
- 若提供了「上次拒绝反馈」，必须逐条回应这些意见后再生成。`),
  builtin('wiki-query', '基于 wiki 页面回答问题并给出引用', 'query', ['提问', '查询', '总结'],
    `# 任务：查询（Query）
基于用户提供的 index.md 摘录与相关页面回答问题。

要求：
1. 只用提供的页面内容作答；资料不足时直说「现有笔记没有足够信息」，不要用通用知识补空。
2. 每个关键结论后用 \`[[页面 slug]]\` 标注引用，让读者能点回原页。
3. 给出结构清晰的中文回答（要点 / 依据 / 仍存疑之处），不要复述问题。
4. 如果页面之间存在矛盾，明确指出并列出两种说法。`),
  builtin('wiki-lint', '定期体检：矛盾、过时、孤立页、断链与缺页概念', 'lint', ['体检', '检查', '健康检查'],
    `# 任务：体检（Lint）
审视 wiki 的结构健康度，给出可执行的建议，不要重写页面。

严格返回 JSON 对象：
{
  "contradictions": [{"page":"页面 slug","text":"矛盾说明"}],
  "orphans": ["没有任何入链的页面 slug"],
  "missing": ["被反复引用却还没有独立页面的概念"],
  "stale": ["结论可能过时、建议复核的页面 slug"],
  "suggestions": ["最多 8 条，按价值排序的具体下一步"]
}`),
  builtin('wiki-synthesize', '把一次好回答归档为新的 wiki 页面', 'synthesize', ['归档', '保存回答', '沉淀'],
    `# 任务：答案归档（Synthesize）
把一次问答沉淀成可复用的 wiki 页面，让提问也能产生知识复利。

严格返回 JSON 对象：
{
  "title":"页面标题","kind":"comparison|overview|note","summary":"一句话摘要","tags":["标签"],
  "body":"完整 Markdown 正文，保留原回答中的 [[引用]]，并在开头写明这是由哪个问题生成的"
}`),
];

export function defaultSkill(kind: WikiSkill['kind']): WikiSkill {
  return BUILTIN_SKILLS.find(skill => skill.kind === kind) ?? BUILTIN_SKILLS[0];
}

/** User skills override built-ins with the same name; otherwise prefer the
 * first skill of the requested kind so custom workflows can be chained. */
export function resolveSkill(skills: WikiSkill[], kind: WikiSkill['kind'], name?: string): WikiSkill {
  const all = [...skills, ...BUILTIN_SKILLS];
  if (name) {
    const named = all.find(skill => skill.name === name);
    if (named) return named;
  }
  return all.find(skill => skill.kind === kind) ?? defaultSkill(kind);
}

function system(schema: string, skill: WikiSkill, extra = ''): string {
  return `${schema}\n\n---\n\n# 当前工作流：${skill.name}\n\n${skill.body}${extra ? '\n\n' + extra : ''}`;
}

export function ingestMessages(source: WikiSource, schema: string, skill: WikiSkill, indexText: string, vision: string): ChatMessage[] {
  const context = [
    '# 现有 wiki 索引（避免重复建页）', truncate(indexText, 6000) || '（索引为空）',
    '\n# 原始素材', `素材 ID：${source.id}`, `标题：${source.title}`,
    vision ? `\n# 图片理解（由视觉模型生成）\n${truncate(vision, 4000)}` : '',
    '\n# 正文', truncate(source.text, 24000),
  ].join('\n');
  return [{ role: 'system', content: system(schema, skill) }, { role: 'user', content: context }];
}

export function compileMessages(
  source: WikiSource, ingest: string, pages: WikiPage[], schema: string, skill: WikiSkill, feedback: string[],
): ChatMessage[] {
  const related = pages.slice(0, 24).map(page => `## [[${page.slug}]] ${page.title}\n摘要：${page.summary}\n现有链接：${extractLinks(page.body).slice(0, 12).join('、') || '无'}`).join('\n');
  const context = [
    '# 现有页面（可更新，slug 必须一致）', related || '（尚无页面）',
    '\n# 本次素材', `素材 ID：${source.id}`, `标题：${source.title}`, truncate(source.text, 16000),
    '\n# 摄入结果（概念与论断）', truncate(ingest, 12000),
    feedback.length ? '\n# 上次拒绝反馈（必须逐条回应）\n' + feedback.map(item => '- ' + item).join('\n') : '',
    `\n请输出针对素材 ${source.id} 的编译提案 JSON。`,
  ].join('\n');
  return [{ role: 'system', content: system(schema, skill) }, { role: 'user', content: context }];
}

export function queryMessages(question: string, pages: WikiPage[], schema: string, skill: WikiSkill): ChatMessage[] {
  const context = [
    '# index.md（路由层）', truncate(buildIndex(pages), 8000),
    '\n# 相关页面（检索得分最高的若干页）',
    ...pages.map(page => `## [[${page.slug}]] ${page.title}\n摘要：${page.summary}\n\n${truncate(page.body, 6000)}`),
    '\n# 问题', question,
  ].join('\n');
  return [{ role: 'system', content: system(schema, skill, '回答末尾列出本次实际引用到的页面 slug。') }, { role: 'user', content: context }];
}

export function lintMessages(pages: WikiPage[], schema: string, skill: WikiSkill): ChatMessage[] {
  const context = [
    '# 页面清单',
    ...pages.map(page => `- [[${page.slug}]] ${page.title}｜摘要：${page.summary || '（缺）'}｜入链目标：${extractLinks(page.body).join('、') || '无'}｜更新：${page.updatedAt}`),
    '\n# 正文摘录', truncate(pages.map(page => `## ${page.slug}\n${page.body}`).join('\n'), 20000),
  ].join('\n');
  return [{ role: 'system', content: system(schema, skill) }, { role: 'user', content: context }];
}

export function synthesizeMessages(answer: { question: string; answer: string; citations: string[] }, schema: string, skill: WikiSkill): ChatMessage[] {
  return [
    { role: 'system', content: system(schema, skill) },
    { role: 'user', content: `# 问题\n${answer.question}\n\n# 回答\n${truncate(answer.answer, 12000)}\n\n# 引用页面\n${answer.citations.join('、') || '（无）'}` },
  ];
}
