import '../ansi.css'
import './catalog.css'
import { type ReactNode, StrictMode, useEffect, useMemo, useState } from 'react'
import { createRoot } from 'react-dom/client'
import {
  Gantt,
  type GanttAxis,
  GanttSkeleton,
  SegmentLegend,
  SegmentPopover,
} from '../charts/gantt'
import { type DurationMode, StepDurations, StepDurationsSkeleton } from '../charts/step-durations'
import { formatDuration } from '../charts/model'
import {
  AttentionLine,
  BuildRow,
  type BuildRowModel,
  DispatcherStrip,
  EmptySentence,
  FactList,
  Masthead,
  PageNav,
  SectionHeading,
} from '../components/composites'
import { Button, Choice, TextField, WordAction } from '../components/controls'
import {
  ConfirmDialog,
  Placeholder,
  SignOff,
  StateWord,
  StepList,
  type ThemeChoice,
  ThemeMenu,
} from '../components/display'
import { type FlowBlock, Masked, Reserve, StableFlow } from '../components/motion'
import { installClsProbe } from '../cls-probe'
import { chartHue, color, space, type } from '../tokens'
import { fixtureBuilds, fixtureStepStats, NOW } from './fixtures'

/** A step note as the projection writes it: `(4m12s)`. */
const n = (ms: number) => `(${formatDuration(ms)})`
/** The reserved width of a timed step's note. */
const SIZER = '(99h59m59s)'

function Section({
  id,
  title,
  intro,
  children,
}: {
  id: string
  title: string
  intro: string
  children: ReactNode
}) {
  return (
    <section data-catalog="section" id={id} aria-labelledby={`${id}-h`}>
      <h2 id={`${id}-h`}>{title}</h2>
      <p data-catalog="intro">{intro}</p>
      {children}
    </section>
  )
}

/** Render the same content on both grounds, side by side. */
function Grounds({
  children,
  stacked = false,
  paired = false,
}: {
  children: ReactNode
  stacked?: boolean
  /** Side by side at every width, so content below one ground never moves. */
  paired?: boolean
}) {
  return (
    <div
      data-catalog="grounds"
      data-stacked={stacked ? '' : undefined}
      data-paired={paired ? '' : undefined}
    >
      {(['light', 'dark'] as const).map((g) => (
        <div key={g} data-ground={g} data-catalog="ground">
          <span data-catalog="ground-label">{g}</span>
          {children}
        </div>
      ))}
    </div>
  )
}

function Specimen({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div data-catalog="specimen">
      <span data-catalog="specimen-label">{label}</span>
      <div data-catalog="specimen-body">{children}</div>
    </div>
  )
}

function luminance(hex: string) {
  const c = [1, 3, 5].map((i) => Number.parseInt(hex.slice(i, i + 2), 16) / 255)
  const [r, g, b] = c.map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)) as [
    number,
    number,
    number,
  ]
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}
function contrast(a: string, b: string) {
  const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p) as [number, number]
  return (x + 0.05) / (y + 0.05)
}

function Tokens() {
  return (
    <>
      <div data-catalog="token-grid">
        {(['light', 'dark'] as const).map((g) => (
          <div key={g} data-ground={g} data-catalog="ground">
            <span data-catalog="ground-label">{g}</span>
            <ul data-catalog="swatches">
              {Object.entries(color[g]).map(([name, hex]) => (
                <li key={name}>
                  <span data-catalog="chip" style={{ background: hex }} />
                  <span data-ansi="machine">{name}</span>
                  <span data-ansi="machine" data-catalog="hex">
                    {hex}
                  </span>
                  <span data-ansi="machine" data-catalog="ratio">
                    {name === 'ground' ? '' : `${contrast(hex, color[g].ground).toFixed(1)}:1`}
                  </span>
                </li>
              ))}
            </ul>
            <h4>Chart hues</h4>
            <ul data-catalog="swatches">
              {Object.entries(chartHue[g]).map(([name, hex]) => (
                <li key={name}>
                  <span data-catalog="chip" style={{ background: hex }} />
                  <span data-ansi="machine">chart-{name}</span>
                  <span data-ansi="machine" data-catalog="hex">
                    {hex}
                  </span>
                  <span data-ansi="machine" data-catalog="ratio">
                    {contrast(hex, color[g].ground).toFixed(1)}:1
                  </span>
                </li>
              ))}
            </ul>
            <h4>Segment fills</h4>
            <SegmentLegend />
          </div>
        ))}
      </div>
      <div data-catalog="scales">
        <Specimen label="Type">
          <p
            style={{
              fontSize: type.pageHeading.size,
              lineHeight: type.pageHeading.lineHeight,
              fontWeight: 700,
              margin: 0,
            }}
          >
            Page heading 1.6em bold
          </p>
          <p style={{ fontSize: type.detailHeading.size, fontWeight: 600, margin: 0 }}>
            Detail heading 1.05em semibold
          </p>
          <p style={{ margin: 0 }}>
            Body 15px, 16px from 1280px. Readable titles and plain help in Atkinson Hyperlegible
            Next.
          </p>
          <p style={{ margin: 0 }}>
            <span data-ansi="machine">
              machine 0.93em · build-042 · 4m12s · 1h04m07s · 0123456789
            </span>
          </p>
        </Specimen>
        <Specimen label="Space">
          <ul data-catalog="space">
            {Object.entries(space).map(([name, v]) => (
              <li key={name}>
                <span data-catalog="space-bar" style={{ width: v }} />
                <span data-ansi="machine">
                  {name} {v}
                </span>
              </li>
            ))}
          </ul>
        </Specimen>
      </div>
    </>
  )
}

function HostField() {
  const [error, setError] = useState(true)
  return (
    <div data-catalog="stack">
      <TextField
        label="Host"
        defaultValue="0.0.0.0"
        description="The address the server listens on."
        {...(error ? { error: 'Widening the bind exposes builds to the network.' } : {})}
      />
      <Button variant="ghost" onClick={() => setError((e) => !e)}>
        {error ? 'Clear the error' : 'Show the error'}
      </Button>
    </div>
  )
}

function Controls() {
  const [mode, setMode] = useState<'per-run' | 'total'>('per-run')
  return (
    <Grounds>
      <Specimen label="Buttons">
        <div data-catalog="row">
          <Button variant="primary">PAUSE</Button>
          <Button variant="secondary">Refresh</Button>
          <Button variant="ghost">ABORT</Button>
          <Button variant="danger">Abort build</Button>
          <Button variant="primary" disabled>
            RESUME
          </Button>
          <Button variant="secondary" onClick={() => new Promise((r) => setTimeout(r, 1500))}>
            Pending on click
          </Button>
        </div>
      </Specimen>
      <Specimen label="Word action">
        <p>
          Read the <WordAction href="#">build's ticket</WordAction> or open the{' '}
          <WordAction href="#">pull request</WordAction>.
        </p>
      </Specimen>
      <Specimen label="Field">
        <div data-catalog="row" data-align="start">
          <TextField
            label="Port"
            placeholder="any free port"
            description="Leave empty to let the OS choose."
          />
          <HostField />
        </div>
      </Specimen>
      <Specimen label="Choice">
        <Choice
          label="Measure"
          value={mode}
          onValueChange={setMode}
          options={[
            { value: 'per-run', label: 'Per run' },
            { value: 'total', label: 'Total' },
          ]}
        />
      </Specimen>
      <Specimen label="Menu and confirmation">
        <div data-catalog="row">
          <ThemeMenu value="system" onValueChange={() => {}} />
          <ConfirmDialog
            trigger="ABORT"
            title="Abort build-042?"
            description="The pull request closes, its branches are removed and the ticket returns to Triage. Nothing is written until you confirm."
            confirm="Abort build"
          />
        </div>
      </Specimen>
    </Grounds>
  )
}

function Display() {
  return (
    <Grounds>
      <Specimen label="State words">
        <div data-catalog="row">
          <StateWord tone="live">RUNNING</StateWord>
          <StateWord tone="ok">MERGED</StateWord>
          <StateWord tone="held">WAITING</StateWord>
          <StateWord tone="alert">BLOCKED</StateWord>
          <StateWord tone="pending">QUEUED</StateWord>
        </div>
      </Specimen>
      <Specimen label="Steps">
        <StepList
          steps={[
            { name: 'plan', state: 'done', note: n(384_000) },
            { name: 'plan-review', state: 'done', note: n(252_000) },
            { name: 'implement', state: 'provisional', note: n(1_812_000) },
            { name: 'code-review', state: 'current', note: n(38_000) },
            { name: 'verify', state: 'pending' },
            { name: 'finalize', state: 'pending' },
          ]}
        />
      </Specimen>
      <Specimen label="Steps with reserved note slots">
        <StepList
          steps={[
            { name: 'plan', state: 'done', note: n(9_000), noteSizer: SIZER },
            { name: 'implement', state: 'done', note: n(59_000), noteSizer: SIZER },
            { name: 'code-review', state: 'provisional', note: n(3_599_000), noteSizer: SIZER },
            {
              name: 'verify:unit',
              state: 'current',
              note: '(2/3, 1h00m00s/2)',
              noteSizer: '(2/3, 99h59m59s/2)',
            },
            { name: 'finalize', state: 'pending', noteSizer: SIZER },
          ]}
        />
      </Specimen>
      <Specimen label="Section heading and empty sentence">
        <SectionHeading title="Needs attention" count="0" />
        <EmptySentence>Nothing needs a person right now.</EmptySentence>
      </Specimen>
      <Specimen label="Facts">
        <FactList
          facts={[
            { term: 'status', value: <StateWord tone="ok">RUNNING</StateWord> },
            { term: 'phase', value: 'verify:unit', mono: true },
            { term: 'merge', value: 'merge auto' },
            { term: 'PR', value: <a href="#pr">PR open</a> },
          ]}
        />
      </Specimen>
      <Specimen label="Attention lines">
        <AttentionLine tone="held" identity="#1090" href="#build">
          waiting on #1084 and #1051 to merge
        </AttentionLine>
        <AttentionLine tone="alert">Janitor failing: worktree is locked</AttentionLine>
      </Specimen>
      <Specimen label="Sign-off regions">
        <div data-catalog="stack">
          <SignOff
            kind="escalation"
            question="Should the token budget apply per session or per build?"
          >
            <p>The build stopped to ask. A human answer resumes it from where it stopped.</p>
          </SignOff>
          <SignOff kind="consent" question="Merge #1042 when checks pass?" />
          <SignOff kind="wait" question="Waiting on #1038 and #1040 to merge." />
        </div>
      </Specimen>
      <Specimen label="Chart popover">
        <div data-catalog="popover-stage">
          <SegmentPopover
            presence="present"
            now={NOW}
            detail={{
              x: 150,
              y: 104,
              build: {
                slug: 'build-044',
                ticket: '#1044',
                title: 'Show waits on the build page',
                outcome: 'merged',
                segments: [],
              },
              segment: {
                category: 'code-review',
                start: NOW - 3_600_000,
                end: NOW - 3_253_000,
                round: 2,
              },
            }}
          />
        </div>
      </Specimen>
      <Specimen label="Loading">
        <Placeholder width="18ch" lines={3} />
      </Specimen>
    </Grounds>
  )
}

const rows: BuildRowModel[] = [
  {
    ticket: '#1068',
    title: 'Allowlist-backed local configuration overrides',
    slug: 'local-config-overrides',
    status: 'RUNNING',
    tone: 'live',
    href: '#build',
    meta: 'round 2',
    steps: [
      { name: 'plan', state: 'done', note: n(412_000) },
      { name: 'plan-review', state: 'done', note: n(198_000) },
      { name: 'implement', state: 'current', note: n(1_302_000) },
      { name: 'code-review', state: 'pending' },
      { name: 'verify', state: 'pending' },
    ],
  },
  {
    ticket: '#1051',
    title: 'Copy archive refs into the store when the forge refuses them',
    slug: 'archive-ref-store-copy',
    status: 'BLOCKED',
    tone: 'alert',
    href: '#build',
    steps: [
      { name: 'plan', state: 'done', note: n(388_000) },
      { name: 'implement', state: 'done', note: n(2_410_000) },
      { name: 'code-review', state: 'provisional', note: n(600_000) },
    ],
    attention: (
      <SignOff
        kind="escalation"
        question="The forge refuses refs/autobuild/archive pushes. Keep the copy in the store only?"
      />
    ),
  },
  {
    ticket: '#1049',
    title: 'Enter GitHub cooldown on exhausted responses',
    slug: 'github-cooldown-exhausted',
    status: 'MERGED',
    tone: 'ok',
    meta: 'PR #1061',
    steps: [
      { name: 'plan', state: 'done', note: n(301_000) },
      { name: 'implement', state: 'done', note: n(1_903_000) },
      { name: 'verify', state: 'done', note: n(742_000) },
      { name: 'finalize', state: 'done', note: n(64_000) },
    ],
  },
  {
    ticket: '#1093',
    title: 'Record forge rate limits per credential',
    slug: 'record-forge-rate-limits',
    status: 'SUSPENDED',
    tone: 'held',
    href: '#build',
    flags: [
      { term: 'held', tone: 'held' },
      { term: 'paused', tone: 'held' },
    ],
    meta: 'main +2 · merge off',
    lines: [
      {
        text: 'ab/record-forge-rate-limits · restack idle · verify pending · not ready to land',
        mono: true,
      },
      { text: 'review round ceiling: code 4', tone: 'pending' },
    ],
    steps: [
      { name: 'plan', state: 'done', note: n(240_000) },
      { name: 'implement', state: 'pending' },
    ],
    attention: <AttentionLine tone="alert">Janitor failing: worktree is locked</AttentionLine>,
  },
]

function Composites() {
  return (
    <Grounds stacked>
      <Masthead
        repository="github.com/defrex/autobuild"
        aside={<ThemeMenu value="system" onValueChange={() => {}} />}
      />
      <PageNav
        current="#overview"
        items={[
          { href: '#overview', label: 'Overview', count: '3/4' },
          { href: '#analytics', label: 'Analytics' },
        ]}
        controls={<StateWord tone="held">INTAKE OFF</StateWord>}
      />
      <DispatcherStrip
        model={{
          mode: { word: 'running', tone: 'ok' },
          counts: [
            { label: 'triage', value: '4' },
            { label: 'queue', value: '5' },
            { label: 'active', value: '3/4' },
          ],
          capacityNote: '(limit lowered from 6 while a handoff drains)',
          gates: [
            { label: 'intake', word: 'ON', tone: 'ok' },
            { label: 'harvest', word: 'OFF', tone: 'held' },
          ],
        }}
      />
      {rows.map((r) => (
        <BuildRow key={r.slug} build={r} />
      ))}
    </Grounds>
  )
}

const cycle: Pick<BuildRowModel, 'status' | 'tone' | 'steps' | 'attention'>[] = [
  {
    status: 'RUNNING',
    tone: 'live',
    steps: [
      { name: 'plan', state: 'done', note: n(412_000) },
      { name: 'implement', state: 'current', note: n(1_302_000) },
      { name: 'code-review', state: 'pending' },
      { name: 'verify', state: 'pending' },
    ],
  },
  {
    status: 'BLOCKED',
    tone: 'alert',
    steps: [
      { name: 'plan', state: 'done', note: n(412_000) },
      { name: 'implement', state: 'provisional', note: n(1_840_000) },
      { name: 'code-review', state: 'pending' },
      { name: 'verify', state: 'pending' },
    ],
    attention: <SignOff kind="escalation" question="Keep the old flag name as an alias?" />,
  },
  {
    status: 'MERGED',
    tone: 'ok',
    steps: [
      { name: 'plan', state: 'done', note: n(412_000) },
      { name: 'implement', state: 'done', note: n(2_210_000) },
      { name: 'code-review', state: 'done', note: n(540_000) },
      { name: 'verify', state: 'done', note: n(760_000) },
    ],
  },
]

const flowSteps = (note: string): BuildRowModel['steps'] => [
  { name: 'plan', state: 'done', note: n(412_000), noteSizer: SIZER },
  { name: 'implement', state: 'current', note, noteSizer: SIZER },
  { name: 'code-review', state: 'pending', noteSizer: SIZER },
]

const flowRow = (slug: string, title: string, ticket: string): BuildRowModel => ({
  ticket,
  title,
  slug,
  status: 'RUNNING',
  tone: 'ok',
  href: '#build',
  steps: flowSteps(n(1_200_000)),
})

/**
 * A live page flow that changes on its own every 3 s, with no input to excuse
 * a shift: a timer crossing 59m59s → 1h00m00s (in place), a row gaining a
 * multi-sentence escalation, and a row moving to another list (transactions).
 * Under `?cls=1` the title must stay `CLS 0.0000`.
 */
function LiveFlow() {
  const [tick, setTick] = useState(0)
  useEffect(() => {
    const timer = setInterval(() => setTick((t) => t + 1), 3000)
    return () => clearInterval(timer)
  }, [])
  const phase = tick % 4
  const first: BuildRowModel = {
    ...flowRow('stable-flow-timer', 'Keep a ticking step in its reserved slot', '#2001'),
    steps: flowSteps(phase === 0 ? n(3_599_000) : n(3_600_000)),
    ...(phase === 2
      ? {
          status: 'BLOCKED',
          tone: 'alert' as const,
          attention: (
            <SignOff
              kind="escalation"
              question="The unit suite fails because the fixture clock is a day ahead. Should the fixture move, or should the test pin its own clock? Either answer resumes the build."
            />
          ),
        }
      : {}),
  }
  const second = flowRow('stable-flow-steady', 'A row that never changes', '#2002')
  const mover = flowRow('stable-flow-mover', 'A row that moves between lists', '#2003')
  const moved = phase === 3
  const blocks: FlowBlock[] = [
    { key: 'h:active', node: <SectionHeading title="Active" /> },
    { key: `row:${first.slug}`, node: <BuildRow build={first} /> },
    { key: `row:${second.slug}`, node: <BuildRow build={second} /> },
    ...(moved ? [{ key: `row:${mover.slug}`, node: <BuildRow build={mover} /> }] : []),
    { key: 'h:queued', node: <SectionHeading title="Queued" /> },
    ...(moved
      ? [{ key: 'empty:queued', node: <EmptySentence>No builds are queued.</EmptySentence> }]
      : [
          {
            key: `row:${mover.slug}`,
            node: <BuildRow build={{ ...mover, status: 'QUEUED', tone: 'live' }} />,
          },
        ]),
  ]
  return <StableFlow blocks={blocks} seq={tick} />
}

function States() {
  const [ready, setReady] = useState(false)
  const [step, setStep] = useState(0)
  const few = useMemo(() => fixtureBuilds(6, 3), [])
  const stats = useMemo(() => fixtureStepStats(fixtureBuilds(40, 5)), [])
  useEffect(() => {
    const t = setTimeout(() => setReady(true), 1200)
    return () => clearTimeout(t)
  }, [])
  const current = cycle[step % cycle.length] ?? cycle[0]
  return (
    <>
      <div data-catalog="toolbar" data-catalog-row="">
        <Button variant="secondary" onClick={() => setReady((r) => !r)}>
          {ready ? 'Show loading' : 'Show loaded'}
        </Button>
        <Button variant="secondary" onClick={() => setStep((n) => n + 1)}>
          Advance the build
        </Button>
      </div>
      <Grounds stacked>
        <Reserve
          ready={ready}
          placeholder={
            <Masked>
              <BuildRow
                build={{
                  ticket: '#1072',
                  title: 'Rename the integration node kind',
                  slug: 'rename-node-kind',
                  ...(current as (typeof cycle)[number]),
                }}
              />
              <BuildRow build={rows[2] as BuildRowModel} />
            </Masked>
          }
        >
          <BuildRow
            build={{
              ticket: '#1072',
              title: 'Rename the integration node kind',
              slug: 'rename-node-kind',
              ...(current as (typeof cycle)[number]),
            }}
          />
          <BuildRow build={rows[2] as BuildRowModel} />
        </Reserve>
      </Grounds>
      <Grounds>
        <Specimen label="Masked row and its live twin">
          <Masked>
            <BuildRow build={rows[1] as BuildRowModel} />
          </Masked>
          <BuildRow build={rows[1] as BuildRowModel} />
        </Specimen>
      </Grounds>
      <Grounds stacked>
        <Reserve ready={ready} placeholder={<GanttSkeleton rows={few.length} />}>
          <Gantt builds={few} now={NOW} axis="clock" label="Builds" />
        </Reserve>
      </Grounds>
      <Grounds stacked>
        <Reserve ready={ready} placeholder={<StepDurationsSkeleton rows={stats.length} />}>
          <StepDurations steps={stats} mode="per-run" caption="Time per run, last 7 days" />
        </Reserve>
      </Grounds>
    </>
  )
}

function Charts() {
  const few = useMemo(() => fixtureBuilds(8), [])
  const many = useMemo(() => fixtureBuilds(80, 11), [])
  const stats = useMemo(() => fixtureStepStats(many), [many])
  const [axis, setAxis] = useState<GanttAxis>('clock')
  const [mode, setMode] = useState<DurationMode>('per-run')
  const axisChoice = (
    <Choice
      label="Time axis"
      value={axis}
      onValueChange={setAxis}
      options={[
        { value: 'clock', label: 'Clock' },
        { value: 'relative', label: 'From start' },
      ]}
    />
  )
  return (
    <>
      <div data-catalog="toolbar">{axisChoice}</div>
      <Grounds stacked>
        <h3>Eight builds, two still running</h3>
        <Gantt
          builds={few}
          now={NOW}
          axis={axis}
          label="Recent builds"
          defaultExpanded={few[3] ? [few[3].slug] : []}
        />
      </Grounds>
      <Grounds stacked>
        <h3>Eighty builds over six days</h3>
        <Gantt builds={many.slice(0, 25)} now={NOW} axis={axis} label="Builds, page 1 of 4" />
      </Grounds>
      <Grounds stacked>
        <h3>A sparse page holds a full page's height</h3>
        <Gantt
          builds={few.slice(0, 3)}
          now={NOW}
          axis={axis}
          label="Builds, page 4"
          reserveRows={8}
        />
      </Grounds>
      <Grounds stacked>
        <h3>No build matches</h3>
        <Gantt
          builds={[]}
          now={NOW}
          axis={axis}
          label="Builds, page 1"
          reserveRows={4}
          empty={
            <EmptySentence>
              No build matching these filters was active in this window.
            </EmptySentence>
          }
        />
      </Grounds>
      <div data-catalog="toolbar">
        <Choice
          label="Measure"
          value={mode}
          onValueChange={setMode}
          options={[
            { value: 'per-run', label: 'Per run' },
            { value: 'total', label: 'Total time' },
          ]}
        />
      </div>
      <Grounds stacked>
        <StepDurations
          steps={stats}
          mode={mode}
          caption={
            mode === 'per-run'
              ? 'Time per run, last 7 days, merged builds'
              : 'Where the time went, last 7 days'
          }
        />
      </Grounds>
    </>
  )
}

function Catalog() {
  const [theme, setTheme] = useState<ThemeChoice>(
    (new URLSearchParams(location.search).get('theme') as ThemeChoice | null) ?? 'system',
  )
  useEffect(() => {
    if (theme === 'system') delete document.documentElement.dataset.theme
    else document.documentElement.dataset.theme = theme
  }, [theme])
  return (
    <main data-catalog="page">
      <header data-catalog="head">
        <div>
          <h1>Autobuild ANSI</h1>
          <p>
            The design system for the dispatcher web UI. Tokens are typed source in{' '}
            <code>packages/ui/src/tokens.ts</code>; every value on this page comes from there.
          </p>
        </div>
        <ThemeMenu value={theme} onValueChange={setTheme} />
      </header>
      <nav data-catalog="toc" aria-label="Catalog sections">
        {['tokens', 'controls', 'display', 'composites', 'states', 'charts', 'flow'].map((id) => (
          <a key={id} href={`#${id}`}>
            {id}
          </a>
        ))}
      </nav>
      <Section
        id="tokens"
        title="Tokens"
        intro="Two first-class grounds. State inks carry meaning; chart hues carry identity and appear only inside charts, beside a legend."
      >
        <Tokens />
      </Section>
      <Section
        id="controls"
        title="Controls"
        intro="Square, outlined, semibold. One primary action per page; destructive actions are ghosted until the confirmation dialog."
      >
        <Controls />
      </Section>
      <Section
        id="display"
        title="Display"
        intro="State words and step marks always travel with their color. Sign-off regions are reserved for human decisions."
      >
        <Display />
      </Section>
      <Section
        id="composites"
        title="Composites"
        intro="The overview page's parts: masthead, page navigation, the dispatcher strip and title-led build rows."
      >
        <Composites />
      </Section>
      <Section
        id="states"
        title="States"
        intro="Nothing moves when data arrives or a state changes. Loading reserves the exact space with a skeleton and crossfades; state changes transition in place."
      >
        <States />
      </Section>
      <Section
        id="charts"
        title="Charts"
        intro="Where the time goes. Work phases use the chart hues, review rounds are hatched, and waits use the state inks they already mean."
      >
        <Charts />
      </Section>
      {/* Last on the page: a flow that grows only extends the document. */}
      <Section
        id="flow"
        title="Live flow"
        intro="A page changing on its own every 3 s: a timer crossing an hour in its reserved slot, a row gaining an escalation, a row moving between lists. Blocks above a change never move; the changed region fades out, relayouts while invisible and fades back in. Under ?cls=1 the title stays CLS 0."
      >
        <Grounds paired>
          <LiveFlow />
        </Grounds>
      </Section>
    </main>
  )
}

installClsProbe()

const root = document.getElementById('root')
if (root)
  createRoot(root).render(
    <StrictMode>
      <Catalog />
    </StrictMode>,
  )
