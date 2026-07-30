/**
 * The renderer (src/cli/dashboard/render.ts) — pure, so every AC about what
 * the operator can SEE is assertable here without a terminal.
 */
import { describe, expect, test } from 'bun:test'
import { renderDashboardFrameImage } from './frame-image'
import {
  DASHBOARD_BUILD_LEGEND,
  formatDuration,
  moveTranscriptScroll,
  renderDashboard,
  resumeHintRows,
  resumeKeysRows,
  resumePanel,
  stripAnsi,
  transcriptScrollLimit,
  type RenderOpts,
} from './render'
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
    active: { current: builds.length, limit: 5 },
    observations: { current: 5, limit: 7 },
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
    expect(summary).toContain('Autobuild')
    expect(summary).toContain('app') // the repo basename
    expect(summary).not.toContain('/repos/app')
    expect(summary).toContain('queue 2 | active 1/5 | obs 5/7')
    expect(summary).not.toMatch(/\b(?:watch|once)\b/)
    expect(summary).not.toContain('intake ON')
    expect(toggles).toContain('intake ON')
    expect(toggles).toContain('auto merge OFF')
    expect(toggles).toContain('harvest ON')
    expect(summary.indexOf('Autobuild')).toBe(3)
    expect(toggles.search(/\S/)).toBe(summary.indexOf('Autobuild'))
    expect(lines.slice(0, -1).join('\n')).not.toContain('Ctrl-C to stop')
  })

  test('the warning row is absent until needed, then appears aligned below both headers', () => {
    const clean = rd(model([build()]), WIDE).map(stripAnsi)
    expect(clean[2]).toBe('')

    const warned = rd({ ...model([build()]), warningLine: 'ticket source unavailable' }, WIDE).map(
      stripAnsi,
    )
    expect(warned[2]).toBe('   ticket source unavailable')
    expect(warned[2]!.search(/\S/)).toBe(warned[0]!.indexOf('Autobuild'))
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

  test('the summary keeps queue bare and renders pressure boundaries as current/limit', () => {
    const [empty] = rd(
      {
        ...model([]),
        active: { current: 0, limit: 5 },
        observations: { current: 0, limit: 7 },
      },
      WIDE,
    )
    expect(empty).toContain('queue 2 | active 0/5 | obs 0/7')

    const [saturated] = rd(
      {
        ...model([]),
        active: { current: 5, limit: 5 },
        observations: { current: 7, limit: 7 },
      },
      WIDE,
    )
    expect(saturated).toContain('queue 2 | active 5/5 | obs 7/7')
    expect(saturated).not.toMatch(/\b(?:watch|once)\b/)
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
    expect(lines[0]!.startsWith(' > Autobuild')).toBe(true)
    expect(lines[1]!.startsWith('   intake ON')).toBe(true)
    expect(lines.filter((line) => line.startsWith(' > '))).toHaveLength(1)
    expect(lines.join('\n')).toContain('no active builds')
  })

  test('the final legend exposes only controls meaningful for the selection', () => {
    const globalLines = rd({ ...model([build()]), selection: { kind: 'global' } }, WIDE)
    expect(globalLines.at(-1)).toBe(
      ' Keys: Up/Down select  h harvest  m auto-merge  i intake  p pause all  r resume all  Ctrl-C quit',
    )

    const runningHarvestLines = rd(
      {
        ...model([build()]),
        harvest: harvest(),
        selection: { kind: 'harvest' },
      },
      WIDE,
    )
    expect(runningHarvestLines.at(-1)).toBe(' Keys: Up/Down select  Ctrl-C quit')

    const resumeHarvestLines = rd(
      {
        ...model([build()]),
        harvest: harvest({ status: 'failed', action: 'resume' }),
        selection: { kind: 'harvest' },
      },
      WIDE,
    )
    expect(resumeHarvestLines.at(-1)).toBe(' Keys: Up/Down select  p resume  Ctrl-C quit')

    const acknowledgeHarvestLines = rd(
      {
        ...model([build()]),
        harvest: harvest({ status: 'escalated', action: 'acknowledge' }),
        selection: { kind: 'harvest' },
      },
      WIDE,
    )
    expect(acknowledgeHarvestLines.at(-1)).toBe(' Keys: Up/Down select  p acknowledge  Ctrl-C quit')

    const buildLines = rd(
      {
        ...model([build()]),
        selection: { kind: 'build', slug: 'auth-rate-limit' },
      },
      WIDE,
    )
    expect(buildLines.at(-1)).toBe(
      ' Keys: Up/Down select  Enter details  m auto-merge  p pause  a abort  Ctrl-C quit',
    )
    // The exported constant is the poll-race fallback for a build row whose
    // build vanished between poll and paint. Pinning it to the rendered line
    // keeps the wording from flickering for that one frame.
    expect(buildLines.at(-1)).toBe(` ${DASHBOARD_BUILD_LEGEND}`)

    // The detail legend sits on the line directly above the list one in the
    // source; freezing it exactly is what stops an edit to the list branch
    // from silently landing on the detail branch instead.
    const detailLines = rd(
      {
        ...model([build()]),
        selection: { kind: 'build', slug: 'auth-rate-limit' },
        view: { kind: 'detail', slug: 'auth-rate-limit' },
      },
      WIDE,
    )
    expect(detailLines.at(-1)).toBe(
      ' Keys: Up/Down select session  Enter transcript  m auto-merge  p pause  a abort  Esc back  Ctrl-C quit',
    )

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

  test('transition statuses and list/detail legends expose only their state-specific control', () => {
    const cases = [
      ['running', 'RUNNING', 'p pause'],
      ['pausing', 'PAUSING', 'p cancel pause'],
      ['paused', 'PAUSED', 'r resume'],
      ['resuming', 'RESUMING', undefined],
      ['blocked', 'BLOCKED', 'r resume'],
    ] as const

    for (const [status, literal, control] of cases) {
      const selected = build({ status })
      const list = rd(
        {
          ...model([selected]),
          selection: { kind: 'build', slug: selected.slug },
        },
        WIDE,
      ).map(stripAnsi)
      expect(list.join('\n')).toContain(literal)
      if (control === undefined) {
        expect(list.at(-1)).not.toMatch(/ {2}[pr] (?:pause|cancel pause|resume)/)
      } else {
        expect(list.at(-1)).toContain(control)
      }

      const detail = rd(
        {
          ...model([selected]),
          selection: { kind: 'build', slug: selected.slug },
          view: { kind: 'detail', slug: selected.slug },
        },
        WIDE,
      ).map(stripAnsi)
      expect(detail.join('\n')).toContain(`status ${literal}`)
      if (control === undefined) {
        expect(detail.at(-1)).not.toMatch(/ {2}[pr] (?:pause|cancel pause|resume)/)
      } else {
        expect(detail.at(-1)).toContain(control)
      }
    }
  })
})

describe('renderDashboard: queued dispatch rows', () => {
  test('renders QUEUED, its actionable dispatch reason, and the conditional discard key', () => {
    const queued = build({
      status: 'queued',
      steps: [],
      dispatch: 'dispatch workspace failed (attempt 2): credentials missing',
      pr: undefined,
    })
    const frame = model([queued])
    frame.selection = { kind: 'build', slug: queued.slug }
    const lines = rd(frame, WIDE).map(stripAnsi)
    const text = lines.join('\n')
    expect(text).toContain('QUEUED')
    expect(text).toContain('dispatch workspace failed (attempt 2): credentials missing')
    expect(text).toContain('d discard')
    expect(text).not.toContain('[ ] plan')
    expect(lines.at(-1)).toBe(
      ' Keys: Up/Down select  Enter details  d discard  a abort  Ctrl-C quit',
    )
  })
})

describe('renderDashboard: abort confirmation', () => {
  test('names the destructive target and requires Enter or Escape', () => {
    const confirming: DashboardModel = {
      ...model([build()]),
      selection: { kind: 'build', slug: 'auth-rate-limit' },
      abortConfirmation: { slug: 'auth-rate-limit' },
    }
    const controls = rd(confirming, WIDE).at(-1)!
    expect(controls).toContain('Abort auth-rate-limit')
    expect(controls).toContain('Enter confirm')
    expect(controls).toContain('Esc cancel')
  })
})

describe('renderDashboard: blocked-resume input', () => {
  const BLOCKER = 'Choose whether finalize should keep native auto-merge.'
  const answering = (value = '', cursor = [...value].length): DashboardModel => ({
    ...model([build({ status: 'blocked', blockers: [BLOCKER] })]),
    selection: { kind: 'build', slug: 'auth-rate-limit' },
    resumeInput: { slug: 'auth-rate-limit', value, cursor },
  })

  /** The panel occupies the frame's tail, starting at its title row. */
  const panelOf = (lines: string[]): string[] => {
    const start = lines.findIndex((line) =>
      stripAnsi(line).trimStart().startsWith('Resume auth-rate-limit'),
    )
    expect(start).toBeGreaterThanOrEqual(0)
    return lines.slice(start).map(stripAnsi)
  }

  test('the panel takes over the controls region — no key legend beside it', () => {
    const lines = rd(answering('use manual merge'), WIDE).map(stripAnsi)
    const panel = panelOf(lines)
    expect(panel[0]!.trim()).toBe('Resume auth-rate-limit')
    expect(panel.join('\n')).toContain('use manual merge')
    expect(panel.join('\n')).toContain(BLOCKER)
    expect(panel.join('\n')).toContain('Enter submit')
    expect(panel.join('\n')).toContain('Ctrl-J')
    expect(panel.join('\n')).toContain('Esc cancel')
    // The legend is REPLACED, not pushed up: answering is the only action
    // available, so there is nothing else for the region to say.
    expect(lines.join('\n')).not.toContain('Up/Down select')
    expect(lines.at(-1)).not.toContain(DASHBOARD_BUILD_LEGEND)
  })

  test('the caret sits at the cursor, not at the end of the buffer', () => {
    const panel = panelOf(rd(answering('abcdef', 2), WIDE))
    expect(panel.some((line) => line.includes('ab|cdef'))).toBe(true)
  })

  test('a multi-line value renders across rows with nothing pinned to its right', () => {
    const panel = panelOf(rd(answering('first line\nsecond line'), WIDE)).map((line) => line.trim())
    expect(panel).toContain('first line')
    expect(panel).toContain('second line|')
    // The old prompt pinned `]  Enter submit  Esc cancel` to the right of the
    // field, which is what truncated the operator's own text.
    expect(panel.some((line) => line.trimEnd().endsWith('submit'))).toBe(false)
  })

  test('a long value scrolls, keeping the cursor row visible', () => {
    const value = 'z'.repeat(4000)
    const panel = panelOf(rd(answering(value), { color: false, width: 60, height: 30 }))
    const fieldRows = panel.filter((line) => /^\s*z+\|?$/.test(line))
    expect(fieldRows.length).toBeLessThanOrEqual(6)
    expect(fieldRows.at(-1)).toContain('|')
    // Scrolled to the tail: the buffer's first row is off the top of the field.
    expect(fieldRows.length).toBeLessThan(Math.ceil(value.length / 56))
  })

  test('the panel behaves identically from the detail view (AC 6)', () => {
    const opts = { color: false, width: 100, height: 24 }
    const list = rd(answering('typed guidance'), opts)
    const detail = rd(
      { ...answering('typed guidance'), view: { kind: 'detail', slug: 'auth-rate-limit' } },
      opts,
    )
    expect(panelOf(detail)).toEqual(panelOf(list))
  })
})

describe('renderDashboard: the resume panel names its bindings (AC 4)', () => {
  // Revision 4 of the plan abbreviated the action words to buy narrow widths
  // and passed a key-name assertion while failing AC 4 outright. So the
  // assertion here is on the ACTION LABELS, looped over every supported width.
  const WIDTHS = [78, 55, 46, 38, 18, 12, 10, 9, 7]

  test('every width names submit, newline, and cancel', () => {
    for (const width of WIDTHS) {
      const joined = resumeKeysRows(width).join('\n')
      expect(joined).toContain('submit')
      expect(joined).toContain('newline')
      expect(joined).toContain('cancel')
    }
  })

  test('no row overflows and no action word is split across rows', () => {
    for (let width = 7; width <= 90; width += 1) {
      const rows = resumeKeysRows(width)
      for (const row of rows) expect(row.length).toBeLessThanOrEqual(width)
      for (const action of ['submit', 'newline', 'cancel']) {
        expect(rows.filter((row) => row.includes(action))).toHaveLength(1)
      }
    }
  })

  test('the worked row split at each width', () => {
    expect(resumeKeysRows(78)).toEqual([
      'Keys: Enter submit  Ctrl-J or Shift+Enter newline  Esc cancel',
    ])
    expect(resumeKeysRows(55)).toEqual(['Enter submit  Ctrl-J or Shift+Enter newline  Esc cancel'])
    expect(resumeKeysRows(46)).toEqual(['Keys: Enter submit  Ctrl-J newline  Esc cancel'])
    expect(resumeKeysRows(38)).toEqual(['Enter submit  Ctrl-J newline', 'Esc cancel'])
    expect(resumeKeysRows(18)).toEqual(['Enter submit', 'Ctrl-J newline', 'Esc cancel'])
    expect(resumeKeysRows(12)).toEqual(['Enter submit', 'Ctrl-J', '  newline', 'Esc cancel'])
    expect(resumeKeysRows(10)).toEqual(['Enter', '  submit', 'Ctrl-J', '  newline', 'Esc cancel'])
    expect(resumeKeysRows(9)).toEqual([
      'Enter',
      '  submit',
      'Ctrl-J',
      '  newline',
      'Esc',
      '  cancel',
    ])
    // The continuation indent is the first thing to go, never the action word.
    expect(resumeKeysRows(7)).toEqual(['Enter', 'submit', 'Ctrl-J', 'newline', 'Esc', 'cancel'])
  })

  test('below the width where newline fits, the block is dropped WHOLE, not partially', () => {
    // Naming submit and cancel while silently omitting newline would
    // misrepresent what the prompt accepts.
    expect(resumeKeysRows(6)).toEqual([])
    expect(resumeKeysRows(1)).toEqual([])
    expect(resumeKeysRows(0)).toEqual([])
  })
})

describe('renderDashboard: the resume panel states both hint facts (AC 2)', () => {
  // A narrow width invites paying in WORDS, and this AC is denominated in
  // words. Every rung carries both facts; narrow widths pay in rows instead.
  const WIDTHS = [78, 38, 20, 18, 12]

  test('every width says guidance is optional AND that Enter alone resumes', () => {
    for (const width of WIDTHS) {
      const joined = resumeHintRows(width).join(' ')
      expect(joined).toMatch(/optional/i)
      expect(joined).toMatch(/Enter (?:on an empty field|alone) resumes/i)
    }
  })

  test('the worked row split at each width', () => {
    expect(resumeHintRows(78)).toEqual([
      'Guidance is optional -- Enter on an empty field resumes without it',
    ])
    expect(resumeHintRows(38)).toEqual(['Guidance optional; Enter alone resumes'])
    expect(resumeHintRows(20)).toEqual(['Guidance optional;', 'Enter alone resumes'])
    expect(resumeHintRows(18)).toEqual(['Guidance optional;', 'Enter alone', 'resumes'])
    expect(resumeHintRows(12)).toEqual(['Guidance', 'optional;', 'Enter alone', 'resumes'])
  })

  test('no row overflows its width', () => {
    for (let width = 1; width <= 90; width += 1) {
      for (const row of resumeHintRows(width)) expect(row.length).toBeLessThanOrEqual(width)
    }
  })

  test('past the row cap the block is dropped whole rather than rendered deficient', () => {
    expect(resumeHintRows(10)).toEqual([])
    expect(resumeHintRows(0)).toEqual([])
  })
})

describe('renderDashboard: the resume panel through the real frame gutter', () => {
  // Content width is TWO less than the terminal width anyone eyeballs, which is
  // the half of the trap that a direct `resumeKeysRows(80)` check misses. These
  // go through `renderDashboard` so the gutter is included rather than assumed.
  const answering = (value = ''): DashboardModel => ({
    ...model([build({ status: 'blocked', blockers: ['Which merge strategy?'] })]),
    selection: { kind: 'build', slug: 'auth-rate-limit' },
    resumeInput: { slug: 'auth-rate-limit', value, cursor: [...value].length },
  })

  test('terminal widths 14, 20, 40, and 80 all state both facts and name all three actions', () => {
    // Terminal width 14 is content width 12 — the case revision 4's own table
    // contradicted.
    for (const width of [14, 20, 40, 80]) {
      const out = rd(answering('x'), { color: false, width, height: 30 }).join('\n')
      expect(out).toMatch(/optional/i)
      // `\s+` because the hint WRAPS at narrow widths — it pays in rows, and
      // the two facts survive across the break.
      expect(out).toMatch(/Enter\s+(?:on\s+an\s+empty\s+field|alone)\s+resumes/i)
      expect(out).toContain('submit')
      expect(out).toContain('newline')
      expect(out).toContain('cancel')
    }
  })
})

describe('renderDashboard: the resume panel allocation (AC 7)', () => {
  // The drop order IS the AC, so it is walked as a list rather than spot
  // checked: the field and its bindings survive last, the blocker goes first.
  const allocating = (value: string, blocker: string): DashboardModel => ({
    ...model([build({ status: 'blocked', blockers: [blocker] })]),
    resumeInput: { slug: 'auth-rate-limit', value, cursor: [...value].length },
  })

  const blocksOf = (rows: string[], width: number) => {
    const hint = resumeHintRows(width)
    const keys = resumeKeysRows(width)
    return {
      title: rows.filter((row) => row.startsWith('Resume')).length,
      hint: rows.filter((row) => hint.includes(row)).length,
      question: rows.filter((row) => row.includes('Q') || row.includes('...')).length,
      field: rows.filter((row) => row.includes('Z')).length,
      keys: rows.filter((row) => keys.includes(row)).length,
    }
  }

  type Blocks = ReturnType<typeof blocksOf>
  const CASES: Array<[number, Array<[number, Blocks]>]> = [
    [
      78,
      [
        [1, { title: 0, hint: 0, question: 0, field: 1, keys: 0 }],
        [2, { title: 0, hint: 0, question: 0, field: 1, keys: 1 }],
        [3, { title: 1, hint: 0, question: 0, field: 1, keys: 1 }],
        [4, { title: 1, hint: 1, question: 0, field: 1, keys: 1 }],
        [6, { title: 1, hint: 1, question: 1, field: 2, keys: 1 }],
        [9, { title: 1, hint: 1, question: 1, field: 3, keys: 1 }],
        [11, { title: 1, hint: 1, question: 1, field: 3, keys: 1 }],
        [12, { title: 1, hint: 1, question: 1, field: 3, keys: 1 }],
      ],
    ],
    [
      12,
      [
        [1, { title: 0, hint: 0, question: 0, field: 1, keys: 0 }],
        [2, { title: 0, hint: 0, question: 0, field: 1, keys: 1 }],
        [4, { title: 0, hint: 0, question: 0, field: 1, keys: 3 }],
        [6, { title: 1, hint: 0, question: 0, field: 1, keys: 4 }],
        [9, { title: 1, hint: 3, question: 0, field: 1, keys: 4 }],
        [11, { title: 1, hint: 4, question: 1, field: 1, keys: 4 }],
        [12, { title: 1, hint: 4, question: 1, field: 2, keys: 4 }],
      ],
    ],
    [
      11,
      [
        [1, { title: 0, hint: 0, question: 0, field: 1, keys: 0 }],
        [3, { title: 0, hint: 0, question: 0, field: 1, keys: 2 }],
        [6, { title: 0, hint: 0, question: 0, field: 1, keys: 5 }],
        [9, { title: 1, hint: 2, question: 0, field: 1, keys: 5 }],
        // The narrow worst case: eleven rows of named blocks, and the blocker
        // still has not been granted one.
        [11, { title: 1, hint: 4, question: 0, field: 1, keys: 5 }],
        [12, { title: 1, hint: 4, question: 1, field: 1, keys: 5 }],
      ],
    ],
  ]

  test('PRIORITY IS A PREFIX: no block ever outlives a higher-priority one', () => {
    // The capacity walk above only exercises widths where every block is
    // representable. A width-DROPPED block is the other way the order can be
    // broken, and it broke it: below content width 7 `resumeKeysRows` is empty,
    // and the allocator used to sail past it into the title and the blocker —
    // printing a question the operator cannot answer because the panel no
    // longer names a single key.
    const m = allocating('Z'.repeat(200), 'QQQ short blocker')
    for (let width = 1; width <= 40; width += 1) {
      for (let capacity = 0; capacity <= 14; capacity += 1) {
        const rows = resumePanel(m, false, width, capacity).map(stripAnsi)
        const at = blocksOf(rows, width)
        const where = `width ${width}, capacity ${capacity}`
        // field > keys > title > hint > questions, top to bottom.
        expect([where, at.keys > 0 && at.field === 0]).toEqual([where, false])
        expect([where, at.title > 0 && at.keys === 0]).toEqual([where, false])
        expect([where, at.hint > 0 && at.title === 0]).toEqual([where, false])
        expect([where, at.question > 0 && at.hint === 0]).toEqual([where, false])
      }
    }
  })

  test('at the keys boundary the panel is the field and nothing else', () => {
    // `resumeKeysRows(6) === []`: no layout can name `newline`, so the block is
    // dropped whole — and everything below it in the order goes with it, however
    // much capacity is left over. The rows freed up make the field taller,
    // because the field outranks every block that can halt the order.
    const m = allocating('Z'.repeat(200), 'QQQ short blocker')
    expect(resumeKeysRows(6)).toEqual([])
    for (const capacity of [1, 4, 12, 40]) {
      const rows = resumePanel(m, false, 6, capacity).map(stripAnsi)
      expect(blocksOf(rows, 6)).toEqual({
        title: 0,
        hint: 0,
        question: 0,
        field: Math.min(capacity, 6),
        keys: 0,
      })
      expect(rows.join('\n')).not.toContain('Resume')
      expect(rows.join('\n')).not.toContain('Q')
      expect(rows.join('\n')).not.toContain('...')
    }
    // One column wider, the keys come back and carry the title with them.
    expect(blocksOf(resumePanel(m, false, 7, 12).map(stripAnsi), 7)).toEqual({
      title: 1,
      hint: 0,
      question: 0,
      field: 5,
      keys: 6,
    })
  })

  test('at the hint boundary the blocker goes but the keys stay', () => {
    // `resumeHintRows(10) === []`, so questions halt with it — but the field and
    // its bindings, which AC 7 keeps last, are untouched.
    const m = allocating('Z'.repeat(200), 'QQQ short blocker')
    expect(resumeHintRows(10)).toEqual([])
    const narrow = resumePanel(m, false, 10, 12).map(stripAnsi)
    expect(blocksOf(narrow, 10)).toEqual({
      title: 1,
      hint: 0,
      question: 0,
      field: 6,
      keys: 5,
    })
    // One column wider the hint fits, and the blocker returns behind it.
    const wider = resumePanel(m, false, 11, 12).map(stripAnsi)
    expect(blocksOf(wider, 11).hint).toBeGreaterThan(0)
    expect(blocksOf(wider, 11).question).toBeGreaterThan(0)
    expect(blocksOf(wider, 11).keys).toBe(5)
  })

  for (const [width, steps] of CASES) {
    test(`content width ${width}`, () => {
      for (const [capacity, expected] of steps) {
        const rows = resumePanel(
          allocating('Z'.repeat(200), 'QQQ short blocker'),
          false,
          width,
          capacity,
        ).map(stripAnsi)
        expect(rows.length).toBeLessThanOrEqual(capacity)
        for (const row of rows) expect(row.length).toBeLessThanOrEqual(width)
        expect({ capacity, ...blocksOf(rows, width) }).toEqual({ capacity, ...expected })
      }
    })
  }
})

describe('renderDashboard: the resume panel never loses a question silently (AC 3)', () => {
  const asking = (blockers: string[]): DashboardModel => ({
    ...model([build({ status: 'blocked', blockers })]),
    resumeInput: { slug: 'auth-rate-limit', value: '', cursor: 0 },
  })

  test('an 80-character unbroken token appears IN FULL across question rows', () => {
    const token = `https://example.test/${'p'.repeat(59)}`
    expect(token).toHaveLength(80)
    const rows = resumePanel(asking([`see ${token} now`]), false, 40, 12).map(stripAnsi)
    const questions = rows.filter(
      (row) => row.trimStart().startsWith('!') || row.startsWith('    '),
    )
    expect(questions.join('').replace(/[!\s]/g, '')).toContain(token)
    expect(questions.join('')).not.toContain('~')
  })

  test('an over-long blocker ends in an explicit omission notice, not a silent cut', () => {
    const rows = resumePanel(
      asking([Array.from({ length: 40 }, (_, i) => `word${i}`).join(' ')]),
      false,
      40,
      12,
    ).map(stripAnsi)
    const questions = rows.filter((row) => row.includes('word') || row.includes('...'))
    expect(questions.at(-1)).toMatch(/\.\.\. and \d+ more lines/)
  })

  test('with no capacity for questions the blocker is absent — the drop order, not a cut', () => {
    const rows = resumePanel(asking(['a question']), false, 78, 2).map(stripAnsi)
    expect(rows.join('\n')).not.toContain('a question')
    expect(rows.join('\n')).not.toContain('...')
  })
})

describe('renderDashboard: the resume panel obeys the frame budget', () => {
  const answering = (value: string): DashboardModel => ({
    ...model([
      build({ status: 'blocked', blockers: ['Which merge strategy should finalize use?'] }),
    ]),
    selection: { kind: 'build', slug: 'auth-rate-limit' },
    resumeInput: { slug: 'auth-rate-limit', value, cursor: [...value].length },
  })

  test('every width x height combination stays inside the frame', () => {
    // Widths start at 1, not at a comfortable 8: `renderDashboard` reserves its
    // one-column gutter BEFORE composing, so the interesting boundary is the
    // terminal that leaves the panel ZERO content columns.
    for (const width of [1, 2, 3, 4, 5, 8, 11, 13, 14, 20, 40, 80, 200]) {
      for (const height of [0, 1, 2, 3, 5, 8, 14, 26, 30]) {
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

  test('a ONE-column terminal renders no field column the frame did not grant', () => {
    // The gutter leaves zero content columns here. Clamping the field back up
    // to one column produced a two-column physical row on a one-column screen:
    // the caret plus the gutter the outer renderer adds afterwards.
    for (const height of [1, 3, 5, 10, 30]) {
      const lines = rd(answering('abc'), { color: false, width: 1, height })
      expect(lines.length).toBeLessThanOrEqual(height)
      for (const line of lines) expect(line.length).toBeLessThanOrEqual(1)
      expect(lines.join('')).not.toContain('|')
    }
    // And the panel itself is empty rather than one manufactured column.
    expect(resumePanel(answering('abc'), false, 0, 12)).toEqual([])
    expect(resumePanel(answering('abc'), false, -1, 12)).toEqual([])
  })

  test('a two-column terminal still fits its single content column', () => {
    // One content column is the narrowest frame that can show anything, and
    // the caret is what it shows.
    const lines = rd(answering('abc'), { color: false, width: 3, height: 30 })
    for (const line of lines) expect(line.length).toBeLessThanOrEqual(3)
    expect(lines.join('\n')).toContain('|')
  })

  test('the field and its bindings outlive the blocker text as height disappears', () => {
    const m = answering('typed')
    const tall = rd(m, { color: false, width: 100, height: 30 }).join('\n')
    expect(tall).toContain('Which merge strategy should finalize use?')

    const short = rd(m, { color: false, width: 100, height: 8 }).join('\n')
    expect(short).not.toContain('Which merge strategy should finalize use?')
    expect(short).toContain('typed|')
    expect(short).toContain('submit')
  })

  test('the detail view drops the panel last too', () => {
    const m = { ...answering('typed'), view: { kind: 'detail' as const, slug: 'auth-rate-limit' } }
    for (const height of [3, 4, 5, 8]) {
      const lines = rd(m, { color: false, width: 100, height })
      expect(lines.length).toBeLessThanOrEqual(height)
      expect(lines.join('\n')).toContain('typed|')
    }
  })

  test('plain rendering has no ANSI and escapes non-ASCII without changing the model value', () => {
    const m = answering('type p/m, caf\u00e9')
    const out = rd(m, { color: false, width: 100, height: 30 }).join('\n')
    expect(out).not.toContain('\x1b')
    expect(out).toContain('type p/m, caf\\u{e9}')
    expect(m.resumeInput?.value).toBe('type p/m, caf\u00e9')
  })

  test('a prompt frame emits only escape vocabulary the capture adapter accepts', () => {
    const lines = rd(answering('multi\nline guidance'), { color: true, width: 120, height: 30 })
    const image = renderDashboardFrameImage(lines, { columns: 120 })
    expect([...image.png.slice(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10])
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

  test('a setup failure is attributed beneath its build, wraps, and escapes controls', () => {
    const lines = rd(
      model([
        build({
          slug: 'broken-setup',
          pr: undefined,
          setupError:
            '[commands].setup "bun install" failed (attempt 2, exit status 1): first line\nsecond\u001b[2J line',
        }),
      ]),
      { color: false, width: 48 },
    ).map(stripAnsi)
    const frame = lines.join('\n')
    expect(frame).toContain('broken-setup')
    expect(frame).toContain('[commands].setup')
    expect(frame).toContain('second\\u{1b}[2J')
    expect(frame).not.toContain('\u001b[2J')
    expect(lines.every((line) => line.length <= 48)).toBe(true)
  })

  test('every unresolved blocker gets its own line', () => {
    const out = rd(
      model([build({ status: 'blocked', blockers: ['first question', 'second question'] })]),
      WIDE,
    )
    expect(out.some((l) => l.includes('first question'))).toBe(true)
    expect(out.some((l) => l.includes('second question'))).toBe(true)
  })

  test('an auto-merge wait blocker preserves the complete provider detail', () => {
    const reason =
      "Auto-merge gate could not apply consent for PR #7: local merge blocked - error: Entry 'autobuild.toml' not uptodate."
    const out = rd(model([build({ blockers: [reason] })]), { color: false, width: 160 })
    expect(out.join('\n')).toContain(reason)
  })

  test('a PR URL becomes an OSC 8 hyperlink when color is on', () => {
    const out = colored(build({ pr: { url: 'https://x/7', state: 'open' } }))
    expect(out).toContain('\x1b]8;;https://x/7\x07PR open\x1b]8;;\x07')
  })

  test('a local PR locator is visible literally and never emitted as an OSC link', () => {
    const out = colored(build({ pr: { url: 'refs/heads/ab/local-change', state: 'open' } }))
    expect(out).toContain('PR open refs/heads/ab/local-change')
    expect(out).not.toContain('\x1b]8;;refs/heads/')
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
    const legend = lines.findIndex((line) => line.startsWith(' Keys:'))
    expect(legend).toBeGreaterThan(0)
    for (const line of lines.slice(0, legend)) {
      if (line === '') continue
      expect(line[0]).toBe(' ')
      expect(['  ', '> ']).toContain(line.slice(1, 3))
    }
    expect(lines.slice(0, legend).filter((line) => line.startsWith(' > '))).toHaveLength(1)
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
    expect(lines.filter((line) => line.startsWith(' > '))).toHaveLength(1)
    expect(lines.find((line) => line.startsWith(' > '))).toContain('b')
  })
})

describe('renderDashboard: one-column horizontal frame gutters', () => {
  function expectInsideGutters(lines: string[], width: number): void {
    for (const line of lines) {
      const plain = stripAnsi(line)
      expect(plain.length).toBeLessThanOrEqual(Math.max(0, width - 1))
      const first = plain.search(/\S/)
      if (first < 0) continue
      expect(first).toBeGreaterThanOrEqual(1)
      expect(first).toBeLessThanOrEqual(width - 2)
      expect(plain.search(/\s*$/) - 1).toBeLessThanOrEqual(width - 2)
    }
  }

  test('every line family is inset without changing the internal marker lane', () => {
    const dashboard = {
      ...model([
        build({
          status: 'blocked' as const,
          pr: undefined,
          blockers: [
            'a blocker message long enough to wrap across the reduced dashboard content width',
          ],
        }),
      ]),
      warningLine: 'ticket source unavailable',
      harvest: harvest({ status: 'failed', detail: 'stopped at review after automatic recovery' }),
      selection: { kind: 'build' as const, slug: 'auth-rate-limit' },
    }
    const lines = rd(dashboard, { color: false, width: 52 })
    expectInsideGutters(lines, 52)

    const summary = lines.find((line) => line.includes('Autobuild'))!
    const toggles = lines.find((line) => line.includes('intake ON'))!
    const warning = lines.find((line) => line.includes('ticket source unavailable'))!
    const selected = lines.find((line) => line.includes('auth-rate-limit'))!
    const progress = lines.find((line) => line.includes('[x] plan'))!
    const blocker = lines.find((line) => line.includes('! a blocker'))!
    const controls = lines.find((line) => line.includes('Keys:'))!

    expect(summary.indexOf('Autobuild')).toBe(3)
    expect(toggles.search(/\S/)).toBe(3)
    expect(warning.search(/\S/)).toBe(3)
    expect(selected.startsWith(' > ')).toBe(true)
    expect(progress.indexOf('[')).toBe(3)
    expect(blocker.indexOf('!')).toBe(3)
    expect(controls.startsWith(' Keys:')).toBe(true)
  })

  test('right-pinned build and Harvest statuses end at terminal column N-1', () => {
    for (const color of [false, true]) {
      const width = 80
      const lines = rd(
        {
          ...model([build({ slug: 'build-row', pr: undefined })]),
          harvest: harvest(),
        },
        { color, width },
      )
      const buildLine = stripAnsi(lines.find((line) => stripAnsi(line).includes('build-row'))!)
      const harvestLine = stripAnsi(lines.find((line) => stripAnsi(line).includes('Harvest'))!)
      for (const line of [buildLine, harvestLine]) {
        expect(line.length).toBe(width - 1)
        expect(line.endsWith('RUNNING')).toBe(true)
      }
    }
  })

  test('normal and narrow frames never paint either terminal edge or exceed their width', () => {
    const complex = {
      ...model([
        build({
          status: 'blocked' as const,
          blockers: ['wrapped blocker detail '.repeat(8)],
        }),
        ...Array.from({ length: 5 }, (_, index) =>
          build({ slug: `overflow-${index}`, ticketId: `AUT-${index}`, pr: undefined }),
        ),
      ]),
      warningLine: 'warning row',
      harvest: harvest({ status: 'failed', detail: 'harvest detail '.repeat(6) }),
      selection: { kind: 'build' as const, slug: 'overflow-4' },
    }

    for (const color of [false, true]) {
      for (const width of [0, 1, 2, 3, 8, 24, 60, 100]) {
        expectInsideGutters(rd(complex, { color, width, height: 16 }), width)
        expectInsideGutters(rd(model([]), { color, width }), width)
      }
    }

    const overflow = rd(complex, { color: false, width: 60, height: 16 })
    expect(overflow.some((line) => line.includes('more'))).toBe(true)
    expectInsideGutters(overflow, 60)
    const empty = rd(model([]), { color: false, width: 60 })
    expect(empty.some((line) => line.includes('no active builds'))).toBe(true)
    expectInsideGutters(empty, 60)
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
    expect(line.startsWith(' > ')).toBe(true)
    expect(line).toContain('Harvest')
    expect(line).toContain('36 observations')
    expect(lines.join('\n')).not.toContain('harvest_internal_123')
    expect(lines.filter((candidate) => candidate.startsWith(' > '))).toHaveLength(1)
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
    expect(harvestPlain.length).toBe(99)
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

  test('the build legend stays one physical row at a narrow width', () => {
    // The list-view legend is the longest it has ever been now that it carries
    // `Enter details`, and the controls line has no wrapping path — it either
    // fits or it truncates.
    const lines = rd(
      {
        ...model([build()]),
        selection: { kind: 'build', slug: 'auth-rate-limit' },
      },
      { color: false, width: 40 },
    )
    const controls = lines.at(-1)!
    expect(controls.startsWith(' Keys:')).toBe(true)
    expect(controls.length).toBeLessThanOrEqual(39) // the frame's width - 1 contract
    expect(controls.endsWith('~')).toBe(true)
    expect(lines.filter((line) => line.includes('Keys:'))).toHaveLength(1)
  })

  test('the global legend stays one physical row at a narrow width', () => {
    // The global legend is now the longest of them all — it carries both
    // repository toggles and both bulk controls — and, like the build one, it
    // either fits or it truncates.
    const lines = rd(
      { ...model([build()]), selection: { kind: 'global' } },
      { color: false, width: 40 },
    )
    const controls = lines.at(-1)!
    expect(controls.startsWith(' Keys:')).toBe(true)
    expect(controls.length).toBeLessThanOrEqual(39) // the frame's width - 1 contract
    expect(controls.endsWith('~')).toBe(true)
    expect(lines.filter((line) => line.includes('Keys:'))).toHaveLength(1)
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
        if (height >= 1) expect(lines[0]).toContain('Autobuild')
        if (height >= 2) {
          expect(lines[1]).toContain('intake ON')
          expect(lines[1]).toContain('harvest ON')
        }
        if (warningLine !== undefined && height >= 3) {
          expect(lines[2]).toBe(`   ${warningLine}`)
        }
        for (const line of lines) expect(line.length).toBeLessThanOrEqual(80)
      }
    }
  })

  test('the header survives the clamp — it is the line the ACs name', () => {
    for (let height = 1; height <= 12; height += 1) {
      const [header] = rd(model(many(8)), { color: false, width: 80, height })
      expect(header).toContain('Autobuild')
      expect(header).toContain('queue 2')
      // The count is on the header, so it still reports every build even when
      // most rows are clamped away.
      expect(header).toContain('active 8/5')
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
      expect(lines.some((line) => line.startsWith(` > AB-${selected}`))).toBe(true)
      expect(lines.at(-1)).toContain('Up/Down')
    }
  })

  test('a selected harvest or build remains visible when both participate in overflow', () => {
    const base = { ...model(many(8)), harvest: harvest() }
    const harvestLines = rd(
      { ...base, selection: { kind: 'harvest' } },
      { color: false, width: 80, height: 8 },
    )
    expect(harvestLines.some((line) => line.startsWith(' > ') && line.includes('Harvest'))).toBe(
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
    expect(buildLines.some((line) => line.startsWith(' > AB-7'))).toBe(true)
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
      .filter((l) => l.startsWith('   ['))
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
      .filter((l) => l.trimStart().startsWith('!') || /^\s{5}\S/.test(l))
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
    expect(line.startsWith('   ENG-42')).toBe(true)
    expect(line.indexOf('auth-rate-limit')).toBeGreaterThan(line.indexOf('ENG-42'))
  })

  test('the status is right-aligned: the line ends with it, flush to the width (AC 1)', () => {
    const line = stripAnsi(
      slugLine(rd(model([build({ pr: undefined })]), { color: false, width: 60 })),
    )
    expect(line.length).toBe(59)
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
    expect(line.startsWith('   solo')).toBe(true) // gutter + marker lane, no ticket column
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
    rd(model([b]), { color, width: 120, now }).find((l) => l.startsWith('   ['))!

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

describe('renderDashboard: build detail and transcript views', () => {
  const detailedBuild = build({
    alsoPaused: true,
    status: 'blocked',
    autoMerge: 'enabled',
    blockers: ['The complete blocker question must remain readable even when it is fairly long.'],
    steps: [
      { label: 'plan', state: 'done', count: 1, timing: { accumulatedMs: 2_000 } },
      { label: 'verify:unit', state: 'current', count: 2, timing: { accumulatedMs: 3_000 } },
    ],
    sessions: [
      {
        id: 's_plan',
        role: 'plan',
        phase: 'plan',
        round: 1,
        runtime: 'pi',
        model: 'openai/gpt',
        startedSeq: 5,
        status: 'ended',
        transcript: { kind: 'transcript', rev: 2 },
        usage: { inputTokens: 90, outputTokens: 30, turns: 2 },
      },
      {
        id: 's_review',
        role: 'plan-review',
        phase: 'plan-review',
        round: 1,
        runtime: 'claude',
        startedSeq: 9,
        status: 'open',
      },
    ],
  })

  test('detail exposes status, pipeline counts, blockers, PR, and selectable session metadata', () => {
    const out = rd(
      {
        ...model([detailedBuild]),
        selection: { kind: 'build', slug: detailedBuild.slug },
        view: { kind: 'detail', slug: detailedBuild.slug, sessionId: 's_plan' },
      },
      { color: false, width: 200 },
    ).join('\n')
    expect(out).toContain('status BLOCKED (also paused)')
    expect(out).toContain('auto merge enabled')
    expect(out).toContain('PR open')
    expect(out).toContain('plan (round 1, 2s)')
    expect(out).toContain('verify:unit (attempt 2, 3s)')
    expect(out).toContain('complete blocker question')
    expect(out).toContain('>   plan phase plan round 1 runtime pi model openai/gpt ended')
    expect(out).toContain('tokens 90 in/30 out, 2 turns')
    expect(out).toContain('plan-review phase plan-review round 1 runtime claude open')
    expect(out).not.toContain('Autobuild')
  })

  test('structured and producer-boundary transcripts render prompts, text, failures, usage, and notice', () => {
    const base = {
      ...model([detailedBuild]),
      selection: { kind: 'build', slug: detailedBuild.slug },
    } as DashboardModel
    const structured = rd(
      {
        ...base,
        view: {
          kind: 'transcript',
          slug: detailedBuild.slug,
          sessionId: 's_plan',
          scroll: 0,
          transcript: {
            kind: 'turns',
            turns: [
              {
                prompt: '/ab-plan auth',
                text: 'agent response',
                usage: { inputTokens: 4, outputTokens: 2 },
                failure: 'provider failed',
              },
            ],
          },
        },
      },
      { color: false, width: 100 },
    ).join('\n')
    expect(structured).toContain('Prompt: /ab-plan auth')
    expect(structured).toContain('Agent: agent response')
    expect(structured).toContain('Usage: 4 input, 2 output')
    expect(structured).toContain('Failure: provider failed')

    const boundary = rd(
      {
        ...base,
        view: {
          kind: 'transcript',
          slug: detailedBuild.slug,
          sessionId: 's_plan',
          scroll: 0,
          transcript: {
            kind: 'producer-boundary',
            notice: 'Producer boundary record: only this round was deposited.',
            turns: [{ prompt: 'round', text: 'done' }],
          },
        },
      },
      { color: false, width: 100 },
    ).join('\n')
    expect(boundary).toContain('Producer boundary record')
  })

  test('scroll limits track wrapped content and viewport size', () => {
    const presentation = {
      kind: 'raw' as const,
      text: Array.from({ length: 20 }, (_, index) => `raw line ${index}`).join('\n'),
    }
    const roomy = transcriptScrollLimit(presentation, 80, 12)
    const narrow = transcriptScrollLimit(presentation, 12, 12)
    expect(roomy).toBeGreaterThan(0)
    expect(narrow).toBeGreaterThan(roomy)
    expect(transcriptScrollLimit(presentation, 80, 40)).toBe(0)
    // An overshot legacy/resize value is clamped before movement, so Up moves
    // off the bottom immediately rather than silently unwinding hidden offset.
    expect(moveTranscriptScroll(presentation, 80, 12, 999, -1)).toBe(roomy - 1)
    expect(moveTranscriptScroll(presentation, 80, 12, roomy, 1)).toBe(roomy)
  })

  test('raw fallback, scrolling, and tiny terminals obey width and height caps', () => {
    const presentation = {
      kind: 'raw' as const,
      text: Array.from({ length: 20 }, (_, index) => `raw line ${index} café`).join('\n'),
    }
    for (const width of [12, 30, 80]) {
      for (const height of [0, 1, 5, 12]) {
        const lines = rd(
          {
            ...model([detailedBuild]),
            view: {
              kind: 'transcript',
              slug: detailedBuild.slug,
              sessionId: 's_plan',
              scroll: 7,
              transcript: presentation,
            },
          },
          { color: true, width, height },
        )
        expect(lines.length).toBeLessThanOrEqual(height)
        expect(lines.every((line) => stripAnsi(line).length <= width)).toBe(true)
      }
    }
    const scrolled = rd(
      {
        ...model([detailedBuild]),
        view: {
          kind: 'transcript',
          slug: detailedBuild.slug,
          sessionId: 's_plan',
          scroll: 7,
          transcript: presentation,
        },
      },
      { color: false, width: 80, height: 12 },
    ).join('\n')
    expect(scrolled).toContain('raw line 5')
    expect(scrolled).not.toContain('raw line 0')
  })
})
