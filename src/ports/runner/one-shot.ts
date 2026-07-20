/**
 * A narrow, tool-free, non-phase judgment capability. Unlike AgentRunner,
 * one-shot completions have no resumable session, skill invocation,
 * transcript, or typed terminal: callers provide one prompt and consume text
 * as an untrusted proposal behind deterministic validation.
 */

export interface OneShotCompletionInput {
  prompt: string
  /** Working directory used for project context and runtime resolution. */
  cwd: string
  /** Runtime environment (credentials, provider settings, and so on). */
  env: Record<string, string>
  /** Absent means the runtime's own default model. */
  model?: string
  /** Caller-owned cancellation, normally a deterministic deadline. */
  signal?: AbortSignal
}

export interface OneShotCompletionResult {
  text: string
}

/** Optional capability carried by a runtime registration. */
export interface OneShotCompletion {
  complete(input: OneShotCompletionInput): Promise<OneShotCompletionResult>
}
