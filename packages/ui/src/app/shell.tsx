import { useEffect, useMemo, useState } from 'react'
import type { WebBuildTimeline, WebFrame } from '../../../core/src/web/protocol'
import { Masthead, PageNav } from '../components/composites'
import { StateWord, type ThemeChoice, ThemeMenu } from '../components/display'
import { Masked, Reserve } from '../components/motion'
import { motion } from '../tokens'
import { AnalyticsPage } from './analytics'
import { timelineLive } from './analytics-model'
import { BuildPage, buildPageFetch, type TimelineState } from './build-page'
import { useClock } from './clock'
import { fallbackFrame } from './fallback'
import { useApi } from './fetch'
import { OverviewPage, type PageProps } from './overview'
import { ANALYTICS_PATH, type Route, route } from './routes'

/* Literal of THEME_STORAGE_KEY in packages/core/src/web/protocol.ts; the
   bundle imports core only as types. */
const THEME_KEY = 'ab-theme'

function storedTheme(): ThemeChoice {
  try {
    const value = localStorage.getItem(THEME_KEY)
    return value === 'light' || value === 'dark' ? value : 'system'
  } catch {
    return 'system'
  }
}

function useTheme(): [ThemeChoice, (choice: ThemeChoice) => void] {
  const [theme, setTheme] = useState<ThemeChoice>(storedTheme)
  useEffect(() => {
    const root = document.documentElement
    try {
      if (theme === 'system') localStorage.removeItem(THEME_KEY)
      else localStorage.setItem(THEME_KEY, theme)
    } catch {
      // Storage can be unavailable; the choice lasts for this page.
    }
    if (theme === 'system') delete root.dataset.theme
    else root.dataset.theme = theme
  }, [theme])
  return [theme, setTheme]
}

/** The displayed frame has a step whose timer is running. */
function ticking(frame: WebFrame | undefined): boolean {
  const overview = frame?.overview
  if (overview === undefined) return false
  const running = (steps: readonly { timing?: { runningSince?: number } }[]) =>
    steps.some((step) => step.timing?.runningSince !== undefined)
  return (
    [...overview.active, ...overview.queued].some((row) => running(row.steps)) ||
    (overview.harvest !== undefined && running(overview.harvest.steps))
  )
}

const PLACEHOLDER_MS = Number.parseFloat(motion.layout)

type FramePage = Extract<Route, { page: 'overview' | 'build' }>

function Page({
  route: r,
  timeline,
  ...props
}: PageProps & { route: FramePage; timeline: TimelineState }) {
  return r.page === 'build' ? (
    <BuildPage slug={r.slug} timeline={timeline} {...props} />
  ) : (
    <OverviewPage {...props} />
  )
}

/**
 * The page loads into its own masked twin: the route's real page, rendered
 * from the server's layout hint (or a fixed fallback) with every fact barred.
 * The first live frame reshapes the masked page first; once it has settled on
 * that frame, the live page mounts with the same frame in the same grid cell
 * and the two crossfade, so the content never takes space the skeleton did
 * not already hold. Later frames go to the live page's own flow.
 */
function Main({
  route: r,
  hint,
  frame,
  seq,
}: {
  route: FramePage
  hint: WebFrame | undefined
  frame: WebFrame | undefined
  seq: number
}) {
  const [settled, setSettled] = useState<{ frame: WebFrame; seq: number } | undefined>(undefined)
  const [placeholderMounted, setPlaceholderMounted] = useState(true)
  const fallback = useMemo(() => fallbackFrame(r), [r])
  // One timeline read for the page and its masked twin, so loading never
  // fetches twice.
  const read = r.page === 'build' ? buildPageFetch(frame, r.slug) : undefined
  const timeline = useApi<WebBuildTimeline>(read?.url, read?.key)
  const row = timeline.data?.row
  const now = useClock(ticking(frame ?? hint) || (row !== undefined && timelineLive(row)))
  const ready = settled !== undefined
  useEffect(() => {
    if (!ready) return
    const timer = setTimeout(() => setPlaceholderMounted(false), PLACEHOLDER_MS)
    return () => clearTimeout(timer)
  }, [ready])
  const masked =
    settled ?? (frame !== undefined ? { frame, seq } : { frame: hint ?? fallback, seq: 0 })
  return (
    <Reserve
      ready={ready}
      placeholder={
        placeholderMounted && (
          <Masked>
            <Page
              route={r}
              frame={masked.frame}
              seq={masked.seq}
              now={now}
              timeline={timeline}
              onSettled={(s) => {
                if (frame !== undefined && s === seq && settled === undefined)
                  setSettled({ frame, seq })
              }}
            />
          </Masked>
        )
      }
    >
      {ready && frame !== undefined && (
        <Page route={r} frame={frame} seq={seq} now={now} timeline={timeline} />
      )}
    </Reserve>
  )
}

/** The nav item a route sits under: a build page under the Overview that
 * lists it. */
export function navCurrent(r: Route, path: string): string {
  if (r.page === 'analytics') return ANALYTICS_PATH
  return r.page === 'unknown' ? path : '/'
}

export function AppShell({
  repository,
  hint,
  frame,
  seq,
  path,
}: {
  repository: string
  hint: WebFrame | undefined
  frame: WebFrame | undefined
  seq: number
  path: string
}) {
  const [theme, setTheme] = useTheme()
  const r = useMemo(() => route(path), [path])
  const header = frame?.repository
  return (
    <div data-app="frame">
      <Masthead
        repository={repository}
        aside={<ThemeMenu value={theme} onValueChange={setTheme} />}
      />
      <PageNav
        items={[
          { href: '/', label: 'Overview' },
          { href: ANALYTICS_PATH, label: 'Analytics' },
        ]}
        current={navCurrent(r, path)}
        controls={
          header !== undefined && (header.repositoryPaused || header.drained) ? (
            <>
              {header.repositoryPaused && <StateWord tone="held">PAUSED</StateWord>}
              {header.drained && <StateWord tone="held">INTAKE OFF</StateWord>}
            </>
          ) : undefined
        }
      />
      <main data-app="main">
        {r.page === 'unknown' ? (
          <p data-ansi="slack">
            No page at this address. The Overview at / lists this repository's builds.
          </p>
        ) : r.page === 'analytics' ? (
          <AnalyticsPage position={frame?.position} />
        ) : (
          <Main route={r} hint={hint} frame={frame} seq={seq} />
        )}
      </main>
    </div>
  )
}
