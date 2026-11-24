import { useEffect, useState } from 'react'
import type { WebFrame } from '../../../core/src/web/protocol'
import { BuildRowSkeleton, Masthead, PageNav } from '../components/composites'
import { StateWord, type ThemeChoice, ThemeMenu } from '../components/display'
import { Reserve } from '../components/motion'

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

const ROUTES = ['/'] as const

function Summary({ frame }: { frame: WebFrame }) {
  const repository = frame.repository
  return (
    <div data-app="summary">
      {frame.notice !== undefined && <p data-ansi="slack">{frame.notice}</p>}
      {repository !== undefined && (
        <p>
          Queued <span data-ansi="num">{repository.queued}</span> · Triage{' '}
          <span data-ansi="num">{repository.triage ?? '–'}</span>
        </p>
      )}
      {repository?.warningLines?.map((line) => (
        <p key={line}>{line}</p>
      ))}
    </div>
  )
}

export function AppShell({
  repository,
  frame,
  path,
}: {
  repository: string
  frame: WebFrame | undefined
  path: string
}) {
  const [theme, setTheme] = useTheme()
  const known = (ROUTES as readonly string[]).includes(path)
  const header = frame?.repository
  return (
    <div data-app="frame">
      <Masthead
        repository={repository}
        aside={<ThemeMenu value={theme} onValueChange={setTheme} />}
      />
      <PageNav
        items={[{ href: '/', label: 'Overview' }]}
        current={path}
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
        {known ? (
          <Reserve
            ready={frame !== undefined}
            placeholder={
              <>
                <BuildRowSkeleton />
                <BuildRowSkeleton />
                <BuildRowSkeleton />
              </>
            }
          >
            {frame !== undefined && <Summary frame={frame} />}
          </Reserve>
        ) : (
          <p data-ansi="slack">
            No page at this address. The Overview lists this repository's builds.
          </p>
        )}
      </main>
    </div>
  )
}
