import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { AgentDefinition, Session, SshConnection } from '../shared/protocol';

export const restartPlanSchema = z.array(z.object({
  sessionId: z.uuid(), runId: z.uuid().nullable(),
  cols: z.number().int().min(20).max(300), rows: z.number().int().min(5).max(100),
  configuration: z.string().regex(/^[a-f0-9]{64}$/),
  remoteOwner: z.enum(['user', 'agent']).optional(),
}).strict()).max(256);
export type RestartEntry = z.infer<typeof restartPlanSchema>[number];

// Native identity is deliberately read AFTER shutdown has flushed final history.
// Persist a hash of launch settings, not commands, credentials or terminal input.
export function restartConfiguration(session: Session, projectPath: string, agent?: AgentDefinition, ssh?: SshConnection): string {
  return createHash('sha256').update(JSON.stringify({projectPath,agent:session.agent,command:session.command,terminal:session.terminal,remote:session.remote,definition:agent,ssh})).digest('hex');
}
export function shouldResume(session: Session, agent?: AgentDefinition): boolean {
  if (session.remote || session.agent === 'shell' || !session.nativeSessionId) return false;
  if (['codex','claude','opencode'].includes(session.agent) || agent?.resumeCommand || agent?.plugin?.resume) return true;
  throw new Error('已保留原生会话 ID，但此 Agent 未配置恢复命令；请更新插件后手动恢复，避免新建对话覆盖关联');
}
