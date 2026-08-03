import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnExec } from '../src/ports/workspace/git-worktree'
import { captureDashboardFrames, type DashboardCaptureResult } from './dashboard-capture'

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
    'headline-happy-wide',
    'mixed-wide',
    'mixed-narrow',
    'unicode-transcript',
    'resume-prompt',
  ])
  const report = await readFile(first.result.reportPath, 'utf8')
  expect(report).toContain('# Dashboard visual verification')
  expect(report).toContain('headline-happy-wide.png')
  expect(report).toContain('## Headline visual verdict')
  expect(report).toContain('Headline verdict: **[record pass or fail after opening the PNG]**')
  expect(report).toContain('## Verification-fixture visual checklist')
  expect(report).toContain('mixed-wide.png')
  expect(report).toContain('mixed-narrow.txt')
  expect(report).toContain('- [ ] Every PNG opens and is non-empty.')
  expect(report).toContain(
    '- [ ] Both mixed frames show repository PAUSED and CAP-QUEUED as (held) while retaining QUEUED.',
  )
  expect(report).toContain('unicode-transcript.png')
  expect(report).toContain('resume-prompt.png')
  expect(report).toContain('- [ ] The resume-prompt frame shows the composer panel in place of the')
  expect(report).toContain('complete blocker through its unique final line')

  for (const frame of first.result.frames) {
    const again = second.result.frames.find((item) => item.id === frame.id)!
    expect(frame.text).toBe(again.text)
    expect(frame.png).toEqual(again.png)
    expect(frame.png.slice(0, 8)).toEqual(new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]))
    if (frame.id === 'headline-happy-wide') {
      expect(frame.text).toContain('AUT-131')
      expect(frame.text).toContain('AUT-129')
      expect(frame.text).toContain('AUT-133')
      expect(frame.text).toContain('AUT-134')
      expect(frame.text).toContain('AUT-136')
      expect(frame.text).not.toContain('BLOCKED')
    } else if (frame.id.startsWith('mixed-')) {
      expect(frame.text).toContain('CAP-PLAN')
      expect(frame.text).toContain('CAP-IMPLEMENT')
      expect(frame.text).toContain('CAP-COMPLETE')
      expect(frame.text).toContain('Harvest')
      expect(frame.text).toContain('PAUSED')
    } else if (frame.id === 'resume-prompt') {
      expect(frame.text).toContain('Build  plan-blocked-dashboard')
      expect(frame.text).toContain('BLOCKED')
    } else {
      expect(frame.text).toContain('Transcript  complete-dashboard-evidence')
      expect(frame.text).toContain('Agent: naïve — “日本語” ☕️ 🇺🇸 👨‍👩‍👧‍👦')
    }
    if (frame.id !== 'unicode-transcript' && frame.id !== 'headline-happy-wide') {
      expect(frame.text).toContain('BLOCKED')
    }
    expect(frame.text).not.toContain('\x1b')
  }
  const headline = first.result.frames.find((frame) => frame.id === 'headline-happy-wide')!.text
  expect(headline).toContain('intake ON')
  expect(headline).toContain('auto merge ON')
  expect(headline).toContain('harvest ON')
  expect(headline).toContain('active 5/6')
  expect(headline).toMatch(/Harvest\s+3 observations\s+RUNNING/)
  expect(headline).toMatch(/\[x\] scan\([^)]*\) \[>\] synthesize/)
  expect(headline).toMatch(/AUT-136[\s\S]*?\[>\] plan/)
  expect(headline).toMatch(/AUT-134[\s\S]*?\[>\] implement/)
  expect(headline).toMatch(/AUT-133[\s\S]*?\[>\] code-review/)
  expect(headline).toMatch(/AUT-129[\s\S]*?\[>\] verify:unit/)
  expect(headline).toMatch(/AUT-131.*PR merged/)
  expect(headline).toMatch(/plan\([^)]*\/2\)/)
  expect(headline).toMatch(/plan-review\([^)]*\/2\)/)
  expect(headline.match(/AUT-\d+/g)).toHaveLength(5)
  expect(headline).not.toMatch(/\b(?:BLOCKED|PAUSED|held|error|failed|failure)\b/i)
  expect(headline).not.toContain('CAP-')
  expect(headline).not.toMatch(/(?:capture|fixture|harness)/i)
  expect(headline).not.toContain('more rows - Enter details')
  expect(headline).not.toContain('naïve — “日本語”')
  expect(headline.split('\n').some((line) => line.endsWith('~'))).toBe(false)

  for (const id of ['mixed-wide', 'mixed-narrow']) {
    const mixed = first.result.frames.find((frame) => frame.id === id)!.text
    expect(mixed).toContain('repository PAUSED')
    expect(mixed).toContain('CAP-QUEUED')
    expect(mixed).toMatch(/CAP-QUEUED.*\(held\)\s+QUEUED/)
  }
  expect(first.result.frames.find((frame) => frame.id === 'mixed-narrow')!.text).toContain('~')
  for (const id of ['mixed-wide', 'mixed-narrow']) {
    expect(first.result.frames.find((frame) => frame.id === id)!.text).toContain(
      'Unicode warning: naïve — “日本語” ☕️ 🇺🇸 👨‍👩‍👧‍👦',
    )
  }
  for (const id of ['mixed-wide', 'mixed-narrow']) {
    expect(first.result.frames.find((frame) => frame.id === id)!.text).toContain(
      'more rows - Enter details',
    )
  }

  // The composer panel replaces the key legend, states its optional-guidance
  // note, keeps the blocker visible, and renders both typed lines with a caret.
  const resume = first.result.frames.find((frame) => frame.id === 'resume-prompt')!.text
  expect(resume).toContain('Resume plan-blocked-dashboard')
  expect(resume).toMatch(/optional/i)
  expect(resume).toContain(
    'The scripted plan scenario is intentionally blocked for dashboard capture.',
  )
  expect(resume).toContain('EXPANDED FINAL LINE: dashboard message preview complete.')
  expect(resume).not.toContain('more rows - Enter details')
  expect(resume).toContain('Use the manual merge path.')
  expect(resume).toContain('Re-run verify:test |afterwards — naïve — “日本語” ☕️ 🇺🇸 👨‍👩‍👧‍👦.')
  expect(resume).not.toMatch(/\\u\{(?:e[fE]9|2014|1f1fa|1f468)\}/)
  expect(resume).toContain('Enter submit')
  expect(resume).toContain('newline')
  expect(resume).toContain('Esc cancel')
  expect(resume).not.toContain('Up/Down select')

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
  expect(first.result.diagnostics.happy.buildEventsAfter).toEqual(
    first.result.diagnostics.happy.buildEventsBefore,
  )
  expect(first.result.diagnostics.happy.repoJournalUnchanged).toBe(true)
  expect(first.result.diagnostics.happy.forgePolls).toBeGreaterThan(0)
  expect(first.result.diagnostics.happy.autoMergeCalls).toBe(0)
  expect(first.result.diagnostics.happy.squashMergeCalls).toBe(0)
  expect(first.result.diagnostics.happy.buildEventsAfter['cache-warm-on-deploy'].at(-1)).toBe(
    'pr.merged',
  )
  expect(first.result.diagnostics.happy.buildEventsAfter['cache-warm-on-deploy']).not.toContain(
    'build.completed',
  )
  expect(first.result.diagnostics.happy.buildEventsAfter['dashboard-key-legend'].at(-1)).toBe(
    'implement.started',
  )
  expect(first.result.diagnostics.happy.buildEventsAfter['harvest-dedup-window'].at(-1)).toBe(
    'plan.started',
  )
  expect(first.result.diagnostics.happy.buildEventsAfter['parallel-verify-steps'].at(-1)).toBe(
    'verify.started',
  )
  expect(first.result.diagnostics.happy.buildEventsAfter['ticket-source-adapters'].at(-1)).toBe(
    'code-review.started',
  )
}, 30_000)
