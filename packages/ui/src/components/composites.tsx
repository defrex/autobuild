import type { ReactNode } from 'react'
import { Placeholder, type Step, type StateTone, StateWord, StepList } from './display'

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

export interface DispatcherFacts {
  mode: 'running' | 'viewer' | 'stopped' | 'handoff'
  host: string
  version: string
  active: number
  capacity: number
  queued: number
  intake: boolean
  lastTick: string
}

const modeTone: Record<DispatcherFacts['mode'], StateTone> = {
  running: 'ok',
  viewer: 'live',
  stopped: 'alert',
  handoff: 'held',
}

export function DispatcherStrip({ facts }: { facts: DispatcherFacts }) {
  return (
    <dl data-ansi="dispatcher-strip">
      <div>
        <dt>Dispatcher</dt>
        <dd>
          <StateWord tone={modeTone[facts.mode]}>{facts.mode.toUpperCase()}</StateWord>
        </dd>
      </div>
      <div>
        <dt>Host</dt>
        <dd data-ansi="machine">{facts.host}</dd>
      </div>
      <div>
        <dt>Runtime</dt>
        <dd data-ansi="machine">{facts.version}</dd>
      </div>
      <div>
        <dt>Active</dt>
        <dd data-ansi="machine">
          {facts.active}/{facts.capacity}
        </dd>
      </div>
      <div>
        <dt>Queued</dt>
        <dd data-ansi="machine">{facts.queued}</dd>
      </div>
      <div>
        <dt>Intake</dt>
        <dd>{facts.intake ? 'on' : <StateWord tone="held">OFF</StateWord>}</dd>
      </div>
      <div>
        <dt>Last tick</dt>
        <dd data-ansi="machine">{facts.lastTick}</dd>
      </div>
    </dl>
  )
}

export interface BuildRowModel {
  ticket: string
  title: string
  slug: string
  status: string
  tone: StateTone
  meta?: string
  steps: Step[]
  attention?: ReactNode
}

export function BuildRow({ build }: { build: BuildRowModel }) {
  return (
    <article data-ansi="build-row" data-tone={build.tone}>
      <span data-ansi="ticket-id">{build.ticket}</span>
      <div data-ansi="row-body">
        <div data-ansi="row-head">
          <a data-ansi="row-title" href={`#build/${build.slug}`}>
            {build.title}
          </a>
          <span data-ansi="state-slot">
            <StateWord tone={build.tone}>{build.status}</StateWord>
          </span>
        </div>
        <p data-ansi="row-meta">
          <span data-ansi="machine">{build.slug}</span>
          {build.meta !== undefined && <span> · {build.meta}</span>}
        </p>
        <StepList steps={build.steps} />
        {build.attention}
      </div>
    </article>
  )
}

/** A build row's exact geometry with no facts in it: identity column, title
 * and status line, meta line, steps line. Each bar sits in a full line box,
 * so the loaded row occupies the same space. */
export function BuildRowSkeleton() {
  return (
    <div data-ansi="build-row" data-skeleton="">
      <Placeholder width="5ch" mono />
      <div data-ansi="row-body">
        <div data-ansi="row-head">
          <Placeholder width="min(38ch, 70%)" />
          <span data-ansi="state-slot">
            <Placeholder width="7ch" mono />
          </span>
        </div>
        <Placeholder width="24ch" mono />
        <Placeholder width="min(52ch, 90%)" mono />
      </div>
    </div>
  )
}
