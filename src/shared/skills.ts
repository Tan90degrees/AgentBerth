import { z } from 'zod';
const relativeDirectory = z.string().min(1).max(512).refine(value => !/[\x00\r\n]/.test(value) && !/^[\\/]|^[a-z]:/i.test(value) && value.split(/[\\/]/).every(part => !!part && part !== '..' && part !== '.'), '项目 Skill 目录须为不含 .. 的相对路径');
export const agentSkillsSchema = z.object({
  project: relativeDirectory.optional(),
  user: z.string().min(1).max(4096).refine(value => !/[\x00\r\n]/.test(value) && /^(~[\\/]|[\\/]|[a-z]:[\\/])/i.test(value), '用户 Skill 目录须为绝对路径或 ~/ 开头').optional(),
}).strict().refine(value => !!value.project || !!value.user, '至少声明一个 Skill 目录');
export type AgentSkills = z.infer<typeof agentSkillsSchema>;
export const builtinSkillProviders: { id: string; name: string; skills: AgentSkills }[] = [
  { id: 'codex', name: 'Codex', skills: { project: '.agents/skills', user: '~/.agents/skills' } },
  { id: 'claude', name: 'Claude Code', skills: { project: '.claude/skills', user: '~/.claude/skills' } },
  { id: 'opencode', name: 'OpenCode', skills: { project: '.opencode/skills', user: '~/.config/opencode/skills' } },
];
export const skillLocationSchema = z.object({
  agentId: z.string().min(1).max(100),
  projectId: z.uuid().nullable().default(null),
}).strict();
const name = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,99}$/).refine(value => !value.endsWith('.') && !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(value));
export const skillRequestSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('list'), location: skillLocationSchema }).strict(),
  z.object({ action: z.literal('read'), location: skillLocationSchema, name, enabled: z.boolean() }).strict(),
  z.object({ action: z.literal('import'), location: skillLocationSchema, source: z.string().min(1).max(4096) }).strict(),
  z.object({ action: z.literal('toggle'), location: skillLocationSchema, name, enabled: z.boolean() }).strict(),
  z.object({ action: z.literal('remove'), location: skillLocationSchema, name, enabled: z.boolean() }).strict(),
  z.object({ action: z.literal('save'), location: skillLocationSchema, name, enabled: z.boolean(), content: z.string().max(262144) }).strict(),
]);
export type SkillLocation = z.infer<typeof skillLocationSchema>;
export type SkillRequest = z.infer<typeof skillRequestSchema>;
export interface SkillItem { folder: string; name: string; description: string; enabled: boolean; path: string; error?: string; linked?: boolean }
export interface SkillPage { root: string; items: SkillItem[]; warnings: string[] }
