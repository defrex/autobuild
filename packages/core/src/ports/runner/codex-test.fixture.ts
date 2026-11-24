import type { AgentStartOpts } from '../types'
import type { CodexCliInvocation, CodexCliResult, CodexCliRunFn } from './codex'

export function event(value: Record<string, unknown>): string {
  return JSON.stringify(value)
}

export function thread(id = 'thread-1'): Record<string, unknown> {
  return { type: 'thread.started', thread_id: id }
}

export function message(text: string): Record<string, unknown> {
  return { type: 'item.completed', item: { id: 'item-1', type: 'agent_message', text } }
}

export function completed(inputTokens = 3, outputTokens = 2): Record<string, unknown> {
  return {
    type: 'turn.completed',
    usage: { input_tokens: inputTokens, output_tokens: outputTokens },
  }
}

export function output(
  events: Record<string, unknown>[],
  opts: { stderr?: string; exitCode?: number } = {},
): CodexCliResult {
  return {
    stdout: events.map(event).join('\n') + (events.length > 0 ? '\n' : ''),
    stderr: opts.stderr ?? '',
    exitCode: opts.exitCode ?? 0,
  }
}

export function fakeCli(
  scripts: Array<CodexCliResult | Error | ((call: CodexCliInvocation) => CodexCliResult)>,
): { calls: CodexCliInvocation[]; runCli: CodexCliRunFn } {
  const calls: CodexCliInvocation[] = []
  return {
    calls,
    runCli: async (call) => {
      calls.push(call)
      const script = scripts[calls.length - 1]
      if (script === undefined) throw new Error('missing fake Codex CLI script')
      if (script instanceof Error) throw script
      return typeof script === 'function' ? script(call) : script
    },
  }
}

export function promptOf(call: CodexCliInvocation): string {
  const delimiter = call.args.lastIndexOf('--')
  return call.args[delimiter + 1] ?? ''
}

export function startOpts(overrides: Partial<AgentStartOpts> = {}): AgentStartOpts {
  return {
    skill: 'ab-plan',
    invocation: 'codex-runtime',
    workspacePath: '/ws/codex-runtime',
    env: { AB_BUILD: 'codex-runtime', AB_SESSION: 's_1' },
    ...overrides,
  }
}
