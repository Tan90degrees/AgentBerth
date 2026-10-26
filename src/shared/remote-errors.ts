/** Trusted precondition failures, separate from arbitrary remote program output. */
export type RemoteErrorCode = 'USER_CONTROLLED' | 'AGENT_BUSY' | 'DISCONNECTED' | 'SHELL_UNSUPPORTED' | 'PROMPT_REQUIRED' | 'COMMAND_RUNNING' | 'STALE_RUN' | 'SESSION_NOT_OPEN' | 'ALIAS_NOT_FOUND' | 'ALIAS_AMBIGUOUS' | 'OUTCOME_UNKNOWN' | 'CACHE_RANGE_LOST' | 'NO_COMMAND_OUTPUT';
export interface RemoteErrorDetails { sessionId?:string;runId?:string;actionId?:string;alias?:string }
export class RemoteOperationError extends Error {
  constructor(readonly code:RemoteErrorCode,message:string,readonly details:RemoteErrorDetails={}) { super(message); }
}
