import { createServer, type Server } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { writeFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { petHookSchema, type PetHook } from '../shared/pet';

/** Loopback, bounded, authenticated events only. No command execution or filesystem API. */
export class PetHooks {
  private server: Server | null = null;
  private token = randomBytes(32).toString('hex');
  constructor(private directory: string, private accept: (hook: PetHook) => boolean) {}
  async start(): Promise<void> {
    const server = createServer((req, res) => {
      const finish = (status: number, message: string) => { res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify({ message })); };
      // Browser pages must not be able to send hooks using a local token.
      if (req.method !== 'POST' || req.url !== '/hook' || req.headers.origin) { finish(404, 'Not found'); req.resume(); return; }
      const auth = Buffer.from(req.headers.authorization ?? ''), expected = Buffer.from('Bearer ' + this.token);
      if (auth.length !== expected.length || !timingSafeEqual(auth, expected)) { finish(401, 'Unauthorized'); req.resume(); return; }
      let bytes = 0, chunks: Buffer[] = [], rejected = false;
      req.on('data', (chunk: Buffer) => { bytes += chunk.length; if (bytes > 4096) { if (!rejected) finish(413, 'Event too large'); rejected = true; chunks = []; } else if (!rejected) chunks.push(chunk); });
      req.on('end', () => {
        if (rejected) return;
        try {
          const parsed = petHookSchema.safeParse(JSON.parse(Buffer.concat(chunks).toString('utf8')));
          if (!parsed.success) { finish(400, 'Invalid hook event'); return; }
          finish(this.accept(parsed.data) ? 200 : 409, 'Hook processed');
        } catch { finish(400, 'Invalid hook event'); }
      });
      req.on('error', () => {});
    });
    server.requestTimeout = 3000; server.headersTimeout = 3000;
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve(); }); });
    this.server = server;
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Hook listener unavailable');
    writeFileSync(path.join(this.directory, 'pet-hook.json'), JSON.stringify({ port: address.port, token: this.token }), { mode: 0o600 });
  }
  async close() {
    rmSync(path.join(this.directory, 'pet-hook.json'), { force: true });
    const server = this.server; this.server = null;
    if (server) { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
  }
}
