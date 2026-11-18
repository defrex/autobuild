import { describe, expect, test } from 'bun:test'
import type { Exec, ExecResult } from '../ports/workspace/git-worktree'
import { runPairedMeasurement, type MeasurementInput } from './measurement-runner'

const COMMON = '/repo/.git'
const ROOT = `${COMMON}/autobuild-measure/m-1`
const PIN = 'a'.repeat(40)
const CANDIDATE = 'c'.repeat(40)
const BASELINE = 'b'.repeat(40)

interface Call {
  cmd: string[]
  cwd?: string
}

type Responder = (call: Call, signal?: AbortSignal) => ExecResult | Promise<ExecResult> | undefined

const ok = (stdout = ''): ExecResult => ({ stdout, stderr: '', exitCode: 0 })

function lsTree(paths: string[]): string {
  return paths.map((path) => `100644 blob ${'1'.repeat(40)}\t${path}\0`).join('')
}

/** A fake Exec: Git plumbing succeeds, trees come from `trees`, and the
 * metric command answers through `sample`. */
function fakeExec(opts: {
  trees?: Record<string, string[]>
  sample?: (side: string, index: number) => ExecResult
  respond?: Responder
}) {
  const calls: Call[] = []
  const counts: Record<string, number> = {}
  const exec: Exec = async (cmd, { cwd, signal }) => {
    const call = { cmd, ...(cwd !== undefined ? { cwd } : {}) }
    calls.push(call)
    const custom = await opts.respond?.(call, signal)
    if (custom !== undefined) return custom
    if (cmd[0] === 'git' && cmd[1] === 'rev-parse') return ok(`${COMMON}\n`)
    if (cmd[0] === 'git' && cmd[1] === 'ls-tree') return ok(lsTree(opts.trees?.[cmd[4]!] ?? []))
    if (cmd[0] === 'sh' && cmd[2] === 'bench') {
      const side = cwd!.split('/').at(-1)!
      counts[side] = (counts[side] ?? 0) + 1
      return opts.sample?.(side, counts[side]!) ?? ok(`{"value": ${side === 'baseline' ? 10 : 8}}`)
    }
    return ok()
  }
  return { exec, calls }
}

function input(overrides: Partial<MeasurementInput> = {}): MeasurementInput {
  return {
    workspacePath: '/repo',
    id: 'm/1',
    candidate: CANDIDATE,
    baseline: BASELINE,
    harnessPin: PIN,
    metric: {
      kind: 'command',
      command: 'bench',
      direction: 'minimize',
      samples: 2,
      harness: ['bench/**'],
    },
    ...overrides,
  }
}

const deps = (
  exec: Exec,
  extra: { shutdownSignal?: AbortSignal; timeout?: AbortController } = {},
) => ({
  exec,
  timeoutSignal: () => (extra.timeout ?? new AbortController()).signal,
  ...(extra.shutdownSignal ? { shutdownSignal: extra.shutdownSignal } : {}),
})

const render = (calls: Call[]) => calls.map((call) => `${call.cwd ?? ''}$ ${call.cmd.join(' ')}`)

describe('runPairedMeasurement', () => {
  test('pins the harness in both worktrees, alternates sides and cleans up', async () => {
    const { exec, calls } = fakeExec({
      trees: {
        [PIN]: ['bench/run.sh', 'src/a.ts'],
        [CANDIDATE]: ['bench/run.sh', 'bench/cheat.json', 'src/a.ts'],
        [BASELINE]: ['bench/run.sh', 'src/a.ts'],
      },
    })
    const result = await runPairedMeasurement(deps(exec), input({ setupCommand: 'bun install' }))
    expect(result).toEqual({
      kind: 'measured',
      baseline: [10, 10],
      candidate: [8, 8],
      order: ['baseline', 'candidate', 'candidate', 'baseline'],
    })
    expect(render(calls)).toEqual([
      '/repo$ git rev-parse --path-format=absolute --git-common-dir',
      `/repo$ git worktree remove --force ${ROOT}/baseline`,
      `/repo$ git worktree remove --force ${ROOT}/candidate`,
      `/repo$ rm -rf ${ROOT}`,
      '/repo$ git worktree prune',
      `/repo$ git cat-file -e ${CANDIDATE}^{commit}`,
      `/repo$ git cat-file -e ${BASELINE}^{commit}`,
      `/repo$ git cat-file -e ${PIN}^{commit}`,
      `/repo$ git worktree add --detach ${ROOT}/baseline ${BASELINE}`,
      `/repo$ git worktree add --detach ${ROOT}/candidate ${CANDIDATE}`,
      `/repo$ git ls-tree -r -z ${PIN}`,
      `/repo$ git ls-tree -r -z ${BASELINE}`,
      `${ROOT}/baseline$ git --literal-pathspecs checkout ${PIN} -- bench/run.sh`,
      `/repo$ git ls-tree -r -z ${CANDIDATE}`,
      `${ROOT}/candidate$ git --literal-pathspecs rm -q -f -- bench/cheat.json`,
      `${ROOT}/candidate$ git --literal-pathspecs checkout ${PIN} -- bench/run.sh`,
      `${ROOT}/baseline$ sh -c bun install`,
      `${ROOT}/candidate$ sh -c bun install`,
      `${ROOT}/baseline$ sh -c bench`,
      `${ROOT}/candidate$ sh -c bench`,
      `${ROOT}/candidate$ sh -c bench`,
      `${ROOT}/baseline$ sh -c bench`,
      `/repo$ git worktree remove --force ${ROOT}/baseline`,
      `/repo$ git worktree remove --force ${ROOT}/candidate`,
      '/repo$ git worktree prune',
    ])
  })

  test('a self-measurement at the pin rewrites nothing and fetches a missing pin', async () => {
    const { exec, calls } = fakeExec({
      respond: (call) =>
        call.cmd[1] === 'cat-file' ? { stdout: '', stderr: 'missing', exitCode: 1 } : undefined,
    })
    const result = await runPairedMeasurement(
      deps(exec),
      input({ candidate: PIN, baseline: PIN, metric: { ...input().metric, samples: 1 } }),
    )
    expect(result.kind).toBe('measured')
    const rendered = render(calls)
    expect(rendered).toContain(`/repo$ git fetch --no-tags origin ${PIN}`)
    expect(rendered.filter((line) => line.includes('cat-file'))).toHaveLength(1)
    expect(rendered.some((line) => line.includes('--literal-pathspecs'))).toBe(false)
  })

  test('batches harness paths so argv stays bounded', async () => {
    const many = Array.from({ length: 450 }, (_, index) => `bench/f${index}.json`)
    const { exec, calls } = fakeExec({ trees: { [PIN]: many, [CANDIDATE]: [], [BASELINE]: [] } })
    await runPairedMeasurement(deps(exec), input())
    const checkouts = calls.filter((call) => call.cmd.includes('checkout'))
    expect(checkouts.map((call) => call.cmd.length - 5)).toEqual([200, 200, 50, 200, 200, 50])
  })

  test('a nonzero exit fails naming the sample, and cleanup still runs', async () => {
    const { exec, calls } = fakeExec({
      sample: (side, index) =>
        side === 'candidate' && index === 2
          ? { stdout: 'partial', stderr: 'boom', exitCode: 3 }
          : ok('{"value":1}'),
    })
    const result = await runPairedMeasurement(deps(exec), input())
    expect(result).toEqual({
      kind: 'failed',
      reason: 'exited 3 (candidate sample 2/2)',
      outputTail: 'boom\npartial',
    })
    expect(render(calls).slice(-3)).toEqual([
      `/repo$ git worktree remove --force ${ROOT}/baseline`,
      `/repo$ git worktree remove --force ${ROOT}/candidate`,
      '/repo$ git worktree prune',
    ])
  })

  test('output that is not one JSON object with a numeric value fails', async () => {
    const { exec } = fakeExec({ sample: () => ok('{"value":"fast"}') })
    const result = await runPairedMeasurement(deps(exec), input())
    expect(result).toMatchObject({
      kind: 'failed',
      reason: 'output object has no finite numeric "value" (baseline sample 1/2)',
    })
  })

  test('a timeout fails naming the sample', async () => {
    const timeout = new AbortController()
    const { exec } = fakeExec({
      sample: () => {
        timeout.abort()
        return { stdout: '', stderr: '', exitCode: 143 }
      },
    })
    const result = await runPairedMeasurement(deps(exec, { timeout }), input())
    expect(result).toMatchObject({
      kind: 'failed',
      reason: 'timed out after 30 minutes (baseline sample 1/2)',
    })
  })

  test('a setup failure fails naming the worktree', async () => {
    const { exec } = fakeExec({
      respond: (call) =>
        call.cmd[0] === 'sh' && call.cmd[2] === 'setup'
          ? { stdout: '', stderr: 'no lockfile', exitCode: 1 }
          : undefined,
    })
    const result = await runPairedMeasurement(deps(exec), input({ setupCommand: 'setup' }))
    expect(result).toEqual({
      kind: 'failed',
      reason: '[commands].setup exited 1 (baseline)',
      outputTail: 'no lockfile',
    })
  })

  test('a worktree failure fails without sampling', async () => {
    const { exec, calls } = fakeExec({
      respond: (call) =>
        call.cmd[1] === 'worktree' && call.cmd[2] === 'add'
          ? { stdout: '', stderr: 'fatal: invalid reference', exitCode: 128 }
          : undefined,
    })
    const result = await runPairedMeasurement(deps(exec), input())
    expect(result).toMatchObject({
      kind: 'failed',
      reason: 'creating the baseline worktree failed',
    })
    expect(calls.some((call) => call.cmd[0] === 'sh')).toBe(false)
  })

  test('shutdown interrupts without a result', async () => {
    const shutdown = new AbortController()
    const { exec } = fakeExec({
      sample: () => {
        shutdown.abort()
        return { stdout: '', stderr: '', exitCode: 143 }
      },
    })
    const result = await runPairedMeasurement(
      deps(exec, { shutdownSignal: shutdown.signal }),
      input(),
    )
    expect(result).toEqual({ kind: 'interrupted' })
  })
})
