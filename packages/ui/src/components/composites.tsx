import type { ReactNode } from 'react'
import { type Step, type StateTone, StateWord, StepList } from './display'

export function Masthead({ repository, aside }: { repository: string; aside?: ReactNode }) {
  return (
    <header data-ansi="masthead">
      <span data-ansi="brand">Autobuild</span>
      <span data-ansi="repository">{repository}</span>
      <span data-ansi="masthead-aside">{aside}</span>
    </header>
  )
}

export interface NavItem {
  href: string
  label: string
  count?: string
}

/** Page navigation: links, so each view keeps its own URL. */
export function PageNav({
  items,
  current,
  controls,
}: {
  items: readonly NavItem[]
  current: string
  controls?: ReactNode
}) {
  return (
    <nav data-ansi="page-nav" aria-label="Views">
      <ul>
        {items.map((item) => (
          <li key={item.href}>
            <a href={item.href} aria-current={item.href === current ? 'page' : undefined}>
              {item.label}
              {item.count !== undefined && <span data-ansi="count"> {item.count}</span>}
            </a>
          </li>
        ))}
      </ul>
      {controls !== undefined && <div data-ansi="nav-controls">{controls}</div>}
    </nav>
  )
}

/** The dispatcher strip's terms, shaped as the shared projection gives them
 * (typed structurally, so this package never imports core). */
export interface DispatcherStripModel {
  mode: { word: string; tone: StateTone; detail?: string }
  counts: readonly { label: string; value: string }[]
  capacityNote?: string
  gates: readonly { label: string; word: string; tone: StateTone }[]
}

/** The dispatcher's mode, capacity and repository gates on one ruled line. */
export function DispatcherStrip({ model }: { model: DispatcherStripModel }) {
  return (
    <dl data-ansi="dispatcher-strip">
      <div>
        <dt>
          <span>Dispatcher</span>
        </dt>
        <dd>
          <span data-ansi="state-slot" data-flow-slot="">
            <StateWord tone={model.mode.tone}>{model.mode.word}</StateWord>
          </span>
          {model.mode.detail !== undefined && <span data-ansi="slack"> {model.mode.detail}</span>}
        </dd>
      </div>
      {model.counts.map((count, index) => (
        <div key={count.label}>
          <dt>
            <span>{count.label}</span>
          </dt>
          <dd>
            <span data-ansi="count-slot" data-flow-slot="">
              <span data-ansi="machine">{count.value}</span>
            </span>
            {/* The capacity note explains the last count, the active limit. */}
            {index === model.counts.length - 1 && model.capacityNote !== undefined && (
              <span data-ansi="slack"> {model.capacityNote}</span>
            )}
          </dd>
        </div>
      ))}
      {model.gates.map((gate) => (
        <div key={gate.label}>
          <dt>
            <span>{gate.label}</span>
          </dt>
          <dd>
            <StateWord tone={gate.tone}>{gate.word}</StateWord>
          </dd>
        </div>
      ))}
    </dl>
  )
}

/** A secondary row line: progress counts, tree lines, the ceiling, a notice. */
export interface RowLine {
  text: ReactNode
  tone?: StateTone
  mono?: boolean
}

export interface BuildRowModel {
  ticket?: string
  title: string
  slug: string
  status: string
  tone: StateTone
  /** The build's page; the title links there only when present. */
  href?: string
  /** Parenthesised annotations beside the status, such as `(paused)`. */
  flags?: readonly { term: string; tone: StateTone }[]
  meta?: ReactNode
  lines?: readonly RowLine[]
  steps: Step[]
  attention?: ReactNode
}

/** A title-led build row. Every text run sits in an inline element, so a
 * masked row bars each run across its own line boxes. */
export function BuildRow({ build }: { build: BuildRowModel }) {
  return (
    <article data-ansi="build-row" data-tone={build.tone}>
      <span data-ansi="ticket-id">
        <span>{build.ticket ?? ''}</span>
      </span>
      <div data-ansi="row-body">
        <div data-ansi="row-head">
          {build.href !== undefined ? (
            <a data-ansi="row-title" href={build.href}>
              <span>{build.title}</span>
            </a>
          ) : (
            <span data-ansi="row-title">
              <span>{build.title}</span>
            </span>
          )}
          {build.flags !== undefined && build.flags.length > 0 && (
            <span data-ansi="row-flags">
              {build.flags.map((flag) => (
                <span key={flag.term} data-ansi="row-flag" data-tone={flag.tone}>
                  ({flag.term})
                </span>
              ))}
            </span>
          )}
          <span data-ansi="state-slot" data-flow-slot="">
            <StateWord tone={build.tone}>{build.status}</StateWord>
          </span>
        </div>
        <p data-ansi="row-meta">
          <span data-ansi="machine">{build.slug}</span>
          {build.meta !== undefined && <span data-ansi="row-meta-facts"> · {build.meta}</span>}
        </p>
        {build.lines?.map((line, index) => (
          <p
            // biome-ignore lint/suspicious/noArrayIndexKey: lines keep projection order
            key={index}
            data-ansi="row-line"
            data-tone={line.tone}
          >
            <span data-ansi={line.mono ? 'machine' : undefined}>{line.text}</span>
          </p>
        ))}
        {build.steps.length > 0 && <StepList steps={build.steps} />}
        {build.attention}
      </div>
    </article>
  )
}

/** A page section's heading, with an optional count in a reserved slot. */
export function SectionHeading({ title, count }: { title: string; count?: string }) {
  return (
    <h2 data-ansi="section-heading">
      <span>{title}</span>
      {count !== undefined && (
        <span data-ansi="count-slot" data-flow-slot="">
          <span data-ansi="num">{count}</span>
        </span>
      )}
    </h2>
  )
}

/** What an empty section would hold, said plainly. */
export function EmptySentence({ children }: { children: ReactNode }) {
  return (
    <p data-ansi="empty-sentence">
      <span>{children}</span>
    </p>
  )
}

/** Term and value pairs, in the dispatcher strip's term style. */
export function FactList({
  facts,
}: {
  facts: readonly { term: string; value: ReactNode; mono?: boolean }[]
}) {
  return (
    <dl data-ansi="fact-list">
      {facts.map((fact) => (
        <div key={fact.term}>
          <dt>
            <span>{fact.term}</span>
          </dt>
          <dd>
            <span data-ansi={fact.mono ? 'machine' : undefined}>{fact.value}</span>
          </dd>
        </div>
      ))}
    </dl>
  )
}

/** One toned attention line that is not a human decision: a wait, an alert,
 * a setup error. An identity, when present, leads as a blue mono link. */
export function AttentionLine({
  tone,
  identity,
  href,
  children,
}: {
  tone: StateTone
  identity?: string
  href?: string
  children: ReactNode
}) {
  return (
    <p data-ansi="attention-line" data-tone={tone}>
      {identity !== undefined &&
        (href !== undefined ? (
          <a data-ansi="ticket-id" href={href}>
            {identity}
          </a>
        ) : (
          <span data-ansi="ticket-id">{identity}</span>
        ))}
      <span data-ansi="attention-text">{children}</span>
    </p>
  )
}
