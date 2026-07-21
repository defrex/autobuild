import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnExec } from '../src/ports/workspace/git-worktree'
import {
  captureDashboardFrames,
  type DashboardCaptureResult,
} from './dashboard-capture'

let tmp: string

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'ab-dashboard-capture-'))
})

afterEach(async () => {
  await rm(tmp, { recursive: true, force: true })
})

async function git(cwd: string, ...args: string[]): Promise<string> {
  const result = await spawnExec(['git', ...args], { cwd })
  if (result.exitCode !== 0) throw new Error(result.stderr || result.stdout)
  return result.stdout.trim()
}

interface Run {
  result: DashboardCaptureResult
  status: string
}

async function runCapture(name: string): Promise<Run> {
  const workspace = join(tmp, name)
  await mkdir(join(workspace, '.ab'), { recursive: true })
  await git(tmp, 'init', '-q', '-b', 'main', workspace)
  await writeFile(join(workspace, 'README.md'), 'capture fixture\n')
  await writeFile(join(workspace, '.ab', '.gitignore'), '*\n')
  await git(workspace, 'add', 'README.md')
  await git(
    workspace,
    '-c',
    'user.email=capture@test.invalid',
    '-c',
    'user.name=Capture',
    '-c',
    'commit.gpgsign=false',
    'commit',
    '-q',
    '-m',
    'fixture',
  )

  const result = await captureDashboardFrames({ workspacePath: workspace })
  return { result, status: await git(workspace, 'status', '--porcelain') }
}

test('scripted dispatch capture is deterministic, mixed-state, paired, and source-clean', async () => {
  const first = await runCapture('first')
  const second = await runCapture('second')

  expect(first.status).toBe('')
  expect(second.status).toBe('')
  expect(first.result.outputDir).toEndWith('.ab/dashboard-frames')
  expect(first.result.frames.map((frame) => frame.id)).toEqual([
    'mixed-wide',
    'mixed-narrow',
  ])
  const report = await readFile(first.result.reportPath, 'utf8')
  expect(report).toContain('# Dashboard visual verification')
  expect(report).toContain('mixed-wide.png')
  expect(report).toContain('mixed-narrow.txt')
  expect(report).toContain('- [ ] Every PNG opens and is non-empty.')

  for (const frame of first.result.frames) {
    const again = second.result.frames.find((item) => item.id === frame.id)!
    expect(frame.text).toBe(again.text)
    expect(frame.png).toEqual(again.png)
    expect(frame.png.slice(0, 8)).toEqual(
      new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]),
    )
    expect(frame.text).toContain('CAP-PLAN')
    expect(frame.text).toContain('CAP-IMPLEMENT')
    expect(frame.text).toContain('CAP-COMPLETE')
    expect(frame.text).toContain('BLOCKED')
    expect(frame.text).toContain('RUNNING')
    expect(frame.text).toContain('Harvest')
    expect(frame.text).toContain('PAUSED')
    expect(frame.text).not.toContain('\x1b')
  }
  expect(
    first.result.frames.find((frame) => frame.id === 'mixed-narrow')!.text,
  ).toContain('~')

  for (const frame of first.result.frames) {
    expect(await readFile(frame.textPath, 'utf8')).toBe(frame.text)
    expect([...(await readFile(frame.pngPath))]).toEqual([...frame.png])
  }

  // One scripted FakeForge PR proves finalize composition ran; every agent
  // invocation is the harness's scripted adapter and no fallback handler was
  // reached (that would throw before capture returned).
  expect(first.result.diagnostics.forgeOpened).toBe(1)
  expect(first.result.diagnostics.forgeComments).toBe(1)
  expect(first.result.diagnostics.cliErrors).toEqual([])
  expect(first.result.diagnostics.agentSkills).toContain('ab-plan')
  expect(first.result.diagnostics.agentSkills).toContain('ab-finalize')
  expect(first.result.diagnostics.buildSlugs.sort()).toEqual([
    'complete-dashboard-evidence',
    'implement-blocked-dashboard',
    'plan-blocked-dashboard',
  ])
}, 30_000)
