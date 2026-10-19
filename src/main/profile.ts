import path from 'node:path';
import { existsSync } from 'node:fs';
/** Keep the pre-rename profile, including case-sensitive development installs. */
export function legacyProfile(appData: string, exists: (path: string) => boolean = existsSync): string {
  const installed = path.join(appData, 'AgentBerth'), development = path.join(appData, 'agentberth');
  return !exists(installed) && exists(development) ? development : installed;
}
