import { z } from 'zod';

export const petStatuses = ['idle', 'working', 'waiting', 'completed', 'error', 'unknown'] as const;
export type PetStatus = typeof petStatuses[number];
export const petLabels: Record<PetStatus, string> = { idle: '空闲', working: '执行中', waiting: '等待你处理', completed: '已完成', error: '执行失败', unknown: '状态待确认' };
export const petPreferencesSchema = z.object({
  enabled: z.boolean().default(false), alwaysOnTop: z.boolean().default(true),
  autoSwitch: z.boolean().default(true), scale: z.number().min(0.75).max(1.5).default(1),
  selectedSessionId: z.string().max(100).default(''),
}).strict();
export type PetPreferences = z.infer<typeof petPreferencesSchema>;
export const defaultPetPreferences = petPreferencesSchema.parse({});
export const petHookSchema = z.object({
  sessionId: z.string().uuid(), runId: z.string().uuid(),
  status: z.enum(petStatuses).exclude(['unknown']),
  // Human-readable summaries only; command output and prompts are never collected.
  label: z.string().max(120).optional(),
}).strict();
export type PetHook = z.infer<typeof petHookSchema>;
export interface PetSession { sessionId: string; runId: string; title: string; project: string; status: PetStatus; label: string; hooked: boolean; updatedAt: number }
export interface PetSnapshot {
  preferences: PetPreferences; sessions: PetSession[]; connected: boolean;
  images: Partial<Record<PetStatus, string>>; imageVersion: number;
}
export const petRequestSchema = z.discriminatedUnion('action', [
  z.object({ action: z.enum(['state', 'hookConfig', 'showSession']) }).strict(),
  z.object({ action: z.literal('save'), preferences: petPreferencesSchema }).strict(),
  z.object({ action: z.enum(['importImage', 'resetImage', 'image']), status: z.enum(petStatuses) }).strict(),
]);
export type PetRequest = z.infer<typeof petRequestSchema>;

/** Translate common Agent hook names without inspecting prompts or tool output. */
export function hookStatus(event: string, notificationType?: string): PetHook['status'] | null {
  switch (event.toLowerCase().replace(/[_-]/g, '')) {
    case 'start': case 'working': case 'userpromptsubmit': case 'pretooluse': case 'posttooluse': case 'subagentstart': return 'working';
    case 'waiting': case 'permissionrequest': return 'waiting';
    case 'notification': return ['permission_prompt', 'idle_prompt', 'elicitation_dialog'].includes(notificationType ?? '') ? 'waiting' : null;
    case 'completed': case 'stop': return 'completed';
    case 'error': case 'stopfailure': case 'posttoolusefailure': return 'error';
    case 'idle': case 'sessionstart': case 'sessionend': return 'idle';
    default: return null;
  }
}
