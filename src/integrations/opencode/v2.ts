import { createBridge, eventTypes } from './bridge';

// OpenCode 2.x Promise Plugin API: Plugin.define is an identity helper, so this
// dependency-free definition works without installing @opencode/plugin.
export default {
  id: 'agentberth.desktop-pet',
  async setup(context: any) {
    const bridge = createBridge(context.location?.directory, (sessionID, signal) => context.session.get({ sessionID }, { signal }));
    if (!bridge) return;
    const controller = new AbortController();
    try {
      await context.session.hook('prompt', (input: any) => { if (typeof input.sessionID === 'string') void bridge.prompt(input.sessionID); });
      const stream = context.event.subscribe({ signal: controller.signal, types: eventTypes.filter(type => !['session.updated', 'session.error', 'permission.updated', 'question.asked', 'question.replied', 'question.rejected'].includes(type)) });
      void (async () => { try { for await (const event of stream) await bridge.event(event); } catch { /* Plugin unload/server exit. */ } })();
      return () => { controller.abort(); bridge.close(); };
    } catch { controller.abort(); bridge.close(); }
  },
};
