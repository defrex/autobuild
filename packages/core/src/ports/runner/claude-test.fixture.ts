import type { AgentStartOpts } from '../types'
import type { ClaudeCliInvocation, ClaudeCliResult, ClaudeCliRunFn } from './claude'

export function event(value: Record<string, unknown>): string {
  return JSON.stringify(value)
}

export function assistant(...texts: string[]): Record<string, unknown> {
  return {
    type: 'assistant',
    message: { content: texts.map((text) => ({ type: 'text', text })) },
  }
}

export function result(
  sessionId: string,
  inputTokens: number,
  outputTokens: number,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    type: 'result',
    subtype: 'success',
    is_error: false,
    session_id: sessionId,
    usage: { input_tokens: inputTokens, output_tokens: outputTokens },
    ...extra,
  }
}

export function output(
  events: Record<string, unknown>[],
  opts: { stderr?: string; exitCode?: number } = {},
): ClaudeCliResult {
  return {
    stdout: events.map(event).join('\n') + (events.length > 0 ? '\n' : ''),
    stderr: opts.stderr ?? '',
    exitCode: opts.exitCode ?? 0,
  }
}

export function fakeCli(
  scripts: Array<ClaudeCliResult | Error | ((call: ClaudeCliInvocation) => ClaudeCliResult)>,
): { calls: ClaudeCliInvocation[]; runCli: ClaudeCliRunFn } {
  const calls: ClaudeCliInvocation[] = []
  return {
    calls,
    runCli: async (call) => {
      calls.push(call)
      const script = scripts[calls.length - 1]
      if (script === undefined) throw new Error('missing fake CLI script')
      if (script instanceof Error) throw script
      return typeof script === 'function' ? script(call) : script
    },
  }
}

export function promptOf(call: ClaudeCliInvocation): string {
  const index = call.args.indexOf('--')
  return call.args[index + 1] ?? ''
}

export function startOpts(overrides: Partial<AgentStartOpts> = {}): AgentStartOpts {
  return {
    skill: 'ab-plan',
    buildSlug: 'auth-rate-limit',
    workspacePath: '/ws/auth-rate-limit',
    env: { AB_BUILD: 'auth-rate-limit', AB_SESSION: 's_9f2' },
    ...overrides,
  }
}
