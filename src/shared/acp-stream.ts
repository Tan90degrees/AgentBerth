import type {AcpEvent} from './acp';

export const acpChunkKinds: Readonly<Record<string, AcpEvent['kind']>> = {
  user_message_chunk: 'user',
  agent_message_chunk: 'assistant',
  agent_thought_chunk: 'thought',
};

export function acpId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 1000;
}

export function acpRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function acpCapabilityMarker(value: unknown): boolean {
  return value === true || acpRecord(value);
}

export function acpPatch(value: Record<string, unknown>, keys: string[]): Record<string, unknown> {
  return Object.fromEntries(keys.filter(key => Object.hasOwn(value, key)).map(key => [key, value[key]]));
}

/** Apply full replacements (including null) and append content blocks in wire order. */
export function acpStreamBlocks(events: AcpEvent[], field: 'summary' | 'blocks'): unknown[] {
  let blocks: unknown[] = [];
  for (const {data} of events) {
    if (!data) continue;
    if (Object.hasOwn(data, field)) blocks = Array.isArray(data[field]) ? [...data[field]] : [];
    if (data.block) blocks.push(data.block);
  }
  return blocks;
}
