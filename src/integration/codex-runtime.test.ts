import { expect, test } from 'bun:test'
import { abDispatch } from '../cli/dispatch'
import { reduceBuild } from '../kernel/reducer'
import type { AgentSessionHandle, AgentTurnResult } from '../ports/types'
import {
  CodexAgentRunner,
  type CodexCliInvocation,
  type CodexCliResult,
} from '../ports/runner/codex'
import type { ScriptedAgentRunner } from '../ports/runner/fake'
import { spawnExec } from '../ports/workspace/git-worktree'
import {
  happyHandlers,
  makeHarness,
  ofType,
  readyTicket,
  writeFileIn,
  CONFIG_TOML,
} from './harness'

const CODEX_CONFIG = CONFIG_TOML.replace('runtime = "scripted"', 'runtime = "codex"')
const CODEX_SLUG = 'login-throttling'

function isOneShotCall(call: CodexCliInvocation): boolean {
  return call.args[0] === 'exec' && call.args[1] === '--json' && call.args[2] === '--ephemeral'
}

function jsonl(events: Record<string, unknown>[]): CodexCliResult {
  return {
    stdout: `${events.map((event) => JSON.stringify(event)).join('\n')}\n`,
    stderr: '',
    exitCode: 0,
  }
}

/** Translate the Codex JSONL subprocess protocol onto the integration
 * harness's scripted provider. The pipeline therefore drives the real Codex
 * adapter while phase scripts still invoke the real in-process `ab` CLI. */
function codexTransport(agents: ScriptedAgentRunner) {
  const calls: CodexCliInvocation[] = []
  const sessions = new Map<string, AgentSessionHandle>()
  let nextThread = 0

  const eventsFor = (threadId: string, result: AgentTurnResult): CodexCliResult => {
    const events: Record<string, unknown>[] = [{ type: 'thread.started', thread_id: threadId }]
    if (result.text !== '') {
      events.push({
        type: 'item.completed',
        item: { type: 'agent_message', text: result.text },
      })
    }
    if (result.kind === 'failed') {
      events.push({ type: 'turn.failed', error: { message: result.failure.message } })
    } else {
      events.push({
        type: 'turn.completed',
        usage: {
          input_tokens: result.usage.inputTokens,
          output_tokens: result.usage.outputTokens,
        },
      })
    }
    return jsonl(events)
  }

  return {
    calls,
    runCli: async (call: CodexCliInvocation): Promise<CodexCliResult> => {
      calls.push(call)
      const separator = call.args.lastIndexOf('--')
      const prompt = call.args[separator + 1] ?? ''
      const modelIndex = call.args.indexOf('--model')
      const model = modelIndex >= 0 ? call.args[modelIndex + 1] : undefined
      const resume = call.args[1] === 'resume'

      if (isOneShotCall(call)) {
        return jsonl([
          { type: 'thread.started', thread_id: 'codex-one-shot' },
          {
            type: 'item.completed',
            item: { type: 'agent_message', text: CODEX_SLUG },
          },
          {
            type: 'turn.completed',
            usage: { input_tokens: 1, output_tokens: 1 },
          },
        ])
      }

      if (resume) {
        const threadId = call.args[separator - 1]
        if (threadId === undefined) throw new Error('fake Codex resume omitted thread id')
        const underlying = sessions.get(threadId)
        if (underlying === undefined) throw new Error(`unknown fake Codex thread ${threadId}`)
        const result = await agents.continue(underlying, prompt, { env: call.env })
        return eventsFor(threadId, result)
      }

      const match = /^\$([^ ]+) (.+)$/.exec(prompt)
      if (match === null) throw new Error(`unexpected Codex phase prompt: ${prompt}`)
      nextThread += 1
      const threadId = `codex-thread-${nextThread}`
      const started = await agents.start({
        skill: match[1]!,
        invocation: match[2]!,
        workspacePath: call.cwd,
        ...(model !== undefined ? { model } : {}),
        env: call.env,
      })
      sessions.set(threadId, started.session)
      return eventsFor(threadId, started.result)
    },
  }
}

test('a Codex-only runtime drives a full build and native producer continuation', async () => {
  const handlers = happyHandlers()
  let planReviews = 0
  handlers['plan-review'] = async (cli) => {
    await cli.run(['context'])
    planReviews += 1
    const notes = await writeFileIn(
      cli.ws,
      '.ab/plan-review.md',
      planReviews === 1 ? 'Add one detail.\n' : 'Plan approved.\n',
    )
    if (planReviews === 1) {
      const findings = await writeFileIn(
        cli.ws,
        '.ab/findings-draft.json',
        JSON.stringify([{ severity: 'important', summary: 'Name the marker file explicitly.' }]),
      )
      await cli.run(['verdict', 'revise', '--findings', findings, '--notes', notes])
    } else {
      await cli.run(['verdict', 'approve', '--notes', notes])
    }
  }

  let transport: ReturnType<typeof codexTransport> | undefined
  const h = await makeHarness({
    handlers,
    tickets: [readyTicket('T-CODEX')],
    configToml: CODEX_CONFIG,
    createRuntimeRegistry: (agents) => {
      transport = codexTransport(agents)
      const codex = new CodexAgentRunner({ runCli: transport.runCli })
      return {
        codex: { runner: codex, oneShot: codex, servesModels: ['gpt-'] },
      }
    },
  })

  const dispatchErrors: string[] = []
  try {
    await abDispatch({
      targetRepo: h.origin,
      env: {},
      exec: spawnExec,
      stdout: () => {},
      stderr: (line) => dispatchErrors.push(line),
      once: true,
      wire: () => h.wiring,
    })

    expect(dispatchErrors).toEqual([])
    expect(h.cliErrors).toEqual([])
    expect(planReviews).toBe(2)

    const builds = await h.store.listBuilds()
    expect(builds).toHaveLength(1)
    expect(builds[0]?.slug).toBe(CODEX_SLUG)
    expect(builds[0]?.branch).toBe(`ab/${CODEX_SLUG}`)

    const events = await h.events(CODEX_SLUG)
    expect(reduceBuild(events).prState).toBe('open')
    const started = ofType(events, 'session.started')
    expect(started.length).toBeGreaterThan(0)
    expect(started.every((event) => event.payload.runner === 'codex')).toBe(true)
    expect(started.every((event) => event.payload.model === undefined)).toBe(true)

    const calls = transport?.calls ?? []
    expect(calls.length).toBeGreaterThan(0)
    expect(calls.every((call) => call.args[0] === 'exec')).toBe(true)
    const oneShots = calls.filter(isOneShotCall)
    expect(oneShots).toHaveLength(1)
    const oneShotSeparator = oneShots[0]!.args.lastIndexOf('--')
    const oneShotPrompt = oneShots[0]!.args[oneShotSeparator + 1]
    expect(oneShotPrompt).toContain('Choose a short identifier for this software build.')
    expect(oneShotPrompt).toContain('<build-spec>')
    const resume = calls.find((call) => call.args[1] === 'resume')
    expect(resume).toBeDefined()
    expect(resume?.args).toContain('codex-thread-1')

    const transcripts = await h.store.listArtifacts(CODEX_SLUG, 'transcript')
    expect(transcripts.length).toBeGreaterThan(0)
    expect(transcripts.every((artifact) => artifact.metadata.runner === 'codex')).toBe(true)
    expect(h.forge.opened).toHaveLength(1)
  } finally {
    await h.cleanup()
  }
}, 30_000)
