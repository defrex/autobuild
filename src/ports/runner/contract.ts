import { describe, expect, test } from 'bun:test'
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import type {
  AgentRunner,
  AgentSessionHandle,
  AgentTurnResult,
  Transcript,
} from '../types'
import type {
  OneShotCompletion,
  OneShotCompletionInput,
} from './one-shot'
import { AGENT_BIN_DIR } from './session-env'

export type AgentRunnerContractScenario =
  | 'success'
  | 'retryable-failure'
  | 'permanent-failure'

export const CONTRACT_INVOCATION = 'agent-runner-contract'
export const CONTRACT_SKILL = 'ab-runner-contract'
export const CONTRACT_FOLLOW_UP = 'contract follow-up turn'
export const CONTRACT_RETRYABLE_FAILURE = 'contract worker exited unexpectedly'
export const CONTRACT_PERMANENT_FAILURE = 'contract authentication failed'
export const CONTRACT_ONE_SHOT_PROMPT = 'contract one-shot prompt'
export const CONTRACT_ONE_SHOT_TEXT = 'contract-one-shot-result'

/** An observation made below the adapter boundary. Contract fixtures normalize
 * their SDK-specific calls to this shape so the suite can verify delivery and
 * effective process environment without reaching into an adapter. */
export interface AgentRunnerContractTurnObservation {
  /** Undefined for start; the exact follow-up string for continue. */
  message?: string
  env: Record<string, string>
}

export interface AgentRunnerContractOneShotObservation {
  prompt: string
  cwd: string
  env: Record<string, string>
  model?: string
}

export interface AgentRunnerContractOneShotHarness {
  completion: OneShotCompletion
  observation: () => AgentRunnerContractOneShotObservation | undefined
}

export interface AgentRunnerContractHarness {
  runner: AgentRunner
  /** A valid, explicit model identifier for this adapter. */
  model: string
  workspacePath: string
  /** Independent observations from the script/SDK seam, in turn order. */
  turns: () => readonly AgentRunnerContractTurnObservation[]
  /** Present only when the runtime declares the optional capability. */
  oneShot?: AgentRunnerContractOneShotHarness
  cleanup?: () => Promise<void>
}

export type AgentRunnerContractFactory = (
  scenario: AgentRunnerContractScenario,
) => Promise<AgentRunnerContractHarness> | AgentRunnerContractHarness

async function withHarness(
  factory: AgentRunnerContractFactory,
  scenario: AgentRunnerContractScenario,
  run: (harness: AgentRunnerContractHarness) => Promise<void>,
): Promise<void> {
  const harness = await factory(scenario)
  let failure: unknown
  try {
    await run(harness)
  } catch (error) {
    failure = error
  }

  try {
    await harness.cleanup?.()
  } catch (cleanupError) {
    if (failure !== undefined) {
      throw new AggregateError(
        [failure, cleanupError],
        'AgentRunner contract assertion and cleanup both failed',
      )
    }
    throw cleanupError
  }
  if (failure !== undefined) throw failure
}

/** Run assertions while guaranteeing that every successfully launched handle
 * is ended. Assertion and end failures are both retained. */
async function withEndedSession<T>(
  runner: AgentRunner,
  session: AgentSessionHandle,
  run: () => Promise<T>,
): Promise<{ value: T; transcript: Transcript }> {
  let value: T | undefined
  let failure: unknown
  try {
    value = await run()
  } catch (error) {
    failure = error
  }

  let transcript: Transcript | undefined
  try {
    transcript = await runner.end(session)
  } catch (endError) {
    if (failure !== undefined) {
      throw new AggregateError(
        [failure, endError],
        'AgentRunner contract assertion and session end both failed',
      )
    }
    throw endError
  }
  if (failure !== undefined) throw failure
  return { value: value as T, transcript }
}

function expectUsage(usage: {
  inputTokens: number
  outputTokens: number
  turns: number
}): void {
  for (const value of [usage.inputTokens, usage.outputTokens, usage.turns]) {
    expect(Number.isFinite(value)).toBe(true)
    expect(Number.isInteger(value)).toBe(true)
    expect(value).toBeGreaterThanOrEqual(0)
  }
  expect(usage.turns).toBeGreaterThan(0)
}

function expectTypedCompleted(result: AgentTurnResult): void {
  expect(result.kind).toBe('completed')
  expect(typeof result.text).toBe('string')
  expectUsage(result.usage)
}

function expectTranscript(
  transcript: Transcript,
  runner: AgentRunner,
  model: string,
): void {
  expect(transcript.content.trim().length).toBeGreaterThan(0)
  expect(transcript.metadata.runner).toBe(runner.name)
  expect(transcript.metadata.model).toBe(model)
  expectUsage(transcript.metadata.usage)
}

async function invokeManagedCli(env: Record<string, string>): Promise<void> {
  const path = env['PATH']
  expect(path).toBeDefined()
  expect(path!.split(delimiter)[0]).toBe(AGENT_BIN_DIR)

  const proc = Bun.spawn(['ab', '--help'], {
    cwd: process.cwd(),
    env,
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  expect(exitCode).toBe(0)
  expect(stderr).toBe('')
  expect(stdout).toContain('ab — the agent↔store channel')
  expect(stdout).not.toContain('host-conflicting-ab')
}

/**
 * Reusable AgentRunner semantics. Runtime transport, stream extraction,
 * resumption mechanics, and disposal tests remain beside each adapter; this is
 * the behavioral floor a future runtime plugin can run unchanged.
 */
export function describeAgentRunnerContract(
  name: string,
  factory: AgentRunnerContractFactory,
): void {
  describe(`AgentRunner contract: ${name}`, () => {
    test('start/continue are typed, refresh ambient auth, resolve managed ab, and end with a complete transcript', async () => {
      await withHarness(factory, 'success', async (harness) => {
        const conflictDir = await mkdtemp(join(tmpdir(), 'ab-runner-contract-path-'))
        try {
          const conflictingAb = join(conflictDir, 'ab')
          await writeFile(
            conflictingAb,
            '#!/bin/sh\necho host-conflicting-ab\nexit 91\n',
          )
          await chmod(conflictingAb, 0o755)

          const startEnv = {
            PATH: [conflictDir, process.env['PATH'] ?? '']
              .filter((entry) => entry !== '')
              .join(delimiter),
            AB_CONTRACT_START_ONLY: 'retained',
            AB_CONTRACT_COLLIDE: 'start-value',
            AB_PHASE: 'implement@1',
          }
          const started = await harness.runner.start({
            skill: CONTRACT_SKILL,
            invocation: CONTRACT_INVOCATION,
            workspacePath: harness.workspacePath,
            model: harness.model,
            env: startEnv,
          })

          const { transcript } = await withEndedSession(
            harness.runner,
            started.session,
            async () => {
              expect(started.session.id.trim().length).toBeGreaterThan(0)
              expect(started.session.runner).toBe(harness.runner.name)
              expect(started.session.model).toBe(harness.model)
              expectTypedCompleted(started.result)

              const continued = await harness.runner.continue(
                started.session,
                CONTRACT_FOLLOW_UP,
                {
                  env: {
                    AB_CONTRACT_COLLIDE: 'continue-value',
                    AB_CONTRACT_CONTINUE_ONLY: 'fresh',
                    AB_PHASE: 'implement@2',
                  },
                },
              )
              expectTypedCompleted(continued)

              const turns = harness.turns()
              expect(turns).toHaveLength(2)
              expect(turns[0]?.message).toBeUndefined()
              expect(turns[1]?.message).toBe(CONTRACT_FOLLOW_UP)
              expect(turns[0]?.env['AB_CONTRACT_COLLIDE']).toBe('start-value')
              expect(turns[0]?.env['AB_CONTRACT_START_ONLY']).toBe('retained')
              expect(turns[1]?.env['AB_CONTRACT_COLLIDE']).toBe('continue-value')
              expect(turns[1]?.env['AB_CONTRACT_START_ONLY']).toBe('retained')
              expect(turns[1]?.env['AB_CONTRACT_CONTINUE_ONLY']).toBe('fresh')
              expect(turns[1]?.env['AB_PHASE']).toBe('implement@2')
              await invokeManagedCli(turns[0]!.env)
              await invokeManagedCli(turns[1]!.env)
            },
          )
          expectTranscript(transcript, harness.runner, harness.model)
        } finally {
          await rm(conflictDir, { recursive: true, force: true })
        }
      })
    })

    test('an unclassified provider failure stays retryable and keeps an endable handle', async () => {
      await withHarness(factory, 'retryable-failure', async (harness) => {
        const started = await harness.runner.start({
          skill: CONTRACT_SKILL,
          invocation: CONTRACT_INVOCATION,
          workspacePath: harness.workspacePath,
          model: harness.model,
          env: { AB_PHASE: 'implement@1' },
        })
        const { transcript } = await withEndedSession(
          harness.runner,
          started.session,
          async () => {
            expect(started.result).toMatchObject({
              kind: 'failed',
              failure: {
                message: CONTRACT_RETRYABLE_FAILURE,
                permanent: false,
              },
            })
            expectUsage(started.result.usage)
          },
        )
        expectTranscript(transcript, harness.runner, harness.model)
      })
    })

    test('positive authentication/permission/quota evidence is the only permanent fixture', async () => {
      await withHarness(factory, 'permanent-failure', async (harness) => {
        const started = await harness.runner.start({
          skill: CONTRACT_SKILL,
          invocation: CONTRACT_INVOCATION,
          workspacePath: harness.workspacePath,
          model: harness.model,
          env: { AB_PHASE: 'implement@1' },
        })
        const { transcript } = await withEndedSession(
          harness.runner,
          started.session,
          async () => {
            expect(started.result).toMatchObject({
              kind: 'failed',
              failure: {
                message: CONTRACT_PERMANENT_FAILURE,
                permanent: true,
              },
            })
            expectUsage(started.result.usage)
          },
        )
        expectTranscript(transcript, harness.runner, harness.model)
      })
    })

    test('declared one-shot completion forwards its exact input and returns typed text', async () => {
      await withHarness(factory, 'success', async (harness) => {
        if (harness.oneShot === undefined) return
        const input: OneShotCompletionInput = {
          prompt: CONTRACT_ONE_SHOT_PROMPT,
          cwd: harness.workspacePath,
          env: { AB_CONTRACT_ONE_SHOT: 'scoped-value' },
          model: harness.model,
        }
        const result = await harness.oneShot.completion.complete(input)
        expect(result).toEqual({ text: CONTRACT_ONE_SHOT_TEXT })
        const observed = harness.oneShot.observation()
        expect(observed).toBeDefined()
        expect(observed?.prompt).toBe(input.prompt)
        expect(observed?.cwd).toBe(input.cwd)
        expect(observed?.env['AB_CONTRACT_ONE_SHOT']).toBe('scoped-value')
        expect(observed?.model).toBe(input.model)
      })
    })
  })
}
