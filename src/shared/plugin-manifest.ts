import { z } from 'zod';
import { agentDefinitionSchema } from './protocol';

const relativeFile = z.string().min(1).max(512).refine(value => !/[\x00\r\n]/.test(value) && !/^[\\/]|^[a-z]:/i.test(value) && value.split(/[\\/]/).every(part => part !== '..' && part !== '.' && !!part), '文件须使用插件目录内的相对路径');
export const agentConfigFileSchema = z.object({
  schemaVersion: z.literal(1),
  id: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,99}$/),
  name: agentDefinitionSchema.shape.name,
  command: agentDefinitionSchema.shape.command,
  resumeCommand: agentDefinitionSchema.shape.resumeCommand,
  skills: agentDefinitionSchema.shape.skills,
}).strict();
export const pluginManifestSchema = agentConfigFileSchema.extend({
  runtime: z.enum(['node', 'executable']),
  entry: relativeFile,
  args: z.array(z.string().max(4096).refine(value => !/[\r\n\x00]/.test(value))).max(32).default([]),
  files: z.array(relativeFile).max(63).default([]),
  capabilities: z.object({ history: z.boolean().default(false), resume: z.boolean().default(false), list: z.boolean().optional() }).strict(),
}).strict();
export type PluginManifest = z.infer<typeof pluginManifestSchema>;

// Older manifest adapters can omit launch metadata; direct script imports require it.
export const pluginDescriptionSchema = z.object({
  version: z.literal(1),
  id: agentConfigFileSchema.shape.id.optional(),
  name: agentDefinitionSchema.shape.name,
  command: agentDefinitionSchema.shape.command.optional(),
  resumeCommand: agentDefinitionSchema.shape.resumeCommand.optional(),
  skills: agentDefinitionSchema.shape.skills,
  capabilities: z.object({ history: z.boolean(), resume: z.boolean(), list: z.boolean().optional() }).strict(),
}).strict();
