import { expect } from 'bun:test'
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AgentRunner, AgentTurnResult, Transcript } from '../types'
import type { OneShotCompletion } from './one-shot'
import { AGENT_BIN_DIR } from './session-env'

interface LiveFixture {
  cwd: string
  evidencePath: string
  cleanup: () => Promise<void>
}

interface ProbeEvidence {
  phase: string
  retained: string
  collide: string
  abPath: string
  helpStatus: string
}

async function createLiveFixture(): Promise<LiveFixture> {
  const cwd = await mkdtemp(join(tmpdir(), 'ab-runner-live-contract-'))
  try {
    const skillDir = join(cwd, '.agents', 'skills', 'ab-runner-contract')
    const claudeSkills = join(cwd, '.claude', 'skills')
    await mkdir(skillDir, { recursive: true })
    await mkdir(claudeSkills, { recursive: true })
    const skillPath = join(skillDir, 'SKILL.md')
    await writeFile(
      skillPath,
      `---\nname: ab-runner-contract\ndescription: Live AgentRunner contract probe.\ndisable-model-invocation: true\n---\n\n# Runner contract probe\n\nImmediately use the bash tool to execute \`./contract-probe\` exactly once.\nWait for it to finish, then reply with the single word \`probed\`.\n`,
    )
    const claudeSkill = join(claudeSkills, 'ab-runner-contract')
    try {
      await symlink(skillDir, claudeSkill, 'dir')
    } catch {
      await mkdir(claudeSkill, { recursive: true })
      await copyFile(skillPath, join(claudeSkill, 'SKILL.md'))
    }

    const evidencePath = join(cwd, 'contract-evidence.tsv')
    const probePath = join(cwd, 'contract-probe')
    await writeFile(
      probePath,
      `#!/bin/sh\nset -eu\nab_path="$(command -v ab)"\nif ab --help >/dev/null 2>&1; then help=0; else help=$?; fi\nprintf '%s\\t%s\\t%s\\t%s\\t%s\\n' "\${AB_CONTRACT_PHASE:-}" "\${AB_CONTRACT_RETAINED:-}" "\${AB_CONTRACT_COLLIDE:-}" "$ab_path" "$help" >> ${JSON.stringify(evidencePath)}\n`,
    )
    await chmod(probePath, 0o755)
    return {
      cwd,
      evidencePath,
      cleanup: () => rm(cwd, { recursive: true, force: true }),
    }
  } catch (error) {
    await rm(cwd, { recursive: true, force: true })
    throw error
  }
}

async function evidence(path: string): Promise<ProbeEvidence[]> {
  const content = await readFile(path, 'utf8')
  return content
    .trim()
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => {
      const [phase = '', retained = '', collide = '', abPath = '', helpStatus = ''] =
        line.split('\t')
      return { phase, retained, collide, abPath, helpStatus }
    })
}

function expectCompleted(result: AgentTurnResult): void {
  expect(result.kind).toBe('completed')
  expect(Number.isInteger(result.usage.inputTokens)).toBe(true)
  expect(Number.isInteger(result.usage.outputTokens)).toBe(true)
  expect(result.usage.turns).toBeGreaterThan(0)
}

function expectTranscript(transcript: Transcript, runner: AgentRunner, model: string): void {
  expect(transcript.content.trim()).not.toBe('')
  expect(transcript.metadata.runner).toBe(runner.name)
  expect(transcript.metadata.model).toBe(model)
  expect(transcript.metadata.usage.turns).toBeGreaterThanOrEqual(2)
}

/** Successful real-provider smoke coverage. Deterministic failure taxonomy is
 * deliberately covered by the full injected adapter contract instead. */
export async function runLiveAgentRunnerContract(
  runner: AgentRunner & OneShotCompletion,
  model: string,
): Promise<void> {
  const fixture = await createLiveFixture()
  let failure: unknown
  try {
    const started = await runner.start({
      skill: 'ab-runner-contract',
      invocation: 'live-contract',
      workspacePath: fixture.cwd,
      model,
      env: {
        AB_CONTRACT_PHASE: 'start',
        AB_CONTRACT_RETAINED: 'retained',
        AB_CONTRACT_COLLIDE: 'start-value',
      },
    })
    let transcript: Transcript | undefined
    try {
      expect(started.session.id.trim()).not.toBe('')
      expect(started.session.runner).toBe(runner.name)
      expect(started.session.model).toBe(model)
      expectCompleted(started.result)
      expect(await evidence(fixture.evidencePath)).toEqual([
        {
          phase: 'start',
          retained: 'retained',
          collide: 'start-value',
          abPath: join(AGENT_BIN_DIR, 'ab'),
          helpStatus: '0',
        },
      ])

      const continued = await runner.continue(
        started.session,
        'Use the bash tool to execute `./contract-probe` exactly once, wait for it, then reply with exactly the same single word as your previous response.',
        {
          env: {
            AB_CONTRACT_PHASE: 'continue',
            AB_CONTRACT_COLLIDE: 'continue-value',
          },
        },
      )
      expectCompleted(continued)
      expect(continued.text.trim()).toBe('probed')
      expect(await evidence(fixture.evidencePath)).toEqual([
        {
          phase: 'start',
          retained: 'retained',
          collide: 'start-value',
          abPath: join(AGENT_BIN_DIR, 'ab'),
          helpStatus: '0',
        },
        {
          phase: 'continue',
          retained: 'retained',
          collide: 'continue-value',
          abPath: join(AGENT_BIN_DIR, 'ab'),
          helpStatus: '0',
        },
      ])
    } catch (error) {
      failure = error
    }

    try {
      transcript = await runner.end(started.session)
    } catch (endError) {
      if (failure !== undefined) {
        throw new AggregateError(
          [failure, endError],
          'live AgentRunner assertion and session end both failed',
        )
      }
      throw endError
    }
    if (failure !== undefined) throw failure
    expectTranscript(transcript, runner, model)

    const nonce = crypto.randomUUID()
    const oneShot = await runner.complete({
      prompt: `Reply with exactly this token and no other text: ${nonce}`,
      cwd: fixture.cwd,
      env: { AB_CONTRACT_ONE_SHOT: nonce },
      model,
    })
    expect(oneShot.text.trim()).toContain(nonce)
  } finally {
    await fixture.cleanup()
  }
}

/** Process A returns only its observed handle; process B has no adapter memory
 * or secret-bearing prompt/environment. This also drives offline CLI fixtures. */
export async function runNativeAdapterChild(input: {
  provider: string
  opts: import('../types').AgentStartOpts
  handle?: import('../types').NativeSessionHandle
  message?: string
}): Promise<unknown> {
  const child = Bun.spawn(
    [process.execPath, new URL('./native-process-fixture.ts', import.meta.url).pathname],
    {
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
    },
  )
  child.stdin.write(JSON.stringify(input))
  child.stdin.end()
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  if (code !== 0) throw new Error(`Native adapter child exited ${code}: ${stderr}`)
  return JSON.parse(stdout)
}

export async function runLiveNativeResumeContract(provider: string, model: string): Promise<void> {
  const fixture = await createLiveFixture()
  try {
    await writeFile(
      join(fixture.cwd, '.agents/skills/ab-runner-contract/SKILL.md'),
      `---\nname: ab-runner-contract\ndescription: Native memory probe\n---\nRemember the exact invocation argument as a memory-only code. Never write it to a file. Run ./contract-probe once and reply only probed.\n`,
    )
    const secret = crypto.randomUUID()
    const opts = {
      skill: 'ab-runner-contract',
      invocation: secret,
      workspacePath: fixture.cwd,
      model,
      env: { AB_CONTRACT_PHASE: 'start' },
    }
    const handle = (await runNativeAdapterChild({
      provider,
      opts,
    })) as import('../types').NativeSessionHandle
    const resumed = (await runNativeAdapterChild({
      provider,
      handle,
      opts: { ...opts, invocation: 'resumed-probe', env: { AB_CONTRACT_PHASE: 'resume' } },
      message:
        'Recall the exact memory-only code from the initial skill invocation. Run ./contract-probe once, then reply with that code.',
    })) as {
      result: AgentTurnResult
      handle: import('../types').NativeSessionHandle
      transcript: Transcript
    }
    expect(resumed.handle).toEqual(handle)
    expectCompleted(resumed.result)
    expect(resumed.result.text).toContain(secret)
    expect(resumed.transcript.content).toContain(secret)
    expect(resumed.transcript.metadata.usage.turns).toBe(1)
    const rows = await evidence(fixture.evidencePath)
    expect(rows.map((row) => row.phase)).toEqual(['start', 'resume'])
    for (const row of rows) {
      expect(row.helpStatus).toBe('0')
      expect(row.abPath).toBe(join(AGENT_BIN_DIR, 'ab'))
    }
  } finally {
    await fixture.cleanup()
  }
}
