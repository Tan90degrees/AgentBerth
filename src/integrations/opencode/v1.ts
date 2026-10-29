import { createBridge } from './bridge';

// OpenCode 1.x local plugin API. No npm dependencies or extra runtime required.
export default async function AgentBerthPet(context: any) {
  const bridge = createBridge(context.directory, (id, signal) => context.client.session.get({ path: { id } }, { signal }));
  if (!bridge) return {};
  return {
    'chat.message': (input: any) => { if (typeof input.sessionID === 'string') void bridge.prompt(input.sessionID); },
    event: ({ event }: any) => { void bridge.event(event); },
  };
}
