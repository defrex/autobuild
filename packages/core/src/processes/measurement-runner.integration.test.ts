import { temporaryDirectories as ownTempDirectories } from '../testing/temp-directories'
import { afterEach, expect, test } from 'bun:test'
import { mkdir, readdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnExec } from '../ports/workspace/git-worktree'
import { median, measurementDecision, measurementDelta } from '../kernel/measurement'
import { type MeasurementResult, runPairedMeasurement } from './measurement-runner'

const mkdtemp = ownTempDirectories(afterEach)

async function git(cwd: string, ...args: string[]): Promise<string> {
  const result = await spawnExec(['git', ...args], { cwd })
  if (result.exitCode !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr}`)
  return result.stdout.trim()
}

/** The harness prints the fixture's number plus the code's cost. */
const BENCH = `#!/bin/sh
base=$(cat bench/fixture.txt)
cost=$(cat src/cost.txt)
extra=0
if [ -f bench/extra.txt ]; then extra=$(cat bench/extra.txt); fi
echo "{\\"value\\": $((base + cost + extra))}"
`

test('a real paired measurement pins the harness and leaves no worktree behind', async () => {
  const repo = await mkdtemp(join(tmpdir(), 'ab-measurement-'))
  await git(repo, 'init', '-q', '-b', 'main')
  await git(repo, 'config', 'user.email', 'test@example.com')
  await git(repo, 'config', 'user.name', 'test')
  await mkdir(join(repo, 'bench'))
  await mkdir(join(repo, 'src'))
  await writeFile(join(repo, 'bench/run.sh'), BENCH)
  await writeFile(join(repo, 'bench/fixture.txt'), '100\n')
  await writeFile(join(repo, 'src/cost.txt'), '50\n')
  await git(repo, 'add', '-A')
  await git(repo, 'commit', '-q', '-m', 'pin')
  const pin = await git(repo, 'rev-parse', 'HEAD')
  // The candidate improves the code, but also games the fixture and adds a
  // harness file that would inflate the baseline-relative gain.
  await writeFile(join(repo, 'src/cost.txt'), '40\n')
  await writeFile(join(repo, 'bench/fixture.txt'), '1\n')
  await writeFile(join(repo, 'bench/extra.txt'), '-1000\n')
  await git(repo, 'add', '-A')
  await git(repo, 'commit', '-q', '-m', 'candidate')
  const candidate = await git(repo, 'rev-parse', 'HEAD')

  const result = await runPairedMeasurement(
    { exec: spawnExec, timeoutSignal: (ms) => AbortSignal.timeout(ms) },
    {
      workspacePath: repo,
      build: 'node-1',
      id: 'attempt-m1',
      candidate,
      baseline: pin,
      harnessPin: pin,
      metric: {
        kind: 'command',
        command: 'sh bench/run.sh',
        direction: 'minimize',
        samples: 3,
        harness: ['bench/**'],
      },
    },
  )
  expect(result).toEqual({
    kind: 'measured',
    baseline: [150, 150, 150],
    candidate: [140, 140, 140],
    order: ['baseline', 'candidate', 'candidate', 'baseline', 'baseline', 'candidate'],
  })
  if (result.kind !== 'measured') throw new Error('unreachable')
  const delta = measurementDelta('minimize', median(result.baseline), median(result.candidate))
  expect(delta).toBe(10)
  expect(measurementDecision(delta, 5)).toBe('improved')
  // The checkout is untouched and every scratch worktree is gone.
  expect(await git(repo, 'status', '--porcelain')).toBe('')
  expect(await git(repo, 'worktree', 'list', '--porcelain')).not.toContain('autobuild-measure/')
  const common = await git(repo, 'rev-parse', '--path-format=absolute', '--git-common-dir')
  const scratch = await readdir(join(common, 'autobuild-measure', 'node-1', 'attempt-m1')).catch(
    () => [],
  )
  expect(scratch).toEqual([])
})

test('two builds measuring the same pin from one Git common directory keep their worktrees apart', async () => {
  const repo = await mkdtemp(join(tmpdir(), 'ab-measurement-'))
  await git(repo, 'init', '-q', '-b', 'main')
  await git(repo, 'config', 'user.email', 'test@example.com')
  await git(repo, 'config', 'user.name', 'test')
  await mkdir(join(repo, 'bench'))
  await mkdir(join(repo, 'src'))
  await writeFile(join(repo, 'bench/run.sh'), BENCH)
  await writeFile(join(repo, 'bench/fixture.txt'), '1\n')
  await writeFile(join(repo, 'src/cost.txt'), '0\n')
  await git(repo, 'add', '-A')
  await git(repo, 'commit', '-q', '-m', 'pin')
  const pin = await git(repo, 'rev-parse', 'HEAD')
  // Each node's workspace is a linked worktree of the same repository.
  const workspaces = await mkdtemp(join(tmpdir(), 'ab-measurement-nodes-'))
  const first = join(workspaces, 'first')
  const second = join(workspaces, 'second')
  await git(repo, 'worktree', 'add', '-q', '--detach', first, pin)
  await git(repo, 'worktree', 'add', '-q', '--detach', second, pin)

  // Hold the first build just before its first sample.
  let reachedSample!: () => void
  const sampling = new Promise<void>((resolve) => (reachedSample = resolve))
  let release!: () => void
  const released = new Promise<void>((resolve) => (release = resolve))
  let held = false
  const pausing: typeof spawnExec = async (cmd, opts) => {
    if (!held && cmd[0] === 'sh') {
      held = true
      reachedSample()
      await released
    }
    return spawnExec(cmd, opts)
  }
  const measure = (build: string, workspacePath: string, exec: typeof spawnExec) =>
    runPairedMeasurement(
      { exec, timeoutSignal: (ms) => AbortSignal.timeout(ms) },
      {
        workspacePath,
        build,
        // The same revision and pin give both nodes the same id.
        id: `baseline-1-${pin}`,
        candidate: pin,
        baseline: pin,
        harnessPin: pin,
        metric: {
          kind: 'command',
          command: 'sh bench/run.sh',
          direction: 'minimize',
          samples: 1,
          harness: ['bench/**'],
        },
      },
    )
  const firstResult = measure('node-first', first, pausing)
  await sampling
  const secondResult = await measure('node-second', second, spawnExec)
  release()
  const measured: MeasurementResult = {
    kind: 'measured',
    baseline: [1],
    candidate: [1],
    order: ['baseline', 'candidate'],
  }
  expect(secondResult).toEqual(measured)
  expect(await firstResult).toEqual(measured)
  expect(await git(repo, 'worktree', 'list', '--porcelain')).not.toContain('autobuild-measure/')
})
