/**
 * The renderer (src/cli/dashboard/render.ts) — pure, so every AC about what
 * the operator can SEE is assertable here without a terminal.
 */
import { describe, expect, test } from 'bun:test'
import { renderDashboardFrameImage } from './frame-image'
import { formatDuration, renderDashboard, stripAnsi, type RenderOpts } from './render'
import type { DashboardBuild, DashboardHarvest, DashboardModel, PipelineStep } from './model'

/** A fixed render clock. Most tests carry no running timing, so the value is
 * irrelevant to them; the ticking tests pass `now` explicitly. */
const NOW = 1_700_000_000_000

/** `renderDashboard` with a default `now`, so the many layout/plain/height tests
 * need not thread a clock they don't exercise. Pass `now` in `opts` to override
 * (the ticking/freezing tests do). */
function rd(m: DashboardModel, opts: Omit<RenderOpts, 'now'> & { now?: number }): string[] {
  return renderDashboard(m, { now: NOW, ...opts })
}

/**
 * The default fixture carries a `pr` on purpose. Without one, no test ever
 * truncated a line containing a hyperlink — which is exactly how an unclosed
 * OSC 8 (`f_f72ad952`) survived a green suite.
 */
function harvest(overrides: Partial<DashboardHarvest> = {}): DashboardHarvest {
  return {
    kind: 'harvest',
    run: 'harvest_internal_123',
    status: 'running',
    observations: 36,
    rounds: 1,
    steps: [
      { label: 'scan', state: 'done' },
      { label: 'synthesize', state: 'current' },
      { label: 'review', state: 'pending' },
      { label: 'file', state: 'pending' },
    ],
    ...overrides,
  }
}

function build(overrides: Partial<DashboardBuild> = {}): DashboardBuild {
  return {
    slug: 'auth-rate-limit',
    status: 'running',
    alsoPaused: false,
    ticketId: 'ENG-42',
    steps: [
      { label: 'plan', state: 'done', timing: { accumulatedMs: 252_000 } }, // 4m12s
      { label: 'implement', state: 'current', count: 2, timing: { accumulatedMs: 38_000 } },
      { label: 'code-review', state: 'provisional' },
      { label: 'verify:test', state: 'pending' },
    ],
    blockers: [],
    pr: { url: 'https://github.com/defrex/app/pull/7', state: 'open' },
    ...overrides,
    autoMerge: overrides.autoMerge ?? 'off',
  }
}

/**
 * How many OSC 8 hyperlinks a line leaves OPEN. `\x1b]8;;<url>\x07` opens one,
 * `\x1b]8;;\x07` closes it; a hyperlink is a stateful terminal mode, so a line
 * that ends with one open leaks it into everything painted afterwards.
 */
function unclosedLinks(line: string): number {
  const all = line.match(/\x1b\]8;;[^\x07]*\x07/g) ?? []
  const closes = all.filter((s) => s === '\x1b]8;;\x07').length
  return all.length - closes - closes
}

function model(builds: DashboardBuild[]): DashboardModel {
  return {
    repo: '/repos/app',
    queued: 2,
    drained: false,
    defaultAutoMerge: false,
    harvestPaused: false,
    builds,
  }
}

const WIDE = { color: false, width: 200 }

describe('renderDashboard: two-line header and conditional warning', () => {
  test('summary is first, controls are second, and both start at the title column', () => {
    const lines = rd(model([build()]), WIDE).map(stripAnsi)
    const summary = lines[0]!
    const toggles = lines[1]!
    expect(summary).toContain('Auto Build')
    expect(summary).toContain('app') // the repo basename
    expect(summary).not.toContain('/repos/app')
    expect(summary).toContain('queue 2 | active 1')
    expect(summary).not.toMatch(/\b(?:watch|once)\b/)
    expect(summary).not.toContain('intake ON')
    expect(toggles).toContain('intake ON')
    expect(toggles).toContain('auto merge OFF')
    expect(toggles).toContain('harvest ON')
    expect(summary.indexOf('Auto Build')).toBe(2)
    expect(toggles.search(/\S/)).toBe(summary.indexOf('Auto Build'))
    expect(lines.slice(0, -1).join('\n')).not.toContain('Ctrl-C to stop')
  })

  test('the warning row is absent until needed, then appears aligned below both headers', () => {
    const clean = rd(model([build()]), WIDE).map(stripAnsi)
    expect(clean[2]).toBe('')

    const warned = rd({ ...model([build()]), warningLine: 'ticket source unavailable' }, WIDE).map(
      stripAnsi,
    )
    expect(warned[2]).toBe('  ticket source unavailable')
    expect(warned[2]!.search(/\S/)).toBe(warned[0]!.indexOf('Auto Build'))
    expect(warned[3]).toBe('')
    expect(warned).toHaveLength(clean.length + 1)
  })

  test('long, multiline, and non-ASCII warnings stay on one safe physical row', () => {
    const clean = rd(model([build()]), { color: true, width: 40 })
    const warned = rd(
      {
        ...model([build()]),
        warningLine: `warning\n${'x'.repeat(100)} café`,
      },
      { color: true, width: 40 },
    )
    expect(warned).toHaveLength(clean.length + 1)
    expect(stripAnsi(warned[2]!).length).toBeLessThanOrEqual(40)
    expect(warned[2]).not.toContain('\n')
    expect(stripAnsi(warned[2]!)).toContain('warning\\u{a}')
  })

  test('an empty dashboard says so', () => {
    const lines = rd(model([]), WIDE)
    expect(lines.join('\n')).toContain('no active builds')
  })

  test('the summary contains no loop-mode word', () => {
    const [summary] = rd(model([]), WIDE)
    expect(summary).toContain('queue 2 | active 0')
    expect(summary).not.toMatch(/\b(?:watch|once)\b/)
  })

  test('process defaults and the acknowledged durable gate render explicit ON/OFF state', () => {
    expect(rd({ ...model([]), drained: true }, WIDE)[1]).toContain('intake OFF')
    expect(rd(model([]), WIDE)[1]).toContain('intake ON')
    expect(rd(model([]), WIDE)[1]).toContain('auto merge OFF')
    expect(rd({ ...model([]), defaultAutoMerge: true }, WIDE)[1]).toContain('auto merge ON')
    expect(rd(model([]), WIDE)[1]).toContain('harvest ON')
    expect(rd({ ...model([]), harvestPaused: true }, WIDE)[1]).toContain('harvest OFF')
    const defaults = rd(model([]), { color: true, width: 200 })[1]!
    expect(defaults).toContain('\x1b[32mintake ON\x1b[0m')
    expect(defaults).toContain('\x1b[33mauto merge OFF\x1b[0m')
    expect(defaults).toContain('\x1b[32mharvest ON\x1b[0m')

    const toggled = rd(
      {
        ...model([]),
        drained: true,
        defaultAutoMerge: true,
        harvestPaused: true,
      },
      { color: true, width: 200 },
    )[1]!
    expect(toggled).toContain('\x1b[33mintake OFF\x1b[0m')
    expect(toggled).toContain('\x1b[32mauto merge ON\x1b[0m')
    expect(toggled).toContain('\x1b[33mharvest OFF\x1b[0m')
  })

  test('the summary is the selected global row even with no harvest or builds', () => {
    const lines = rd({ ...model([]), selection: { kind: 'global' } }, WIDE).map(stripAnsi)
    expect(lines[0]!.startsWith('> Auto Build')).toBe(true)
    expect(lines[1]!.startsWith('  intake ON')).toBe(true)
    expect(lines.filter((line) => line.startsWith('> '))).toHaveLength(1)
    expect(lines.join('\n')).toContain('no active builds')
  })

  test('the final legend exposes only controls meaningful for the selection', () => {
    const globalLines = rd({ ...model([build()]), selection: { kind: 'global' } }, WIDE)
    expect(globalLines.at(-1)).toBe(
      'Keys: Up/Down select  h harvest  m auto-merge  i intake  Ctrl-C quit',
    )

    const runningHarvestLines = rd(
      {
        ...model([build()]),
        harvest: harvest(),
        selection: { kind: 'harvest' },
      },
      WIDE,
    )
    expect(runningHarvestLines.at(-1)).toBe('Keys: Up/Down select  Ctrl-C quit')

    const resumeHarvestLines = rd(
      {
        ...model([build()]),
        harvest: harvest({ status: 'failed', action: 'resume' }),
        selection: { kind: 'harvest' },
      },
      WIDE,
    )
    expect(resumeHarvestLines.at(-1)).toBe('Keys: Up/Down select  p resume  Ctrl-C quit')

    const acknowledgeHarvestLines = rd(
      {
        ...model([build()]),
        harvest: harvest({ status: 'escalated', action: 'acknowledge' }),
        selection: { kind: 'harvest' },
      },
      WIDE,
    )
    expect(acknowledgeHarvestLines.at(-1)).toBe('Keys: Up/Down select  p acknowledge  Ctrl-C quit')

    const buildLines = rd(
      {
        ...model([build()]),
        selection: { kind: 'build', slug: 'auth-rate-limit' },
      },
      WIDE,
    )
    expect(buildLines.at(-1)).toBe('Keys: Up/Down select  m auto-merge  p pause  Ctrl-C quit')
    for (const controls of [
      globalLines.at(-1),
      runningHarvestLines.at(-1),
      resumeHarvestLines.at(-1),
      acknowledgeHarvestLines.at(-1),
      buildLines.at(-1),
    ]) {
      expect(controls).toContain('Up/Down select')
      expect(controls).toContain('Ctrl-C quit')
    }
    for (const changedControls of [globalLines.at(-1), buildLines.at(-1)]) {
      expect(changedControls).not.toContain('on/off')
      expect(changedControls).not.toContain('default')
      expect(changedControls).not.toContain('pause/resume')
    }
    for (const runControls of [
      runningHarvestLines.at(-1),
      resumeHarvestLines.at(-1),
      acknowledgeHarvestLines.at(-1),
    ]) {
      expect(runControls).not.toContain('harvest on/off')
      expect(runControls).not.toContain('pause')
    }
  })
})

describe('renderDashboard: blocked-resume input', () => {
  const answering = (value = ''): DashboardModel => ({
    ...model([
      build({
        status: 'blocked',
        blockers: ['Choose whether finalize should keep native auto-merge.'],
      }),
    ]),
    selection: { kind: 'build', slug: 'auth-rate-limit' },
    resumeInput: { slug: 'auth-rate-limit', value },
  })

  test('the modal replaces only the bottom legend with a field and Enter/Esc instructions', () => {
    const lines = rd(answering('use manual merge'), WIDE)
    const controls = lines.at(-1)!
    expect(controls).toContain('Resume feedback')
    expect(controls).toContain('use manual merge')
    expect(controls).toContain('Enter submit')
    expect(controls).toContain('Esc cancel')
    expect(controls).not.toContain('Up/Down')
  })

  test('the blocker remains visible while its answer is being typed', () => {
    const out = rd(answering('manual merge'), WIDE).join('\n')
    expect(out).toContain('Choose whether finalize should keep native auto-merge.')
    expect(out).toContain('manual merge')
  })

  test('plain modal rendering has no ANSI and safely escapes non-ASCII without changing the model value', () => {
    const m = answering('type p/m, café')
    const out = rd(m, { color: false, width: 100 }).join('\n')
    expect(out).not.toContain('\x1b')
    expect(out).toContain('type p/m, caf\\u{e9}')
    expect(m.resumeInput?.value).toBe('type p/m, café')
  })

  test('modal controls obey constrained width and height caps', () => {
    for (const width of [20, 40, 80]) {
      for (const height of [0, 1, 2, 4, 10]) {
        const lines = rd(answering('a very long answer '.repeat(20)), {
          color: true,
          width,
          height,
        })
        expect(lines.length).toBeLessThanOrEqual(height)
        for (const line of lines) {
          expect(stripAnsi(line).length).toBeLessThanOrEqual(width)
        }
      }
    }
  })
})

describe('renderDashboard: plain mode (the --plain AC)', () => {
  test('color: false emits NOT ONE escape byte', () => {
    const out = rd(
      model([
        build({ status: 'blocked', blockers: ['which algorithm?'] }),
        build({
          slug: 'other',
          status: 'paused',
          alsoPaused: false,
          pr: { url: 'https://x/1', state: 'open' },
        }),
      ]),
      WIDE,
    ).join('\n')
    expect(out).not.toContain('\x1b')
  })

  test('the PR URL is bare in plain mode — terminals linkify it themselves', () => {
    const out = rd(
      model([build({ pr: { url: 'https://github.com/defrex/app/pull/7', state: 'open' } })]),
      WIDE,
    ).join('\n')
    expect(out).toContain('https://github.com/defrex/app/pull/7')
    expect(out).not.toContain('\x1b]8')
  })
})

describe('renderDashboard: never color-only', () => {
  test('every step state carries a glyph, and every status its literal word', () => {
    const out = rd(
      model([
        build({ status: 'blocked' }),
        build({ slug: 'b', status: 'paused' }),
        build({ slug: 'c', status: 'running' }),
      ]),
      WIDE,
    ).join('\n')
    // All four step states remain distinguishable with color stripped.
    expect(out).toContain('[x] plan(4m12s)')
    expect(out).toContain('[>] implement(38s/2)')
    expect(out).toContain('[~] code-review')
    expect(out).toContain('[ ] verify:test')
    // Statuses: words, not hues.
    expect(out).toContain('BLOCKED')
    expect(out).toContain('PAUSED')
    expect(out).toContain('RUNNING')
  })

  test('the same glyphs and words survive WITH color on', () => {
    const out = rd(model([build({ status: 'blocked' })]), { color: true, width: 200 })
    const plain = stripAnsi(out.join('\n'))
    expect(plain).toContain('[x] plan')
    expect(plain).toContain('[>] implement')
    expect(plain).toContain('[~] code-review')
    expect(plain).toContain('[ ] verify:test')
    expect(plain).toContain('BLOCKED')
  })

  test('a skipped verify step is textually distinct from a pass in plain and ANSI output', () => {
    const passed = build({
      steps: [{ label: 'verify:e2e', state: 'done' }],
    })
    const skipped = build({
      steps: [{ label: 'verify:e2e', state: 'done', qualifier: 'skipped' }],
    })

    const plainPass = rd(model([passed]), WIDE).join('\n')
    const plainSkip = rd(model([skipped]), WIDE).join('\n')
    expect(plainPass).toContain('[x] verify:e2e')
    expect(plainPass).not.toContain('skipped')
    expect(plainSkip).toContain('[x] verify:e2e(skipped)')

    const ansiSkip = stripAnsi(rd(model([skipped]), { color: true, width: 200 }).join('\n'))
    expect(ansiSkip).toContain('[x] verify:e2e(skipped)')
  })

  test('auto-merge intent is conveyed by one common token that is absent when off', () => {
    const lines = rd(
      model([
        build({ slug: 'off-row', autoMerge: 'off' }),
        build({ slug: 'requested-row', autoMerge: 'requested' }),
        build({ slug: 'enabled-row', autoMerge: 'enabled' }),
        build({ slug: 'cancelling-row', autoMerge: 'cancelling' }),
      ]),
      WIDE,
    )
    const row = (slug: string): string => lines.find((line) => line.includes(slug))!
    expect(row('off-row')).not.toContain('auto merge')
    for (const slug of ['requested-row', 'enabled-row', 'cancelling-row']) {
      expect(row(slug)).toContain('auto merge')
    }
    expect(lines.join('\n')).not.toContain('auto requested')
    expect(lines.join('\n')).not.toContain('auto enabled')
    expect(lines.join('\n')).not.toContain('auto cancelling')
  })
})

describe('renderDashboard: emphasis', () => {
  const colored = (b: DashboardBuild): string =>
    rd(model([b]), { color: true, width: 200 }).join('\n')

  test('blocked is red; paused and provisional output are yellow', () => {
    expect(colored(build({ status: 'blocked' }))).toContain('\x1b[31m')
    expect(colored(build({ status: 'paused' }))).toContain('\x1b[33m')
    expect(colored(build())).toContain('\x1b[33m[~] code-review\x1b[0m')
  })

  test('a blocked+paused build shows BLOCKED in red AND keeps the pause visible', () => {
    const out = colored(build({ status: 'blocked', alsoPaused: true }))
    expect(out).toContain('\x1b[31m') // blocked wins the status…
    expect(stripAnsi(out)).toContain('BLOCKED')
    expect(stripAnsi(out)).toContain('(paused)') // …without losing the pause
    expect(out).toContain('\x1b[33m')
  })

  test('every unresolved blocker gets its own line', () => {
    const out = rd(
      model([build({ status: 'blocked', blockers: ['first question', 'second question'] })]),
      WIDE,
    )
    expect(out.some((l) => l.includes('first question'))).toBe(true)
    expect(out.some((l) => l.includes('second question'))).toBe(true)
  })

  test('a PR URL becomes an OSC 8 hyperlink when color is on', () => {
    const out = colored(build({ pr: { url: 'https://x/7', state: 'open' } }))
    expect(out).toContain('\x1b]8;;https://x/7\x07PR open\x1b]8;;\x07')
  })

  test('auto merge uses cyan while requested, green when enabled, and yellow while cancelling', () => {
    expect(colored(build({ autoMerge: 'requested' }))).toContain('\x1b[36mauto merge\x1b[0m')
    expect(colored(build({ autoMerge: 'enabled' }))).toContain('\x1b[32mauto merge\x1b[0m')
    expect(colored(build({ autoMerge: 'cancelling' }))).toContain('\x1b[33mauto merge\x1b[0m')
    const offRow = colored(build({ autoMerge: 'off' }))
      .split('\n')
      .find((line) => stripAnsi(line).includes('auth-rate-limit'))!
    expect(stripAnsi(offRow)).not.toContain('auto merge')
  })
})

describe('renderDashboard: layout', () => {
  test('columns align across builds of differing slug length', () => {
    const lines = rd(
      model([
        build({ slug: 'a', status: 'running' }),
        build({ slug: 'a-much-longer-slug', status: 'blocked' }),
      ]),
      WIDE,
    )
    const [short, long] = lines.filter((l) => l.includes('RUNNING') || l.includes('BLOCKED'))
    expect(short).toBeDefined()
    expect(long).toBeDefined()
    // Slug and status are padded to the widest in the FRAME, so every later
    // column lands at the same offset down the whole dashboard.
    expect(short!.indexOf('RUNNING')).toBe(long!.indexOf('BLOCKED'))
    expect(short!.indexOf('ENG-42')).toBe(long!.indexOf('ENG-42'))
  })

  test('blank lines separate the top section, consecutive rows, and the legend', () => {
    const lines = rd(
      {
        ...model([build({ slug: 'a' }), build({ slug: 'b' })]),
        selection: { kind: 'global' },
      },
      WIDE,
    )
    const first = lines.findIndex((line) => line.includes(' a') && line.includes('RUNNING'))
    const second = lines.findIndex((line) => line.includes(' b') && line.includes('RUNNING'))
    expect(lines[2]).toBe('') // header + status, then top/body separator
    expect(first).toBeGreaterThan(2)
    expect(lines.slice(first, second)).toContain('')
    expect(lines.at(-2)).toBe('')
  })

  test('the two-column cursor lane contains only spaces or the selected marker before the legend', () => {
    const lines = rd(
      {
        ...model([
          build({ slug: 'alpha', blockers: ['operator input required'] }),
          build({ slug: 'beta' }),
        ]),
        warningLine: 'ticket source warning',
        harvest: harvest({ detail: 'stopped at review' }),
        selection: { kind: 'build', slug: 'beta' },
      },
      WIDE,
    ).map(stripAnsi)
    const legend = lines.findIndex((line) => line.startsWith('Keys:'))
    expect(legend).toBeGreaterThan(0)
    for (const line of lines.slice(0, legend)) {
      if (line === '') continue
      expect(['  ', '> ']).toContain(line.slice(0, 2))
    }
    expect(lines.slice(0, legend).filter((line) => line.startsWith('> '))).toHaveLength(1)
  })

  test('PR and status columns remain aligned when the auto-merge token is absent', () => {
    const lines = rd(
      model([
        build({ slug: 'off-row', autoMerge: 'off' }),
        build({ slug: 'on-row', autoMerge: 'requested' }),
      ]),
      { color: false, width: 100 },
    )
    const off = lines.find((line) => line.includes('off-row'))!
    const on = lines.find((line) => line.includes('on-row'))!
    expect(off.indexOf('https://github.com/defrex/app/pull/7')).toBe(
      on.indexOf('https://github.com/defrex/app/pull/7'),
    )
    expect(off.indexOf('RUNNING')).toBe(on.indexOf('RUNNING'))
    expect(off.length).toBe(on.length)
  })

  test('selection is an ASCII marker on exactly the selected slug row', () => {
    const selected = {
      ...model([build({ slug: 'a' }), build({ slug: 'b' })]),
      selection: { kind: 'build' as const, slug: 'b' },
    }
    const lines = rd(selected, WIDE).map(stripAnsi)
    expect(lines.filter((line) => line.startsWith('> '))).toHaveLength(1)
    expect(lines.find((line) => line.startsWith('> '))).toContain('b')
  })
})

describe('renderDashboard: harvest uses the selectable build-row grammar', () => {
  test('identity is Harvest, the internal run id is absent, and selection uses the shared marker', () => {
    const lines = rd(
      {
        ...model([build({ slug: 'build-row', pr: undefined })]),
        harvest: harvest(),
        selection: { kind: 'harvest' },
      },
      WIDE,
    ).map(stripAnsi)
    const line = lines.find((candidate) => candidate.includes('Harvest'))!
    expect(line.startsWith('> ')).toBe(true)
    expect(line).toContain('Harvest')
    expect(line).toContain('36 observations')
    expect(lines.join('\n')).not.toContain('harvest_internal_123')
    expect(lines.filter((candidate) => candidate.startsWith('> '))).toHaveLength(1)
  })

  test('harvest and build statuses end in the same column and RUNNING uses the same green', () => {
    const lines = rd(
      {
        ...model([
          build({ slug: 'build-row', pr: undefined }),
          build({ slug: 'paused-row', status: 'paused', pr: undefined }),
        ]),
        harvest: harvest(),
      },
      { color: true, width: 100 },
    )
    const harvestLine = lines.find((line) => stripAnsi(line).includes('Harvest'))!
    const buildLine = lines.find((line) => stripAnsi(line).includes('build-row'))!
    const pausedLine = lines.find((line) => stripAnsi(line).includes('paused-row'))!
    const harvestPlain = stripAnsi(harvestLine)
    const buildPlain = stripAnsi(buildLine)
    const pausedPlain = stripAnsi(pausedLine)
    expect(harvestPlain.endsWith('RUNNING')).toBe(true)
    expect(buildPlain.endsWith('RUNNING')).toBe(true)
    expect(pausedPlain.endsWith('PAUSED')).toBe(true)
    expect(harvestPlain.indexOf('RUNNING') + 'RUNNING'.length).toBe(
      pausedPlain.indexOf('PAUSED') + 'PAUSED'.length,
    )
    expect(harvestPlain.length).toBe(buildPlain.length)
    expect(harvestPlain.length).toBe(100)
    expect(harvestLine).toContain('\x1b[32mRUNNING\x1b[0m')
    expect(buildLine).toContain('\x1b[32mRUNNING\x1b[0m')
  })

  test('harvest PAUSED is literal and uses the same yellow as a paused build', () => {
    const lines = rd(
      {
        ...model([build({ slug: 'build-row', status: 'paused', pr: undefined })]),
        harvest: harvest({ status: 'paused' }),
      },
      { color: true, width: 100 },
    )
    const statusLines = lines.filter((line) => stripAnsi(line).endsWith('PAUSED'))
    expect(statusLines).toHaveLength(2)
    expect(statusLines.every((line) => line.includes('\x1b[33mPAUSED\x1b[0m'))).toBe(true)
  })

  test('agent-authored blocker and harvest failure text stays visible in an ASCII PNG frame', () => {
    const blockerQuestion = 'Should the “café” policy remain enabled?'
    const failureError = 'agent failed in naïve 💥 mode'
    const failureDetail = `stopped at synthesize r1 - automatic recovery 0/2; ${failureError}`
    const dashboard = {
      ...model([
        build({
          status: 'blocked',
          blockers: [blockerQuestion],
        }),
      ]),
      harvest: harvest({ status: 'failed', detail: failureDetail }),
    }

    const lines = rd(dashboard, { color: true, width: 120 })
    const plain = lines.map(stripAnsi)

    expect(dashboard.builds[0]!.blockers[0]).toBe(blockerQuestion)
    expect(dashboard.harvest?.detail).toBe(failureDetail)
    expect(plain.join('\n')).toContain(
      'Should the \\u{201c}caf\\u{e9}\\u{201d} policy remain enabled?',
    )
    expect(plain.join('\n')).toContain('agent failed in na\\u{ef}ve \\u{1f4a5} mode')
    expect(plain.every((line) => /^[\x20-\x7e]*$/.test(line))).toBe(true)

    const image = renderDashboardFrameImage(lines, { columns: 120 })
    expect([...image.png.slice(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10])
  })
})

describe('renderDashboard: truncation (one rendered line = one physical row)', () => {
  // If a line exceeds the width, terminal wrapping consumes unbudgeted rows and
  // can scroll the top-anchored frame's header away despite its logical line
  // count fitting the screen.

  test('no line exceeds the width, in plain or color', () => {
    const long = build({
      slug: 'a-very-long-slug-that-goes-on'.repeat(3),
      blockers: ['a blocker message that is far too long to fit on one line'.repeat(3)],
    })
    for (const color of [false, true]) {
      const lines = rd(model([long]), { color, width: 40 })
      for (const line of lines) expect(stripAnsi(line).length).toBeLessThanOrEqual(40)
    }
  })

  test('truncation never splits an escape sequence or leaks color', () => {
    const lines = rd(model([build({ status: 'blocked', blockers: ['x'.repeat(200)] })]), {
      color: true,
      width: 30,
    })
    for (const line of lines) {
      // Every escape we emit is a complete, well-formed sequence…
      const leftovers = line
        .replace(/\x1b\][^\x07]*\x07/g, '')
        .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')
      expect(leftovers).not.toContain('\x1b')
      // …and a cut line still closes its color, so it cannot bleed downward.
      if (line.includes('\x1b[')) expect(line.endsWith('\x1b[0m')).toBe(true)
    }
  })

  test('truncation never leaves a hyperlink OPEN — RESET does not close one', () => {
    // f_f72ad952: `renderBuild` puts the PR link last, so it is the first thing
    // truncation eats. `\x1b[0m` is an SGR reset and does not end an OSC 8; an
    // unclosed link makes every line painted afterwards — the progress row, the
    // blockers, every later build — clickable to that one PR, and `finish()`
    // deliberately leaves the frame up, so it lands on the operator's shell
    // prompt after exit.
    //
    // 80 is the default width and this module's own fallback, and a 43-char
    // slug is what this repo's own builds are named: the ordinary case.
    const real = build({
      slug: 'interactive-build-dashboard-for-ab-dispatch',
      ticketId: 'AB-123',
    })
    // Sweep the widths so the cut lands in every part of the link — before it,
    // inside its text, and past it.
    for (let width = 10; width <= 120; width += 1) {
      const lines = rd(model([real, build({ slug: 'b' })]), { color: true, width })
      for (const line of lines) expect(unclosedLinks(line)).toBe(0)
    }
  })

  test('the slug is the sole element that truncates — ticket id and status survive (AC 5)', () => {
    // The new layout makes the slug the only flexible/truncatable element. At a
    // width that cannot fit the whole slug line, the slug gets the `~` while the
    // ticket id (left column) and the status (right-pinned) are both intact.
    const line = rd(
      model([build({ slug: 'interactive-build-dashboard-for-ab-dispatch', ticketId: 'AB-123' })]),
      { color: true, width: 40 },
    ).find((l) => stripAnsi(l).includes('AB-123'))!
    const plain = stripAnsi(line)
    expect(plain).toContain('AB-123') // ticket id survives
    expect(plain).toContain('RUNNING') // status survives, right-pinned
    expect(plain).toContain('~') // the slug is what got cut
    expect(plain.length).toBeLessThanOrEqual(40)
  })

  test('a line that fits is left exactly alone', () => {
    const lines = rd(model([build()]), WIDE)
    // `[~]` is a state marker; any other tilde would be truncate()'s ellipsis.
    expect(lines.some((l) => l.replaceAll('[~]', '').includes('~'))).toBe(false)
  })
})

describe('renderDashboard: `height` caps the LINE count', () => {
  // f_d2e4b3ee — the width invariant's twin, on the other axis. The live region
  // clears its alternate display and anchors at row 1, but a frame taller than
  // the paintable rows still scrolls its own top away. The header — the line AC
  // 19 names — is the first thing lost.
  //
  // What this file can and cannot prove (f_c9449563): `height` here is a cap
  // on LINES, and these tests only pin `lines.length <= height`. They say
  // NOTHING about what a caller should pass — round 3 passed `terminal.rows`,
  // which is off by one because the region's trailing newline needs a row of
  // its own, and the sweep below happily passed on the broken output. That
  // invariant (`frame.length < term.rows`) is not visible from here; it lives
  // at the dispatch seam, and `paintableRows` owns the rule.
  const blocked = (i: number): DashboardBuild =>
    build({
      slug: `interactive-build-dashboard-for-ab-${i}`,
      status: 'blocked',
      ticketId: `AB-${i}`,
      steps: [
        { label: 'plan', state: 'done' },
        { label: 'plan-review', state: 'done' },
        { label: 'implement', state: 'pending' },
        { label: 'code-review', state: 'pending' },
        { label: 'verify:lint', state: 'pending' },
        { label: 'verify:test', state: 'pending', qualifier: 'failed' },
        { label: 'finalize', state: 'pending' },
        { label: 'merge', state: 'pending', qualifier: 'waiting' },
      ],
      blockers: ['maxVerifyAttempts (3) exhausted: verify:test is still failing'],
    })
  const many = (n: number): DashboardBuild[] => Array.from({ length: n }, (_, i) => blocked(i))

  test('an unclamped frame really does overflow a default 80x24 — the bug', () => {
    // Only the RUNNING half of the listed set is bounded by capacity; blocked
    // builds accumulate until a human answers, which is the very condition the
    // dashboard exists to surface. Five is not a large backlog.
    const unbounded = rd(model(many(5)), { color: false, width: 80 })
    expect(unbounded.length).toBeGreaterThan(24)
  })

  test('…and the same frame clamped is within the cap it was given', () => {
    // NB: `height: 24` is not "fits a 24-row screen" — see the note above.
    const lines = rd(model(many(5)), { color: false, width: 80, height: 24 })
    expect(lines.length).toBeLessThanOrEqual(24)
  })

  test('never exceeds the height, over a sweep of heights and build counts', () => {
    for (const n of [0, 1, 2, 3, 5, 8, 20]) {
      for (let height = 0; height <= 40; height += 1) {
        for (const color of [false, true]) {
          const lines = rd(model(many(n)), { color, width: 80, height })
          expect(lines.length).toBeLessThanOrEqual(height)
        }
      }
    }
  })

  test('warning and no-warning height sweeps keep complete header lines ahead of body', () => {
    for (const warningLine of [undefined, 'store read failed'] as const) {
      const dashboard = {
        ...model(many(5)),
        ...(warningLine !== undefined ? { warningLine } : {}),
      }
      for (let height = 0; height <= 16; height += 1) {
        const lines = rd(dashboard, {
          color: true,
          width: 80,
          height,
        }).map(stripAnsi)
        expect(lines.length).toBeLessThanOrEqual(height)
        if (height >= 1) expect(lines[0]).toContain('Auto Build')
        if (height >= 2) {
          expect(lines[1]).toContain('intake ON')
          expect(lines[1]).toContain('harvest ON')
        }
        if (warningLine !== undefined && height >= 3) {
          expect(lines[2]).toBe(`  ${warningLine}`)
        }
        for (const line of lines) expect(line.length).toBeLessThanOrEqual(80)
      }
    }
  })

  test('the header survives the clamp — it is the line the ACs name', () => {
    for (let height = 1; height <= 12; height += 1) {
      const [header] = rd(model(many(8)), { color: false, width: 80, height })
      expect(header).toContain('Auto Build')
      expect(header).toContain('queue 2')
      // The count is on the header, so it still reports every build even when
      // most rows are clamped away.
      expect(header).toContain('active 8')
    }
  })

  test('the overflow is VISIBLE, not silent — `... and N more`', () => {
    // Silent truncation would read as "these are all the builds", which is a
    // worse answer than the scrolling it replaces.
    const lines = rd(model(many(8)), { color: false, width: 80, height: 24 })
    const notice = lines.find((line) => line.includes('more'))
    expect(notice).toBeDefined()
    const shown = lines.filter((l) => l.includes('BLOCKED')).length
    expect(notice).toContain(`and ${8 - shown} more`)
    expect(shown).toBeGreaterThan(0)
  })

  test('builds are dropped WHOLE — never a half-rendered build', () => {
    const lines = rd(model(many(8)), { color: false, width: 80, height: 24 })
    // Every rendered build brings its header, its progress rows and its
    // blocker; a build's blocker line never appears without its header.
    const headers = lines.filter((l) => l.includes('BLOCKED')).length
    const blockerLines = lines.filter((l) => l.trimStart().startsWith('!')).length
    expect(blockerLines).toBe(headers)
  })

  test('an overflowed viewport always contains the selected slug while it moves', () => {
    for (const selected of [1, 4, 7]) {
      const m = {
        ...model(many(8)),
        selection: {
          kind: 'build' as const,
          slug: `interactive-build-dashboard-for-ab-${selected}`,
        },
      }
      const lines = rd(m, { color: false, width: 80, height: 12 })
      expect(lines.some((line) => line.startsWith(`> AB-${selected}`))).toBe(true)
      expect(lines.at(-1)).toContain('Up/Down')
    }
  })

  test('a selected harvest or build remains visible when both participate in overflow', () => {
    const base = { ...model(many(8)), harvest: harvest() }
    const harvestLines = rd(
      { ...base, selection: { kind: 'harvest' } },
      { color: false, width: 80, height: 8 },
    )
    expect(harvestLines.some((line) => line.startsWith('> ') && line.includes('Harvest'))).toBe(
      true,
    )

    const buildLines = rd(
      {
        ...base,
        selection: {
          kind: 'build',
          slug: 'interactive-build-dashboard-for-ab-7',
        },
      },
      { color: false, width: 80, height: 8 },
    )
    expect(buildLines.some((line) => line.startsWith('> AB-7'))).toBe(true)
  })

  test('a frame that fits is not clamped and gets no notice', () => {
    const lines = rd(model(many(2)), { color: false, width: 80, height: 24 })
    expect(lines.some((l) => l.includes('more'))).toBe(false)
    expect(lines.filter((l) => l.includes('BLOCKED'))).toHaveLength(2)
  })

  test('height is optional — absent ⇒ unbounded, for callers not painting a screen', () => {
    expect(rd(model(many(5)), { color: false, width: 80 }).length).toBeGreaterThan(24)
  })

  test('a cap of 1 leaves the header and nothing else', () => {
    expect(rd(model([]), { color: false, width: 80, height: 1 })).toHaveLength(1)
    expect(rd(model(many(3)), { color: false, width: 80, height: 1 })).toHaveLength(1)
  })

  test('a cap of 0 paints NOTHING — not a header that would scroll itself off', () => {
    // What `paintableRows(1)` hands us on a 1-row screen. A single line there
    // would scroll away behind its own trailing newline even after a full
    // alternate-display clear, which is worse than an empty region.
    expect(rd(model([]), { color: false, width: 80, height: 0 })).toEqual([])
    expect(rd(model(many(3)), { color: false, width: 80, height: 0 })).toEqual([])
  })
})

describe('renderDashboard: the progress row WRAPS rather than truncating', () => {
  // Regression, found by rendering a realistic frame at 100 columns: a full
  // pipeline (plan → plan-review → implement → code-review → verify:* →
  // finalize → merge) does not fit, and truncating drops the tail — which is
  // `finalize` and `merge(waiting)`, i.e. exactly the steps the ACs require
  // and the ones the operator is actually waiting on. We do the wrapping, so
  // the row count stays honest AND nothing is lost.
  const full = build({
    steps: [
      { label: 'plan', state: 'done', timing: { accumulatedMs: 252_000 } },
      { label: 'plan-review', state: 'done', timing: { accumulatedMs: 5_000 } },
      { label: 'implement', state: 'done', count: 2, timing: { accumulatedMs: 432_000 } }, // 7m12s
      { label: 'code-review', state: 'done', count: 2, timing: { accumulatedMs: 12_000 } },
      { label: 'verify:lint', state: 'done', timing: { accumulatedMs: 3_000 } },
      { label: 'verify:test', state: 'current', count: 2, timing: { accumulatedMs: 41_000 } },
      { label: 'finalize', state: 'pending' },
      { label: 'merge', state: 'pending', qualifier: 'waiting' },
    ],
  })

  test('every step survives at a width the row cannot fit on one line', () => {
    const progress = rd(model([full]), { color: false, width: 60 })
      .filter((l) => l.startsWith('  ['))
      .join('\n')
    // count rides the elapsed as `/n` (AC 7), superseding the old r2/a2 notes.
    for (const label of [
      'plan',
      'implement(7m12s/2)',
      'verify:test(41s/2)',
      'finalize',
      'merge(waiting)',
    ]) {
      expect(progress).toContain(label)
    }
    expect(progress).not.toContain('~') // no step was truncated away
  })

  test('…and the width guarantee still holds on every wrapped line', () => {
    for (const width of [30, 44, 60, 100]) {
      for (const color of [false, true]) {
        const lines = rd(model([full]), { color, width })
        for (const line of lines) expect(stripAnsi(line).length).toBeLessThanOrEqual(width)
      }
    }
  })

  test('a long blocker message wraps instead of losing its tail', () => {
    // "Every unresolved blocker message is displayed" is not satisfied by its
    // first 80 characters, and a policy escalation's question routinely runs
    // longer than that.
    const blocker =
      'maxVerifyAttempts (3) exhausted: verify:test is still failing after three ' +
      'attempts and the implementer keeps reintroducing the same regression'
    const lines = rd(model([build({ status: 'blocked', blockers: [blocker] })]), {
      color: false,
      width: 50,
    })
    for (const line of lines) expect(line.length).toBeLessThanOrEqual(50)
    // Reassembled, the whole message is there.
    const text = lines
      .filter((l) => l.trimStart().startsWith('!') || /^\s{4}\S/.test(l))
      .join(' ')
      .replace(/\s+/g, ' ')
      .replace('! ', '')
      .trim()
    expect(text).toBe(blocker)
  })
})

describe('renderDashboard: the ticket-first, status-right slug line', () => {
  /** The one slug line in a frame (the row carrying the status word). */
  const slugLine = (lines: string[], status = 'RUNNING'): string =>
    lines.find((line) => stripAnsi(line).includes(status))!

  test('the ticket id is the first token, the slug follows it (AC 1)', () => {
    const line = stripAnsi(slugLine(rd(model([build({ pr: undefined })]), WIDE)))
    expect(line.startsWith('  ENG-42')).toBe(true)
    expect(line.indexOf('auth-rate-limit')).toBeGreaterThan(line.indexOf('ENG-42'))
  })

  test('the status is right-aligned: the line ends with it, flush to the width (AC 1)', () => {
    const line = stripAnsi(
      slugLine(rd(model([build({ pr: undefined })]), { color: false, width: 60 })),
    )
    expect(line.length).toBe(60)
    expect(line.endsWith('RUNNING')).toBe(true)
  })

  test('the current phase word no longer appears on the slug line (AC 4)', () => {
    // `implement` is the current phase; it lives on the progress row's `[>]`
    // marker now, never as a word on the slug line.
    const line = stripAnsi(slugLine(rd(model([build({ pr: undefined })]), WIDE)))
    expect(line).not.toContain('implement')
  })

  test('the PR link and (paused) ride the slug line, adjacent to the status (AC 3)', () => {
    const line = stripAnsi(
      slugLine(rd(model([build({ status: 'blocked', alsoPaused: true })]), WIDE), 'BLOCKED'),
    )
    // order on the right cluster: PR … (paused) … STATUS
    expect(line.indexOf('PR open')).toBeLessThan(line.indexOf('(paused)'))
    expect(line.indexOf('(paused)')).toBeLessThan(line.indexOf('BLOCKED'))
  })

  test('a build with no ticket keeps its slug at the same column as a ticketed one (AC 2)', () => {
    const lines = rd(
      model([
        build({ slug: 'has-ticket', ticketId: 'ENG-42', pr: undefined }),
        build({ slug: 'no-ticket', ticketId: undefined, pr: undefined }),
      ]),
      WIDE,
    )
    const withT = lines.find((l) => l.includes('has-ticket'))!
    const without = lines.find((l) => l.includes('no-ticket'))!
    expect(withT.indexOf('has-ticket')).toBe(without.indexOf('no-ticket'))
  })

  test('with no ticketed build in the frame there is no ticket column at all', () => {
    const line = stripAnsi(
      slugLine(rd(model([build({ slug: 'solo', ticketId: undefined, pr: undefined })]), WIDE)),
    )
    expect(line.startsWith('  solo')).toBe(true) // marker lane, no ticket column
  })
})

describe('formatDuration', () => {
  test('the unit table — ASCII, zero-padded under a leading unit', () => {
    expect(formatDuration(0)).toBe('0s')
    expect(formatDuration(38_000)).toBe('38s')
    expect(formatDuration(38_999)).toBe('38s') // sub-second floors — stable field
    expect(formatDuration(59_000)).toBe('59s')
    expect(formatDuration(60_000)).toBe('1m00s')
    expect(formatDuration(252_000)).toBe('4m12s')
    expect(formatDuration(3_599_000)).toBe('59m59s')
    expect(formatDuration(3_600_000)).toBe('1h00m')
    expect(formatDuration(3_840_000)).toBe('1h04m')
    expect(formatDuration(-5)).toBe('0s') // never negative
  })
})

describe('renderDashboard: elapsed ticks with `now` (AC 7, 8, 9, 10, 13)', () => {
  const progressOf = (b: DashboardBuild, now: number, color = false): string =>
    rd(model([b]), { color, width: 120, now }).find((l) => l.startsWith('  ['))!

  const withStep = (over: Partial<PipelineStep> & { label: string }): DashboardBuild =>
    build({ pr: undefined, steps: [{ state: 'current', ...over }] })

  test('a running step advances as now moves forward (AC 8)', () => {
    const b = withStep({
      label: 'implement',
      timing: { accumulatedMs: 2_000, runningSince: 1_000_000 },
    })
    expect(progressOf(b, 1_000_000 + 3_000)).toContain('implement(5s)') // 2s + 3s
    expect(progressOf(b, 1_000_000 + 10_000)).toContain('implement(12s)') // 2s + 10s
  })

  test('a step with no open interval is frozen — now does not move it (AC 10)', () => {
    const b = build({
      pr: undefined,
      steps: [{ label: 'plan', state: 'done', timing: { accumulatedMs: 65_000 } }],
    })
    const early = progressOf(b, 1)
    const late = progressOf(b, 5_000_000)
    expect(early).toContain('plan(1m05s)')
    expect(early).toBe(late)
  })

  test('the count rides the elapsed as /n (AC 7)', () => {
    const b = withStep({
      label: 'implement',
      count: 3,
      timing: { accumulatedMs: 0, runningSince: 100 },
    })
    expect(progressOf(b, 100 + 432_000)).toContain('implement(7m12s/3)')
  })

  test('merge waiting ticks from its runningSince (AC 9)', () => {
    const b = build({
      pr: { url: 'https://x/1', state: 'open' },
      steps: [
        {
          label: 'merge',
          state: 'current',
          qualifier: 'waiting',
          timing: { accumulatedMs: 0, runningSince: 500 },
        },
      ],
    })
    expect(progressOf(b, 500 + 192_000)).toContain('merge(waiting, 3m12s)')
  })

  test('a never-run step shows no time even as now advances (AC 6)', () => {
    const b = build({ pr: undefined, steps: [{ label: 'verify:lint', state: 'pending' }] })
    expect(progressOf(b, 9_999_999)).toContain('[ ] verify:lint')
    expect(progressOf(b, 9_999_999)).not.toContain('verify:lint(')
  })

  test('--plain keeps durations intact and emits no escapes (AC 13)', () => {
    const b = withStep({
      label: 'implement',
      count: 2,
      timing: { accumulatedMs: 0, runningSince: 0 },
    })
    const out = rd(model([b]), { color: false, width: 200, now: 41_000 }).join('\n')
    expect(out).not.toContain('\x1b')
    expect(out).toContain('implement(41s/2)')
  })
})
