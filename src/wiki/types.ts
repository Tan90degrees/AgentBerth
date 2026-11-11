// The notes wiki keeps Markdown as the source of truth. Every derived field
// (index, log, link graph, drafts) can be rebuilt from these documents.
export type PageKind = 'concept' | 'entity' | 'source' | 'comparison' | 'overview' | 'note';
export type SkillKind = 'ingest' | 'compile' | 'query' | 'lint' | 'synthesize' | 'custom';

/** A verbatim quote from an immutable raw source, stored on a wiki page so a
 * reader (or an Agent) can jump from a compiled claim back to its evidence. */
export interface SourceEvidence {
  sourceId: string;
  quote: string;
}

/** Evidence resolved against the actual source text, ready to render. */
export interface SourceExcerpt {
  sourceId: string;
  title: string;
  quote: string;
  context: string;
  verified: boolean;
}

export interface WikiPage {
  slug: string;
  title: string;
  summary: string;
  kind: PageKind;
  sources: string[];
  evidence: SourceEvidence[];
  tags: string[];
  body: string;
  humanEdited: boolean;
  hash: string;
  createdAt: string;
  updatedAt: string;
}

export interface WikiSource {
  id: string;
  title: string;
  text: string;
  images: string[];
  vision: string;
  staging?: boolean;
  compiled: boolean;
  hash: string;
  createdAt: string;
  document?: { name: string; asset: string; hash?: string; pages: number; ranges: { page: number; start: number; end: number }[] };
}

export interface WikiSkill {
  name: string;
  description: string;
  kind: SkillKind;
  triggers: string[];
  body: string;
  builtin: boolean;
  updatedAt: string;
}

export interface DraftPage {
  slug: string;
  title: string;
  summary: string;
  kind: PageKind;
  body: string;
  sources: string[];
  evidence: SourceEvidence[];
  tags: string[];
  previous: string | null;
  action: 'create' | 'update' | 'skip';
  selected?: boolean;
  allowHumanMerge?: boolean;
  reviewEdited?: boolean;
}

export interface WikiDraft {
  id: string;
  sourceId: string | null;
  sourceTitle: string;
  sourceHash?: string;
  createdAt: string;
  model: string;
  summary: string;
  pages: DraftPage[];
  contradictions: string[];
  feedback: string[];
  status: 'pending' | 'approved' | 'rejected';
  resolvedAt?: string;
  coverage?: { characters: number; segments: number; complete: boolean };
}

export interface WikiTask {
  id: string;
  kind: 'compile' | 'ask' | 'lint' | 'vision' | 'archive' | 'capture';
  label: string;
  status: 'queued' | 'running' | 'done' | 'failed' | 'cancelled';
  progress: string;
  startedAt: string;
  finishedAt?: string;
  error?: string;
  result?: unknown;
  /** Interrupted requests require explicit retry, including auto-compile. */
  manualRetry?: boolean;
  retry?: { action: string; params: Record<string, unknown> };
}

export interface WikiLint {
  at: string;
  orphans: string[];
  brokenLinks: { from: string; to: string }[];
  missingSummary: string[];
  contradictions: { page: string; text: string }[];
  stale: string[];
  suggestions: string[];
}

export interface WikiAnswer {
  question: string;
  answer: string;
  citations: string[];
  pages: string[];
  evidence: SourceExcerpt[];
  model: string;
  at: string;
}

export interface WikiStatus {
  pages: number;
  sources: number;
  pendingDrafts: number;
  skills: number;
  links: number;
  orphans: number;
  model: { baseURL: string; textModel: string; visionModel: string; keyConfigured: boolean; keyHint: string };
  automation: { autoCompile: boolean; autoApprove: boolean; lintMinutes: number };
  lastLint: string | null;
  tasks: WikiTask[];
  ready: boolean;
}

export interface WikiConfig {
  baseURL: string;
  textModel: string;
  visionModel: string;
  autoCompile: boolean;
  autoApprove: boolean;
  allowAgentAccess?: boolean;
  allowAgentQueries?: boolean;
  lintMinutes: number;
  maxContextPages: number;
  authRequired?: boolean;
}
