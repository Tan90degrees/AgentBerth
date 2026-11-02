// No installation or build step. Cordis and the workbench SDK are supplied by AgentBerth.
exports.name = 'example.claude-profile';
exports.apply = (ctx, config) => {
  ctx.berth.agent({
    id: 'main', // Keep stable across updates: sessions and default-Agent settings use this identity.
    definition: {
      name: config.name,
      command: config.command,
      integration: 'claude',
      resumeCommand: 'claude --resume {sessionId}',
      skills: { project: '.claude/skills', user: '~/.claude/skills' },
    },
  });
  ctx.berth.command({
    name: 'info',
    description: 'Read the configured Agent name and command without starting it.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  }, () => ({ name: config.name, command: config.command }));
  // For listeners, timers, sockets and processes always register a disposer:
  // ctx.effect(() => { const timer = setInterval(work, 1000); return () => clearInterval(timer); });
};
