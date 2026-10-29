import { randomUUID } from 'node:crypto';
import { TerminalMcp } from './server';
import { boundedToolText } from './result-limits';
import { errorReply, ToolArgumentError } from './harness';

export interface AgentContext { server: TerminalMcp; disconnect(): void }
/** MCP has no universal subagent identity. Named contexts use separate daemon
 * sockets, target memory and writer leases even inside one shared MCP process. */
export class AgentMcp {
  private contexts = new Map<string, AgentContext>();
  constructor(private create: (agentId: string) => AgentContext) {}
  disconnect(agentId: string): void { this.contexts.get(agentId)?.disconnect(); }
  close(): void { for (const context of this.contexts.values()) context.disconnect(); this.contexts.clear(); }
  async request(method: string, params: unknown): Promise<any> {
    const p = params as { name?: string; arguments?: Record<string, unknown> } | undefined;
    const supplied = method === 'tools/call' ? p?.arguments?.agentId : undefined;
    if (supplied !== undefined && (typeof supplied !== 'string' || !supplied.trim() || supplied.length > 100 || /[\x00-\x1f]/.test(supplied))) {
      return { isError: true, content: [{ type: 'text', text: boundedToolText(errorReply(new ToolArgumentError('agentId must be a nonempty stable name, at most 100 characters'), { name: p?.name ?? '', args: {}, target: {}, dispatched: false })) }] };
    }
    const fresh = method === 'tools/call' && p?.name === 'terminal_session' && ['open','create'].includes(String(p.arguments?.action));
    const agentId = supplied as string | undefined ?? (fresh ? randomUUID() : '');
    let context = this.contexts.get(agentId);
    if (!context) {
      if (this.contexts.size >= 128) return { isError: true, content: [{ type: 'text', text: JSON.stringify({ error: { code: 'AGENT_CONTEXT_LIMIT', execution: 'not_started', message: 'Dispose finished agent contexts with terminal_session(action=dispose, agentId=...) before opening more.' } }) }] };
      context = this.create(agentId); this.contexts.set(agentId, context);
    }
    const args = { ...p?.arguments }; delete args.agentId;
    const validArgs=p?.arguments===undefined || !!p.arguments && typeof p.arguments==='object' && !Array.isArray(p.arguments);
    const reply = await context.server.request(method, method === 'tools/call' && validArgs ? { ...p, arguments: args } : params) as any;
    if (method === 'tools/call' && p?.name === 'terminal_session' && args.action === 'dispose' && !reply.isError) {
      context.disconnect(); this.contexts.delete(agentId);
    }
    if (!agentId || !Array.isArray(reply?.content)) return reply;
    return { ...reply, content: reply.content.map((item: any) => {
      if (item.type !== 'text') return item;
      let value; try { value = JSON.parse(item.text); } catch { return item; }
      // Preserve identity on trusted continuation pointers, never rewrite remote text.
      for (const pointer of [value.continuation, value.details, value.harness?.next]) if (pointer?.tool && pointer.arguments) pointer.arguments.agentId = agentId;
      value.agentId = agentId;
      return { ...item, text: boundedToolText(value) };
    }) };
  }
}
