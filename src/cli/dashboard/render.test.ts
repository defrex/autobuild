/**
 * The renderer (src/cli/dashboard/render.ts) — pure, so every AC about what
 * the operator can SEE is assertable here without a terminal.
 */
import { describe, expect, test } from 'bun:test'
import { renderDashboard, stripAnsi } from './render'
import type { DashboardBuild, DashboardModel } from './model'

/**
 * The default fixture carries a `pr` on purpose. Without one, no test ever
 * truncated a line containing a hyperlink — which is exactly how an unclosed
 * OSC 8 (`f_f72ad952`) survived a green suite.
 */
function build(overrides: Partial<DashboardBuild> = {}): DashboardBuild {
  return {
    slug: 'auth-rate-limit',
    status: 'running',
    alsoPaused: false,
    ticketId: 'ENG-42',
    phase: 'implement',
    steps: [
      { label: 'plan', state: 'done' },
      { label: 'implement', state: 'current', note: 'r2' },
      { label: 'verify:test', state: 'pending' },
    ],
    blockers: [],
    pr: { url: 'https://github.com/defrex/app/pull/7', state: 'open' },
    ...overrides,
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
  return { repo: '/repos/app', mode: 'watch', capacity: 2, builds }
}

const WIDE = { color: false, width: 200 }

describe('renderDashboard: the header', () => {
  test('names the repo, the mode and the capacity', () => {
    const [header] = renderDashboard(model([build()]), WIDE)
    expect(header).toContain('app') // the repo basename
    expect(header).toContain('watch')
    expect(header).toContain('capacity 2')
    expect(header).toContain('1 active')
  })

  test('an empty dashboard says so', () => {
    const lines = renderDashboard(model([]), WIDE)
    expect(lines.join('\n')).toContain('no active builds')
  })

  test('mode reads `once` for a single pass', () => {
    const [header] = renderDashboard({ ...model([]), mode: 'once' }, WIDE)
    expect(header).toContain('once')
  })
})

describe('renderDashboard: plain mode (the --plain AC)', () => {
  test('color: false emits NOT ONE escape byte', () => {
    const out = renderDashboard(
      model([
        build({ status: 'blocked', blockers: ['which algorithm?'] }),
        build({ slug: 'other', status: 'paused', alsoPaused: false, pr: { url: 'https://x/1', state: 'open' } }),
      ]),
      WIDE,
    ).join('\n')
    expect(out).not.toContain('\x1b')
  })

  test('the PR URL is bare in plain mode — terminals linkify it themselves', () => {
    const out = renderDashboard(
      model([build({ pr: { url: 'https://github.com/defrex/app/pull/7', state: 'open' } })]),
      WIDE,
    ).join('\n')
    expect(out).toContain('https://github.com/defrex/app/pull/7')
    expect(out).not.toContain('\x1b]8')
  })
})

describe('renderDashboard: never color-only', () => {
  test('every step state carries a glyph, and every status its literal word', () => {
    const out = renderDashboard(
      model([
        build({ status: 'blocked' }),
        build({ slug: 'b', status: 'paused' }),
        build({ slug: 'c', status: 'running' }),
      ]),
      WIDE,
    ).join('\n')
    // Steps: done / current / pending, all distinguishable with color stripped.
    expect(out).toContain('[x] plan')
    expect(out).toContain('[>] implement(r2)')
    expect(out).toContain('[ ] verify:test')
    // Statuses: words, not hues.
    expect(out).toContain('BLOCKED')
    expect(out).toContain('PAUSED')
    expect(out).toContain('RUNNING')
  })

  test('the same glyphs and words survive WITH color on', () => {
    const out = renderDashboard(model([build({ status: 'blocked' })]), { color: true, width: 200 })
    const plain = stripAnsi(out.join('\n'))
    expect(plain).toContain('[x] plan')
    expect(plain).toContain('BLOCKED')
  })
})

describe('renderDashboard: emphasis', () => {
  const colored = (b: DashboardBuild): string =>
    renderDashboard(model([b]), { color: true, width: 200 }).join('\n')

  test('blocked is red; paused is yellow', () => {
    expect(colored(build({ status: 'blocked' }))).toContain('\x1b[31m')
    expect(colored(build({ status: 'paused' }))).toContain('\x1b[33m')
  })

  test('a blocked+paused build shows BLOCKED in red AND keeps the pause visible', () => {
    const out = colored(build({ status: 'blocked', alsoPaused: true }))
    expect(out).toContain('\x1b[31m') // blocked wins the status…
    expect(stripAnsi(out)).toContain('BLOCKED')
    expect(stripAnsi(out)).toContain('(paused)') // …without losing the pause
    expect(out).toContain('\x1b[33m')
  })

  test('every unresolved blocker gets its own line', () => {
    const out = renderDashboard(
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
})

describe('renderDashboard: layout', () => {
  test('columns align across builds of differing slug length', () => {
    const lines = renderDashboard(
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

  test('builds are separated by a blank line', () => {
    const lines = renderDashboard(model([build({ slug: 'a' }), build({ slug: 'b' })]), WIDE)
    expect(lines.filter((l) => l === '')).toHaveLength(2)
  })
})

describe('renderDashboard: truncation (one rendered line = one physical row)', () => {
  // If a line exceeds the width the terminal wraps it, the painted-line count
  // under-counts, and the redraw's cursor-up clears too little — leaving
  // accumulating fragments, the exact thing the no-accumulation AC forbids.

  test('no line exceeds the width, in plain or color', () => {
    const long = build({
      slug: 'a-very-long-slug-that-goes-on'.repeat(3),
      blockers: ['a blocker message that is far too long to fit on one line'.repeat(3)],
    })
    for (const color of [false, true]) {
      const lines = renderDashboard(model([long]), { color, width: 40 })
      for (const line of lines) expect(stripAnsi(line).length).toBeLessThanOrEqual(40)
    }
  })

  test('truncation never splits an escape sequence or leaks color', () => {
    const lines = renderDashboard(
      model([build({ status: 'blocked', blockers: ['x'.repeat(200)] })]),
      { color: true, width: 30 },
    )
    for (const line of lines) {
      // Every escape we emit is a complete, well-formed sequence…
      const leftovers = line.replace(/\x1b\][^\x07]*\x07/g, '').replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')
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
      phase: 'verify:test',
    })
    // Sweep the widths so the cut lands in every part of the link — before it,
    // inside its text, and past it.
    for (let width = 10; width <= 120; width += 1) {
      const lines = renderDashboard(model([real, build({ slug: 'b' })]), { color: true, width })
      for (const line of lines) expect(unclosedLinks(line)).toBe(0)
    }
  })

  test('a link cut exactly inside its TEXT still closes — the regression window', () => {
    // Width 80 with the real slug lands the cut inside "PR open".
    const line = renderDashboard(
      model([
        build({
          slug: 'interactive-build-dashboard-for-ab-dispatch',
          ticketId: 'AB-123',
          phase: 'verify:test',
        }),
      ]),
      { color: true, width: 80 },
    ).find((l) => l.includes('\x1b]8;;'))
    expect(line).toBeDefined()
    expect(line).toContain('~') // it really was cut mid-link…
    expect(line).toContain('\x1b]8;;https://github.com/defrex/app/pull/7\x07') // …after opening it
    expect(unclosedLinks(line!)).toBe(0)
  })

  test('a line that fits is left exactly alone', () => {
    const lines = renderDashboard(model([build()]), WIDE)
    expect(lines.some((l) => l.includes('~'))).toBe(false)
  })
})

describe('renderDashboard: `height` caps the LINE count', () => {
  // f_d2e4b3ee — the width invariant's twin, on the other axis. `erase()`
  // cursors UP over the lines it painted, which only works while they are
  // still on screen; a taller frame scrolls its own top away, CUU clamps at
  // the top margin, and the header — the line AC 19 names — is the first thing
  // lost, while each repaint pushes snapshots into scrollback (AC 18).
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
      phase: 'verify:test',
      steps: [
        { label: 'plan', state: 'done' },
        { label: 'plan-review', state: 'done' },
        { label: 'implement', state: 'pending' },
        { label: 'code-review', state: 'pending' },
        { label: 'verify:lint', state: 'pending' },
        { label: 'verify:test', state: 'pending', note: 'failed' },
        { label: 'finalize', state: 'pending' },
        { label: 'merge', state: 'pending', note: 'waiting' },
      ],
      blockers: ['maxVerifyAttempts (3) exhausted: verify:test is still failing'],
    })
  const many = (n: number): DashboardBuild[] => Array.from({ length: n }, (_, i) => blocked(i))

  test('an unclamped frame really does overflow a default 80x24 — the bug', () => {
    // Only the RUNNING half of the listed set is bounded by capacity; blocked
    // builds accumulate until a human answers, which is the very condition the
    // dashboard exists to surface. Five is not a large backlog.
    const unbounded = renderDashboard(model(many(5)), { color: false, width: 80 })
    expect(unbounded.length).toBeGreaterThan(24)
  })

  test('…and the same frame clamped is within the cap it was given', () => {
    // NB: `height: 24` is not "fits a 24-row screen" — see the note above.
    const lines = renderDashboard(model(many(5)), { color: false, width: 80, height: 24 })
    expect(lines.length).toBeLessThanOrEqual(24)
  })

  test('never exceeds the height, over a sweep of heights and build counts', () => {
    for (const n of [0, 1, 2, 3, 5, 8, 20]) {
      for (let height = 0; height <= 40; height += 1) {
        for (const color of [false, true]) {
          const lines = renderDashboard(model(many(n)), { color, width: 80, height })
          expect(lines.length).toBeLessThanOrEqual(height)
        }
      }
    }
  })

  test('the header survives the clamp — it is the line the ACs name', () => {
    for (let height = 1; height <= 12; height += 1) {
      const [header] = renderDashboard(model(many(8)), { color: false, width: 80, height })
      expect(header).toContain('ab dispatch')
      expect(header).toContain('capacity 2')
      // The count is on the header, so it still reports every build even when
      // most rows are clamped away.
      expect(header).toContain('8 active')
    }
  })

  test('the overflow is VISIBLE, not silent — `... and N more`', () => {
    // Silent truncation would read as "these are all the builds", which is a
    // worse answer than the scrolling it replaces.
    const lines = renderDashboard(model(many(8)), { color: false, width: 80, height: 24 })
    const notice = lines.at(-1)
    expect(notice).toContain('more')
    const shown = lines.filter((l) => l.includes('BLOCKED')).length
    expect(notice).toContain(`and ${8 - shown} more`)
    expect(shown).toBeGreaterThan(0)
  })

  test('builds are dropped WHOLE — never a half-rendered build', () => {
    const lines = renderDashboard(model(many(8)), { color: false, width: 80, height: 24 })
    // Every rendered build brings its header, its progress rows and its
    // blocker; a build's blocker line never appears without its header.
    const headers = lines.filter((l) => l.includes('BLOCKED')).length
    const blockerLines = lines.filter((l) => l.trimStart().startsWith('!')).length
    expect(blockerLines).toBe(headers)
  })

  test('a frame that fits is not clamped and gets no notice', () => {
    const lines = renderDashboard(model(many(2)), { color: false, width: 80, height: 24 })
    expect(lines.some((l) => l.includes('more'))).toBe(false)
    expect(lines.filter((l) => l.includes('BLOCKED'))).toHaveLength(2)
  })

  test('height is optional — absent ⇒ unbounded, for callers not painting a screen', () => {
    expect(renderDashboard(model(many(5)), { color: false, width: 80 }).length).toBeGreaterThan(24)
  })

  test('a cap of 1 leaves the header and nothing else', () => {
    expect(renderDashboard(model([]), { color: false, width: 80, height: 1 })).toHaveLength(1)
    expect(renderDashboard(model(many(3)), { color: false, width: 80, height: 1 })).toHaveLength(1)
  })

  test('a cap of 0 paints NOTHING — not a header that would scroll itself off', () => {
    // What `paintableRows(1)` hands us on a 1-row screen. A single line there
    // would scroll away behind its own trailing newline and land in scrollback
    // on every repaint, which is worse than an empty region.
    expect(renderDashboard(model([]), { color: false, width: 80, height: 0 })).toEqual([])
    expect(renderDashboard(model(many(3)), { color: false, width: 80, height: 0 })).toEqual([])
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
      { label: 'plan', state: 'done' },
      { label: 'plan-review', state: 'done' },
      { label: 'implement', state: 'done', note: 'r2' },
      { label: 'code-review', state: 'done', note: 'r2' },
      { label: 'verify:lint', state: 'done' },
      { label: 'verify:test', state: 'current', note: 'a2' },
      { label: 'finalize', state: 'pending' },
      { label: 'merge', state: 'pending', note: 'waiting' },
    ],
  })

  test('every step survives at a width the row cannot fit on one line', () => {
    const progress = renderDashboard(model([full]), { color: false, width: 60 })
      .filter((l) => l.startsWith('  ['))
      .join('\n')
    for (const label of ['plan', 'implement(r2)', 'verify:test(a2)', 'finalize', 'merge(waiting)']) {
      expect(progress).toContain(label)
    }
    expect(progress).not.toContain('~') // no step was truncated away
  })

  test('…and the width guarantee still holds on every wrapped line', () => {
    for (const width of [30, 44, 60, 100]) {
      for (const color of [false, true]) {
        const lines = renderDashboard(model([full]), { color, width })
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
    const lines = renderDashboard(
      model([build({ status: 'blocked', blockers: [blocker] })]),
      { color: false, width: 50 },
    )
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
