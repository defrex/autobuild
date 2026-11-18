/**
 * One paired, harness-pinned measurement (SPEC §13.1.1, RFC 0005 §7.3, §7.4).
 * The candidate and the baseline each get a detached worktree under the
 * workspace's Git common directory, both have every harness path overwritten
 * with its contents at the harness pin, and the metric command alternates
 * between them for `samples` rounds. Every Git and shell operation goes
 * through the injected `Exec`, so the sequence is unit-testable.
 *
 * Nothing here writes to the store: the caller records the result, or the
 * escalation, against the state it re-reads afterwards.
 */
import type { ObjectiveMetric } from '../objective'
import {
  harnessDiff,
  MEASUREMENT_RUN_TIMEOUT_MS,
  parseLsTree,
  parseMeasurementOutput,
  sampleOrder,
  type MeasurementSide,
} from '../kernel/measurement'
import type { Exec, ExecResult } from '../ports/workspace/git-worktree'

/** Longest output tail a failure carries into its escalation question. */
const OUTPUT_TAIL_CHARS = 4_000
/** Paths per `git rm` / `git checkout` invocation, so argv stays bounded. */
const PATH_BATCH = 200

export interface MeasurementDeps {
  exec: Exec
  /** A signal that aborts after `ms`. Injectable so unit tests use no timers. */
  timeoutSignal: (ms: number) => AbortSignal
  shutdownSignal?: AbortSignal
}

export interface MeasurementInput {
  /** The build's workspace; its Git common directory holds the scratch worktrees. */
  workspacePath: string
  /** Names the scratch directory; reused ids clean up a crashed predecessor. */
  id: string
  candidate: string
  baseline: string
  harnessPin: string
  metric: Extract<ObjectiveMetric, { kind: 'command' }>
  /** `[commands].setup`, run once in each worktree before sampling. */
  setupCommand?: string
}

export type MeasurementResult =
  | {
      kind: 'measured'
      baseline: number[]
      candidate: number[]
      /** The run order, one side per command run. */
      order: MeasurementSide[]
    }
  | { kind: 'failed'; reason: string; outputTail: string }
  | { kind: 'interrupted' }

class MeasurementFailure extends Error {
  constructor(
    readonly reason: string,
    readonly outputTail = '',
  ) {
    super(reason)
  }
}

class MeasurementInterrupted extends Error {}

function tail(result: Pick<ExecResult, 'stdout' | 'stderr'>): string {
  const text = [result.stderr, result.stdout].filter((part) => part !== '').join('\n')
  return text.length <= OUTPUT_TAIL_CHARS ? text : `…${text.slice(-OUTPUT_TAIL_CHARS)}`
}

function scratchName(id: string): string {
  return id.replace(/[^A-Za-z0-9._-]/g, '-')
}

function batches(paths: readonly string[]): string[][] {
  const out: string[][] = []
  for (let index = 0; index < paths.length; index += PATH_BATCH)
    out.push(paths.slice(index, index + PATH_BATCH))
  return out
}

const TIMEOUT_TEXT = `timed out after ${MEASUREMENT_RUN_TIMEOUT_MS / 60_000} minutes`

export async function runPairedMeasurement(
  deps: MeasurementDeps,
  input: MeasurementInput,
): Promise<MeasurementResult> {
  const { exec } = deps
  const git = async (args: string[], cwd: string, what: string): Promise<ExecResult> => {
    const result = await exec(['git', ...args], { cwd })
    if (result.exitCode !== 0) throw new MeasurementFailure(`${what} failed`, tail(result))
    return result
  }
  /** One bounded command run in a worktree, distinguishing shutdown from timeout. */
  const run = async (command: string, cwd: string): Promise<ExecResult> => {
    if (deps.shutdownSignal?.aborted) throw new MeasurementInterrupted()
    const timeout = deps.timeoutSignal(MEASUREMENT_RUN_TIMEOUT_MS)
    const signal = deps.shutdownSignal ? AbortSignal.any([timeout, deps.shutdownSignal]) : timeout
    let result: ExecResult | undefined
    let error: unknown
    try {
      result = await exec(['sh', '-c', command], { cwd, signal })
    } catch (caught) {
      error = caught
    }
    if (deps.shutdownSignal?.aborted) throw new MeasurementInterrupted()
    if (timeout.aborted) throw new MeasurementFailure(TIMEOUT_TEXT, result ? tail(result) : '')
    if (result === undefined)
      throw new MeasurementFailure(error instanceof Error ? error.message : String(error))
    return result
  }

  const common = await exec(['git', 'rev-parse', '--path-format=absolute', '--git-common-dir'], {
    cwd: input.workspacePath,
  })
  if (common.exitCode !== 0)
    return {
      kind: 'failed',
      reason: 'cannot locate the workspace Git directory',
      outputTail: tail(common),
    }
  const root = `${common.stdout.trim()}/autobuild-measure/${scratchName(input.id)}`
  const sides: Record<MeasurementSide, { sha: string; path: string }> = {
    baseline: { sha: input.baseline, path: `${root}/baseline` },
    candidate: { sha: input.candidate, path: `${root}/candidate` },
  }
  const removeWorktrees = async () => {
    for (const side of Object.values(sides))
      await exec(['git', 'worktree', 'remove', '--force', side.path], {
        cwd: input.workspacePath,
      }).catch(() => undefined)
  }
  // A crashed predecessor with the same id may have left either worktree.
  await removeWorktrees()
  await exec(['rm', '-rf', root], { cwd: input.workspacePath }).catch(() => undefined)
  await exec(['git', 'worktree', 'prune'], { cwd: input.workspacePath }).catch(() => undefined)
  try {
    for (const sha of new Set([input.candidate, input.baseline, input.harnessPin])) {
      const present = await exec(['git', 'cat-file', '-e', `${sha}^{commit}`], {
        cwd: input.workspacePath,
      })
      if (present.exitCode !== 0)
        await git(['fetch', '--no-tags', 'origin', sha], input.workspacePath, `fetching ${sha}`)
    }
    for (const [name, side] of Object.entries(sides))
      await git(
        ['worktree', 'add', '--detach', side.path, side.sha],
        input.workspacePath,
        `creating the ${name} worktree`,
      )

    const tree = async (sha: string) =>
      parseLsTree(
        (await git(['ls-tree', '-r', '-z', sha], input.workspacePath, `listing ${sha}`)).stdout,
      )
    const pinFiles = await tree(input.harnessPin)
    for (const [name, side] of Object.entries(sides)) {
      if (side.sha === input.harnessPin) continue
      const { restore, remove } = harnessDiff(pinFiles, await tree(side.sha), input.metric.harness)
      for (const paths of batches(remove))
        await git(
          ['--literal-pathspecs', 'rm', '-q', '-f', '--', ...paths],
          side.path,
          `removing unpinned harness files from the ${name} worktree`,
        )
      for (const paths of batches(restore))
        await git(
          ['--literal-pathspecs', 'checkout', input.harnessPin, '--', ...paths],
          side.path,
          `restoring pinned harness files in the ${name} worktree`,
        )
    }

    if (input.setupCommand !== undefined)
      for (const [name, side] of Object.entries(sides)) {
        let result: ExecResult
        try {
          result = await run(input.setupCommand, side.path)
        } catch (error) {
          if (error instanceof MeasurementFailure)
            throw new MeasurementFailure(
              `[commands].setup ${error.reason} (${name})`,
              error.outputTail,
            )
          throw error
        }
        if (result.exitCode !== 0)
          throw new MeasurementFailure(
            `[commands].setup exited ${result.exitCode} (${name})`,
            tail(result),
          )
      }

    const values: Record<MeasurementSide, number[]> = { baseline: [], candidate: [] }
    const order: MeasurementSide[] = []
    const rounds = sampleOrder(input.metric.samples)
    for (const [index, pair] of rounds.entries()) {
      for (const name of pair) {
        const where = `${name} sample ${index + 1}/${rounds.length}`
        let result: ExecResult
        try {
          result = await run(input.metric.command, sides[name].path)
        } catch (error) {
          if (error instanceof MeasurementFailure)
            throw new MeasurementFailure(`${error.reason} (${where})`, error.outputTail)
          throw error
        }
        if (result.exitCode !== 0)
          throw new MeasurementFailure(`exited ${result.exitCode} (${where})`, tail(result))
        const parsed = parseMeasurementOutput(result.stdout)
        if ('refusal' in parsed)
          throw new MeasurementFailure(`${parsed.refusal} (${where})`, tail(result))
        values[name].push(parsed.value)
        order.push(name)
      }
    }
    return { kind: 'measured', baseline: values.baseline, candidate: values.candidate, order }
  } catch (error) {
    if (error instanceof MeasurementInterrupted) return { kind: 'interrupted' }
    if (error instanceof MeasurementFailure)
      return { kind: 'failed', reason: error.reason, outputTail: error.outputTail }
    throw error
  } finally {
    await removeWorktrees()
    await exec(['git', 'worktree', 'prune'], { cwd: input.workspacePath }).catch(() => undefined)
  }
}
