/**
 * Pure dispatcher helpers: spec conformance, dependency analysis, slug
 * normalization, the repository-pause predicate, default ticket states and
 * ready criteria.
 * In memory, no store or adapter involved.
 */
import { describe, expect, test } from 'bun:test'
import { parseConfig } from '../config/load'
import type { BuildState } from '../kernel/reducer'
import type { DependencyState } from '../ports/types'
import {
  analyzeDependencies,
  defaultProposalState,
  defaultTriageState,
  fallbackSlug,
  heldByRepositoryPause,
  kebab,
  markRejected,
  readyCriteria,
  specConformance,
  validateSlugCandidate,
  type DependencyVerdict,
} from './dispatcher'

/** Conforming per the spec standard's checkable core (docs/spec-standard.md). */
const CONFORMING_BODY = [
  'Login attempts are currently unlimited; throttle repeated failures.',
  '',
  '## Acceptance criteria',
  '',
  '- a sixth failed login within five minutes returns 429',
  '',
  '## Out of scope',
  '',
  '- captcha',
  '',
].join('\n')

describe('specConformance', () => {
  test('conforming body passes', () => {
    expect(specConformance(CONFORMING_BODY)).toEqual({ conforms: true, missing: [] })
  })

  test('empty body reports every missing part', () => {
    expect(specConformance('')).toEqual({
      conforms: false,
      missing: [
        'a nonempty spec body',
        "an '## Acceptance criteria' heading",
        "an '## Out of scope' heading",
      ],
    })
  })

  test('acceptance criteria heading without a list item is nonconforming', () => {
    const body = 'Why.\n\n## Acceptance criteria\n\nnone yet\n\n## Out of scope\n'
    expect(specConformance(body)).toEqual({
      conforms: false,
      missing: ["at least one list item under '## Acceptance criteria'"],
    })
  })

  test('headings match case-insensitively and at deeper levels', () => {
    const body = 'Why.\n\n### ACCEPTANCE CRITERIA\n- one\n\n### Out Of Scope — explicit\n'
    expect(specConformance(body)).toEqual({ conforms: true, missing: [] })
  })

  test('h1 headings conform (AUT-12)', () => {
    const body = 'Why.\n\n# Acceptance criteria\n- one\n\n# Out of scope\n'
    expect(specConformance(body)).toEqual({ conforms: true, missing: [] })
  })

  test('mixed heading levels conform', () => {
    const body = 'Why.\n\n# Acceptance criteria\n- one\n\n### Out of scope\n'
    expect(specConformance(body)).toEqual({ conforms: true, missing: [] })
  })

  test('an h1 section spans an h2 subheading; a later h1 still ends it', () => {
    const body = 'Why.\n\n# Acceptance criteria\n- one\n\n## Details\n\nprose\n\n# Out of scope\n'
    expect(specConformance(body)).toEqual({ conforms: true, missing: [] })
  })

  test('a list item under a subsection of the acceptance criteria counts (AUT-15)', () => {
    const body = 'Why.\n\n# Acceptance criteria\n\n## Details\n- one\n\n# Out of scope\n'
    expect(specConformance(body)).toEqual({ conforms: true, missing: [] })
  })

  test('criteria grouped under h3 subsections of an h2 section count (AUT-15 shape)', () => {
    const body =
      'Why.\n\n## Acceptance criteria\n\n### Legend & selection\n\n1. one\n2. two\n\n### Drain\n\n3. three\n\n## Out of scope\n'
    expect(specConformance(body)).toEqual({ conforms: true, missing: [] })
  })

  test('a list item under a sibling section does not count for acceptance criteria', () => {
    const body =
      'Why.\n\n## Acceptance criteria\n\nnone yet\n\n## Details\n- one\n\n## Out of scope\n'
    expect(specConformance(body)).toEqual({
      conforms: false,
      missing: ["at least one list item under '## Acceptance criteria'"],
    })
  })

  test('h1 heading with no list item under it is nonconforming', () => {
    const body = 'Why.\n\n# Acceptance criteria\n\nnone yet\n\n# Out of scope\n'
    expect(specConformance(body)).toEqual({
      conforms: false,
      missing: ["at least one list item under '## Acceptance criteria'"],
    })
  })

  test('h1 body missing the out-of-scope section still bounces accurately', () => {
    const body = 'Why.\n\n# Acceptance criteria\n- one\n'
    expect(specConformance(body)).toEqual({
      conforms: false,
      missing: ["an '## Out of scope' heading"],
    })
  })
})

describe('analyzeDependencies', () => {
  /**
   * `graph` reads as `id: [blockers]`; `done` lists the resolved ids and
   * `missing` the ids that exist nowhere. Pure input — no adapter involved.
   *
   * Only BLOCKERS become nodes: `nodes` models what the source returned, and
   * the source is never asked about the ticket being analyzed. Its own
   * blockers reach the analyzer as an argument (see `analyze`), which is what
   * keeps a fabricated self-node out of the tick-wide cache (f_8bc9ee0c).
   */
  function nodes(
    graph: Record<string, string[]>,
    opts: { done?: string[]; missing?: string[]; ticket?: string } = {},
  ): Map<string, DependencyState> {
    const map = new Map<string, DependencyState>()
    for (const [id, blockedBy] of Object.entries(graph)) {
      if (id === (opts.ticket ?? 'A')) continue // never fetched
      if (opts.missing?.includes(id)) {
        map.set(id, { id, exists: false, resolved: false, blockedBy: [] })
        continue
      }
      map.set(id, {
        id,
        exists: true,
        resolved: opts.done?.includes(id) ?? false,
        blockedBy,
      })
    }
    return map
  }

  /** Analyze ticket `id` against `graph`, taking its declared blockers from
   * the graph entry — mirroring the dispatcher, which passes the ticket's own
   * `blockedBy` rather than looking it up in the fetched nodes. */
  function analyze(
    id: string,
    graph: Record<string, string[]>,
    opts: { done?: string[]; missing?: string[] } = {},
  ): DependencyVerdict {
    return analyzeDependencies(id, graph[id] ?? [], nodes(graph, { ...opts, ticket: id }))
  }

  test('a rejected blocker is unresolved and named, without a cycle walk', () => {
    const graph = nodes({ A: ['B'], B: ['A'] })
    const blocker = graph.get('B')!
    graph.set('B', markRejected({ ...blocker, resolved: true, state: 'Rejected' }, 'rejected'))
    expect(analyzeDependencies('A', ['B'], graph)).toEqual({
      unresolved: ['B'],
      diagnostics: ['ticket A blocked by B, which was rejected'],
    })
    // An unset role, a different state, or a missing ticket is left alone.
    const plain = { id: 'B', exists: true, resolved: true, state: 'Rejected', blockedBy: [] }
    expect(markRejected(plain)).toBe(plain)
    expect(markRejected(plain, 'icebox')).toBe(plain)
    const missing = { id: 'B', exists: false, resolved: false, blockedBy: [] }
    expect(markRejected(missing, 'rejected')).toBe(missing)
  })

  test('no blockers: eligible, nothing to say', () => {
    expect(analyze('A', { A: [] })).toEqual({ unresolved: [], diagnostics: [] })
  })

  test('a ticket with no declared blockers never consults the graph', () => {
    expect(analyzeDependencies('A', [], new Map())).toEqual({
      unresolved: [],
      diagnostics: [],
    })
  })

  test('one unresolved blocker: ineligible, diagnostic names ticket and blocker', () => {
    const verdict = analyze('A', { A: ['B'], B: [] })

    expect(verdict.unresolved).toEqual(['B'])
    expect(verdict.diagnostics).toEqual(['ticket A blocked by B (not complete)'])
  })

  test('one resolved blocker: eligible', () => {
    expect(analyze('A', { A: ['B'], B: [] }, { done: ['B'] })).toEqual({
      unresolved: [],
      diagnostics: [],
    })
  })

  test('multiple blockers: ineligible until the LAST one resolves', () => {
    const graph = { A: ['B', 'C'], B: [], C: [] }

    expect(analyze('A', graph).unresolved).toEqual(['B', 'C'])
    expect(analyze('A', graph, { done: ['B'] }).unresolved).toEqual(['C'])
    expect(analyze('A', graph, { done: ['C'] }).unresolved).toEqual(['B'])
    expect(analyze('A', graph, { done: ['B', 'C'] })).toEqual({
      unresolved: [],
      diagnostics: [],
    })
  })

  test('a missing blocker: ineligible, diagnostic says it does not exist', () => {
    const verdict = analyze('A', { A: ['B'], B: [] }, { missing: ['B'] })

    expect(verdict.unresolved).toEqual(['B'])
    expect(verdict.diagnostics).toEqual([
      'ticket A blocked by B, which does not exist in this ticket source',
    ])
  })

  test('a blocker absent from the graph entirely reads as missing', () => {
    const verdict = analyze('A', { A: ['B'] })

    expect(verdict.unresolved).toEqual(['B'])
    expect(verdict.diagnostics[0]).toContain('does not exist')
  })

  test('self-dependency: ineligible, named as such', () => {
    const verdict = analyze('A', { A: ['A'] })

    expect(verdict.unresolved).toEqual(['A'])
    expect(verdict.diagnostics).toEqual(['ticket A depends on itself'])
  })

  test('a 2-cycle is named as a cycle, not as a plain incomplete blocker', () => {
    const verdict = analyze('A', { A: ['B'], B: ['A'] })

    expect(verdict.unresolved).toEqual(['B'])
    expect(verdict.diagnostics).toEqual(['ticket A: dependency cycle A → B → A'])
  })

  test('a 3-cycle names the whole loop', () => {
    const verdict = analyze('A', { A: ['B'], B: ['C'], C: ['A'] })

    expect(verdict.diagnostics).toEqual(['ticket A: dependency cycle A → B → C → A'])
  })

  test('a cycle reached through a chain, not involving the ticket itself', () => {
    const verdict = analyze('A', { A: ['B'], B: ['C'], C: ['D'], D: ['C'] })

    expect(verdict.unresolved).toEqual(['B'])
    expect(verdict.diagnostics).toEqual(['ticket A: dependency cycle C → D → C'])
  })

  test('a resolved blocker is never walked — a cycle behind done work is not a diagnostic', () => {
    const verdict = analyze('A', { A: ['B'], B: ['C'], C: ['B'] }, { done: ['B'] })

    expect(verdict).toEqual({ unresolved: [], diagnostics: [] })
  })

  test('mixed: one resolved, one missing, one cycling — each reported once', () => {
    const verdict = analyze(
      'A',
      { A: ['B', 'C', 'D'], B: [], C: [], D: ['A'] },
      { done: ['B'], missing: ['C'] },
    )

    expect(verdict.unresolved).toEqual(['C', 'D'])
    expect(verdict.diagnostics).toEqual([
      'ticket A blocked by C, which does not exist in this ticket source',
      'ticket A: dependency cycle A → D → A',
    ])
  })

  test('a diamond terminates and does not double-report', () => {
    const verdict = analyze('A', {
      A: ['B'],
      B: ['C', 'D'],
      C: ['E'],
      D: ['E'],
      E: [],
    })

    expect(verdict.unresolved).toEqual(['B'])
    expect(verdict.diagnostics).toEqual(['ticket A blocked by B (not complete)'])
  })
})

describe('build slug helpers', () => {
  test('kebab lowercases, strips punctuation, and collapses separators', () => {
    expect(kebab('Add rate limiting!')).toBe('add-rate-limiting')
    expect(kebab('  Fix: OAuth2 / SSO  ')).toBe('fix-oauth2-sso')
    expect(kebab('!!!')).toBe('build')
  })

  test('fallbackSlug keeps only the first three normalized title tokens', () => {
    expect(fallbackSlug('Please add support for login throttling')).toBe('please-add-support')
    expect(fallbackSlug('Fix OAuth2 / SSO now')).toBe('fix-oauth2-sso')
    expect(fallbackSlug('!!!')).toBe('build')
  })

  test('validateSlugCandidate accepts only one-to-three lowercase kebab tokens', () => {
    expect(validateSlugCandidate('auth')).toBe('auth')
    expect(validateSlugCandidate('auth-limit')).toBe('auth-limit')
    expect(validateSlugCandidate('  login-rate-limit\n')).toBe('login-rate-limit')

    for (const invalid of [
      '',
      '   ',
      'Login-rate-limit',
      'login rate limit',
      'login/rate-limit',
      '-login-rate',
      'login-rate-',
      'login--rate',
      'login-rate-limit-now',
      'slug: login-rate',
      '"login-rate"',
    ]) {
      expect(validateSlugCandidate(invalid)).toBeNull()
    }
    expect(validateSlugCandidate(null)).toBeNull()
  })
})

// ── Urgent intake order (AUT-1027) ───────────────────────────────────────────

describe('heldByRepositoryPause', () => {
  test('holds queued builds only, and only while the repository is paused', () => {
    const statuses: BuildState['status'][] = [
      'queued',
      'running',
      'blocked',
      'paused',
      'done',
      'aborted',
    ]
    for (const status of statuses) {
      const state = { status } as BuildState
      expect(heldByRepositoryPause(state, true)).toBe(status === 'queued')
      expect(heldByRepositoryPause(state, false)).toBe(false)
    }
  })
})

describe('defaultProposalState', () => {
  test('defaultProposalState: configured value, else the resolved triage state', () => {
    const linear = (extra = '') =>
      parseConfig(`[tickets]\nsource = "linear"\nteamKey = "AUT"\nreadyState = "Todo"\n${extra}`)

    expect(defaultProposalState(linear())).toBe('Backlog')
    expect(defaultProposalState(linear('triageState = "Icebox"\n'))).toBe('Icebox')
    expect(defaultProposalState(linear('proposalState = "Todo"\n'))).toBe('Todo')
    // An explicit proposal state overrides the triage state without moving it.
    const both = linear('triageState = "Icebox"\nproposalState = "Todo"\n')
    expect(defaultProposalState(both)).toBe('Todo')
    expect(defaultTriageState(both)).toBe('Icebox')
    expect(
      defaultProposalState(parseConfig('[tickets]\nsource = "file"\nreadyState = "ready"\n')),
    ).toBe('Triage')
  })
})

describe('readyCriteria', () => {
  const criteria = (toml: string) => readyCriteria(parseConfig(toml))
  const FILE = '[tickets]\nsource = "file"\n'
  const LINEAR = '[tickets]\nsource = "linear"\nteamKey = "ENG"\n'
  const GITHUB = '[tickets]\nsource = "github"\n'
  const PLUGIN = '[tickets]\nsource = "jira"\n'

  test('each source has its default label gate, and the state gate is always emitted', () => {
    // File and plugin sources gate on state alone; Linear and GitHub keep the
    // historical "autobuild" label as an additional narrowing gate.
    for (const state of ['Ready', 'Todo']) {
      expect(criteria(`${FILE}readyState = "${state}"\n`)).toEqual({ labels: [], state })
      expect(criteria(`${LINEAR}readyState = "${state}"\n`)).toEqual({
        labels: ['autobuild'],
        state,
      })
    }
    expect(criteria(GITHUB)).toEqual({ labels: ['autobuild'], state: 'ready' })
    expect(criteria(`${PLUGIN}readyState = "Open"\n`)).toEqual({ labels: [], state: 'Open' })
    expect(criteria(`${PLUGIN}readyState = "Todo"\n`)).toEqual({ labels: [], state: 'Todo' })
  })

  test('an explicit readyLabels wins for every source, and an empty one is honored', () => {
    for (const source of [FILE, LINEAR, PLUGIN]) {
      expect(criteria(`${source}readyLabels = ["urgent"]\nreadyState = "Ready"\n`)).toEqual({
        labels: ['urgent'],
        state: 'Ready',
      })
    }
    expect(criteria(`${LINEAR}readyLabels = []\nreadyState = "Ready"\n`)).toEqual({
      labels: [],
      state: 'Ready',
    })
    expect(criteria(`${GITHUB}readyLabels = []\n`)).toEqual({ labels: [], state: 'ready' })
  })

  test('readyAssignee joins the criteria only when configured', () => {
    expect(criteria(`${LINEAR}readyState = "Ready"\nreadyAssignee = "me"\n`)).toEqual({
      labels: ['autobuild'],
      state: 'Ready',
      assignee: 'me',
    })
    expect(
      criteria(`${LINEAR}readyState = "Ready"\nreadyAssignee = "a@example.com"\n`).assignee,
    ).toBe('a@example.com')
    expect('assignee' in criteria(`${LINEAR}readyState = "Ready"\n`)).toBe(false)
    expect(criteria(`${GITHUB}readyAssignee = "octocat"\n`)).toEqual({
      labels: ['autobuild'],
      state: 'ready',
      assignee: 'octocat',
    })
  })

  test('a config with no readyState fails at the tickets path', () => {
    expect(() => criteria(LINEAR)).toThrow('tickets.readyState')
    expect(() => criteria('')).toThrow('tickets.readyState')
  })
})
