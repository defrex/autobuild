import { captureEnvironment } from './capture-parity'
import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { cellWidth } from '../packages/core/src/cli/dashboard/cells'
import { stripAnsi } from '../packages/core/src/cli/dashboard/render'
import { spawnExec } from '../packages/core/src/ports/workspace/git-worktree'
import { type DashboardCaptureResult, WEBSITE_HERO_COLUMNS } from './dashboard-capture'

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

  // Launch with the same explicit environment as pixel parity. Git provenance
  // appears in detail frames and must not depend on when each fixture ran.
  const child = Bun.spawn(
    [
      'bun',
      '-e',
      `import {captureDashboardFrames} from './tools/dashboard-capture'; const result = await captureDashboardFrames({workspacePath: process.argv[1]}); console.log(JSON.stringify(result, (key, value) => key === 'png' ? undefined : value));`,
      workspace,
    ],
    { cwd: join(import.meta.dir, '..'), env: captureEnvironment(), stdout: 'pipe', stderr: 'pipe' },
  )
  const [output, error, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  expect(code, error).toBe(0)
  const result = JSON.parse(output) as DashboardCaptureResult
  for (const frame of result.frames) frame.png = new Uint8Array(await readFile(frame.pngPath))
  return { result, status: await git(workspace, 'status', '--porcelain') }
}

test('scripted dispatch capture is deterministic, mixed-state, paired, and source-clean', async () => {
  const first = await runCapture('first')
  const second = await runCapture('second')

  expect(first.status).toBe('')
  expect(second.status).toBe('')
  expect(first.result.outputDir).toEndWith('.ab/dashboard-frames')
  expect(first.result.frames.map((frame) => frame.id)).toEqual([
    'rollback-wide',
    'rollback-narrow',
    'handoff-wide',
    'handoff-narrow',
    'harvest-suspended-wide',
    'harvest-suspended-narrow',
    'capacity-wide',
    'integration-detail-wide',
    'integration-detail-narrow',
    'integration-detail-conflict',
    'integration-detail-failed',
    'integration-detail-ready-node',
    'integration-wide',
    'integration-narrow',
    'post-reconcile-policy',
    'verify-stages-wide',
    'headline-happy-wide',
    'website-hero',
    'mixed-wide',
    'mixed-narrow',
    'unicode-transcript',
    'native-sessions',
    'session-live',
    'session-closed',
    'resume-prompt',
    'standby-list',
    'standby-detail',
    'forge-readiness-wide',
    'forge-readiness-narrow',
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
    if (frame.id.startsWith('rollback-')) {
      expect(frame.text.replace(/\s+/g, ' ')).toContain(
        'rollback: failed 1.1.0 bbbbbbbbbbbb; restored 1.0.0 aaaaaaaaaaaa; held 1.1.0 bbbbbbbbbbbb; at 2026-07-15T12:10:00.000Z',
      )
      expect(frame.model.rollback?.correlation).toBe('capture-rollback')
      expect(frame.model.builds.every((row) => row.status === 'running')).toBe(true)
    } else if (frame.id.startsWith('handoff-')) {
      expect(frame.text).toContain('handoff 1.0.0 aaaaaaaaaaaa to 1.1.0 bbbbbbbbbbbb; mode drain;')
      expect(frame.text).toContain('2026-07-15T12:15:00.000Z')
      expect(frame.text).toContain('(draining)')
      expect(frame.model.builds.filter((row) => row.draining)).toHaveLength(1)
      expect(frame.model.builds.every((row) => row.status === 'running')).toBe(true)
    } else if (frame.id === 'capacity-wide') {
      expect(frame.model.capacity).toEqual({
        configured: 4,
        occupied: 5,
        effective: 5,
        borrowingNodes: ['queue-conflict'],
      })
      expect(frame.text).toContain('descendant-held slots')
    } else if (frame.id === 'headline-happy-wide' || frame.id === 'website-hero') {
      expect(frame.text).toContain('AUT-131')
      expect(frame.text).toContain('AUT-129')
      expect(frame.text).toContain('AUT-133')
      expect(frame.text).toContain('AUT-134')
      expect(frame.text).toContain('AUT-136')
      expect(frame.text).not.toContain('BLOCKED')
    } else if (frame.id.startsWith('forge-readiness-')) {
      expect(frame.text).toContain('Forge squash')
      expect(frame.text).toContain('Forge rebase')
      expect(frame.text).toContain('Allow squash merging')
      expect(frame.text).toContain('Allow rebase merging')
    } else if (frame.id.startsWith('integration-detail-')) {
      expect(frame.text).toContain('Verification')
      expect(frame.text).toContain('Merge')
      if (frame.id.endsWith('wide') || frame.id.endsWith('narrow')) {
        expect(frame.text).toContain('3 open · 8 merged')
        expect(frame.text).toContain('implement')
        expect(frame.text).toContain('code-review')
        expect(frame.text).toContain('Queued documentation work')
      }
    } else if (frame.id.startsWith('integration-')) {
      expect(frame.text).toContain('active 4/4')
      expect(frame.text).not.toContain('QUEUE-5')
      expect(frame.text).toContain('integration')
      expect(frame.text).toContain('8/11 merged')
      expect(frame.text).toContain('2 building')
      expect(frame.text).toContain('1 queued')
      expect(frame.text).toContain('unit failed')
      expect(frame.text).toContain('ready to merge into')
      expect(frame.text).toContain('empty')
    } else if (frame.id === 'post-reconcile-policy') {
      // Preparation journal facts participate in the deterministic fixture clock.
      expect(frame.text).toContain('merge (waiting, 7m45s)')
      expect(frame.text).toContain('skipped by post-reconcile policy')
      expect(frame.text).toContain('verify.afterReconcile = false')
    } else if (frame.id.startsWith('mixed-')) {
      expect(frame.text).toContain('CAP-PLAN')
      expect(frame.text).toContain('CAP-IMPLEMENT')
      expect(frame.text).toContain('CAP-COMPLETE')
      expect(frame.text).toContain('Harvest')
      expect(frame.text).toContain('PAUSED')
    } else if (frame.id.startsWith('standby-')) {
      expect(frame.text).toContain('Dispatcher on standby: repository held by peer-run')
      if (frame.id === 'standby-list') {
        expect(frame.text).toContain('run ab upgrade')
        expect(frame.text).toContain('Unicode warning')
      }
    } else if (frame.id === 'resume-prompt') {
      expect(frame.text).toContain('Build  plan-blocked-dashboard')
      expect(frame.text).toContain('BLOCKED')
    } else if (frame.id.startsWith('harvest-suspended-')) {
      expect(frame.text).toContain('SUSPENDED')
      expect(frame.text).not.toContain('synthesize[>]')
      expect(frame.model.harvest?.action).toBeUndefined()
    } else if (frame.id === 'native-sessions') {
      expect(frame.text).toContain('suspended cause pause')
      expect(frame.text).toContain('fresh session: workspace-not-local-git-worktree')
      expect(frame.text).toContain('resumed cause pause continued from s_interrupted')
    } else if (frame.id === 'verify-stages-wide') {
      expect(
        frame.model.builds[0]!.steps.filter((step) => step.state === 'current').map(
          (step) => step.label,
        ),
      ).toEqual(['verify:unit', 'verify:integration'])
      expect(frame.text).toContain('not run: cancelled by verify:unit')
    } else if (frame.id.startsWith('session-')) {
      expect(frame.text).toContain('Session  complete-dashboard-evidence')
      if (frame.id === 'session-live') {
        expect(frame.text).toContain('· live')
        expect(frame.text).toContain('waiting for output')
        expect(frame.text).toContain('following tail')
        expect(frame.text).not.toContain('ERROR')
      } else {
        expect(frame.text).toContain('Stream closed: completed')
        expect(frame.text).toContain('more rows withheld')
        expect(frame.text).toContain('bytes truncated')
      }
    } else {
      expect(frame.text).toContain('Transcript  complete-dashboard-evidence')
      expect(frame.text).toContain('Agent: naïve — “日本語” ☕️ 🇺🇸 👨‍👩‍👧‍👦')
    }
    if (
      frame.id !== 'integration-wide' &&
      frame.id !== 'capacity-wide' &&
      frame.id !== 'post-reconcile-policy' &&
      frame.id !== 'unicode-transcript' &&
      frame.id !== 'headline-happy-wide' &&
      frame.id !== 'website-hero' &&
      !frame.id.startsWith('harvest-suspended-') &&
      !frame.id.startsWith('handoff-') &&
      !frame.id.startsWith('rollback-') &&
      !frame.id.startsWith('session-') &&
      !frame.id.startsWith('integration-detail-')
    ) {
      expect(frame.text).toContain('BLOCKED')
    }
    expect(frame.text).not.toContain('\x1b')
  }
  const headline = first.result.frames.find((frame) => frame.id === 'headline-happy-wide')!.text
  expect(headline).toContain('intake ON')
  expect(headline).not.toContain('auto merge ON')
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

  // The website hero is the headline scenario at the narrowest width that
  // keeps every pipeline row whole: the same words, only the pinning differs.
  const hero = first.result.frames.find((frame) => frame.id === 'website-hero')!
  expect(hero.terminal).toEqual({ columns: WEBSITE_HERO_COLUMNS, rows: 40 })
  expect(hero.text.replace(/ +/g, ' ')).toBe(headline.replace(/ +/g, ' '))
  expect(hero.text.split('\n').some((line) => line.endsWith('~'))).toBe(false)
  for (const line of hero.lines) {
    expect(cellWidth(stripAnsi(line))).toBeLessThanOrEqual(WEBSITE_HERO_COLUMNS)
  }
  expect(hero.lines.some((line) => line.includes('\x1b['))).toBe(true)

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
  const composer = resume.slice(resume.indexOf('Resume plan-blocked-dashboard'))
  expect(composer).toContain(
    'The scripted plan scenario is intentionally blocked for dashboard capture.',
  )
  expect(composer).toMatch(/\.\.\. and \d+ more lines/)
  expect(composer).not.toContain('EXPANDED FINAL LINE: dashboard message preview complete.')
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
  // The seeded journal is the pinned fixture: a repeated consecutive event
  // would shift every subsequent seq. A future legitimately repeated event
  // (retry, parallel step) must revisit this tripwire rather than append
  // blindly.
  for (const events of Object.values(first.result.diagnostics.happy.buildEventsAfter)) {
    for (const [index, type] of events.entries()) {
      expect(events[index - 1]).not.toBe(type)
    }
  }
  expect(
    first.result.diagnostics.happy.buildEventsAfter['cache-warm-on-deploy'].filter(
      (type) => type === 'verify.started',
    ),
  ).toHaveLength(1)
  expect(
    first.result.diagnostics.happy.buildEventsAfter['parallel-verify-steps'].filter(
      (type) => type === 'verify.started',
    ),
  ).toHaveLength(1)
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
  expect(
    first.result.diagnostics.happy.buildEventsAfter['dashboard-key-legend']
      .filter((type) => type !== 'target.distance')
      .at(-1),
  ).toBe('implement.started')
  expect(
    first.result.diagnostics.happy.buildEventsAfter['harvest-dedup-window']
      .filter((type) => type !== 'target.distance')
      .at(-1),
  ).toBe('plan.started')
  expect(
    first.result.diagnostics.happy.buildEventsAfter['parallel-verify-steps']
      .filter((type) => type !== 'target.distance')
      .at(-1),
  ).toBe('verify.started')
  expect(
    first.result.diagnostics.happy.buildEventsAfter['ticket-source-adapters']
      .filter((type) => type !== 'target.distance')
      .at(-1),
  ).toBe('code-review.started')
  // Two full captures took 82.2s on the 4-vCPU sandbox with verification suites
  // and diagnostic checks overlapping; retain headroom without reducing evidence.
}, 120_000)
