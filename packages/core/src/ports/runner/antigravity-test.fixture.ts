import type { AgentStartOpts } from '../types'
import type {
  AntigravityCliInvocation,
  AntigravityCliResult,
  AntigravityCliRunFn,
  AntigravityCliStreamFn,
} from './antigravity'

export type Event = Record<string, unknown>

export function init(id = 'conv-1'): Event {
  return { event: 'init', conversation_id: id, init: { cwd: '/ws', tools: [] } }
}

export function step(id: string, index: number, fields: Record<string, unknown>): Event {
  return {
    event: 'step_update',
    step_update: { conversation_id: id, step_index: index, state: 'DONE', ...fields },
  }
}

export function delta(
  id: string,
  index: number,
  text: string,
  state: 'ACTIVE' | 'DONE' = 'DONE',
  usage?: { input_tokens: number; output_tokens: number },
): Event {
  return step(id, index, {
    state,
    step_type: 'agent_response',
    text_delta: text,
    ...(usage !== undefined ? { usage } : {}),
  })
}

export function userInput(id: string, index: number): Event {
  return step(id, index, { step_type: 'user_input' })
}

export function tool(
  id: string,
  index: number,
  name: string,
  parameters: unknown,
  output: unknown,
  state: 'ACTIVE' | 'DONE' = 'DONE',
): Event {
  return step(id, index, {
    state,
    step_type: 'tool',
    tool_name: name,
    tool_info: { name, parameters, ...(state === 'DONE' ? { output } : {}) },
  })
}

export function result(
  id: string,
  opts: {
    status?: string
    response?: string
    error?: string
    usage?: { input_tokens: number; output_tokens: number }
    numTurns?: number
  } = {},
): Event {
  return {
    event: 'result',
    result: {
      conversation_id: id,
      status: opts.status ?? 'SUCCESS',
      ...(opts.response !== undefined ? { response: opts.response } : {}),
      ...(opts.error !== undefined ? { error: opts.error } : {}),
      num_turns: opts.numTurns ?? 1,
      usage: opts.usage ?? { input_tokens: 3, output_tokens: 2 },
    },
  }
}

export function output(
  events: Event[],
  opts: { stderr?: string; exitCode?: number; extra?: string } = {},
): AntigravityCliResult {
  return {
    stdout:
      events.map((event) => JSON.stringify(event)).join('\n') +
      (events.length > 0 ? '\n' : '') +
      (opts.extra ?? ''),
    stderr: opts.stderr ?? '',
    exitCode: opts.exitCode ?? 0,
  }
}

export type Script =
  | AntigravityCliResult
  | Error
  | ((call: AntigravityCliInvocation) => AntigravityCliResult | Promise<AntigravityCliResult>)

export function fakeCli(scripts: Script[]): {
  calls: AntigravityCliInvocation[]
  runCli: AntigravityCliRunFn
} {
  const calls: AntigravityCliInvocation[] = []
  return {
    calls,
    runCli: async (call) => {
      calls.push(call)
      const script = scripts[calls.length - 1]
      if (script === undefined) throw new Error('missing fake agy script')
      if (script instanceof Error) throw script
      return typeof script === 'function' ? script(call) : script
    },
  }
}

/** Line-at-a-time streaming boundary over the same scripts. */
export function fakeStream(scripts: Script[]): {
  calls: AntigravityCliInvocation[]
  runCliStream: AntigravityCliStreamFn
} {
  const buffered = fakeCli(scripts)
  return {
    calls: buffered.calls,
    runCliStream: (call) => {
      const completed = buffered.runCli(call)
      return {
        lines: (async function* () {
          const cli = await completed
          for (const line of cli.stdout.split('\n')) if (line !== '') yield line
        })(),
        result: completed,
      }
    },
  }
}

export function promptOf(call: AntigravityCliInvocation): string {
  return call.args[call.args.lastIndexOf('-p') + 1] ?? ''
}

export function startOpts(overrides: Partial<AgentStartOpts> = {}): AgentStartOpts {
  return {
    skill: 'ab-plan',
    invocation: 'agy-runtime',
    workspacePath: '/ws/agy-runtime',
    env: { AB_BUILD: 'agy-runtime', AB_SESSION: 's_1' },
    ...overrides,
  }
}
