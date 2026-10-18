import { expect, test } from 'bun:test'
import { inspectGitHubReadiness, patternMatches, patternOverlaps } from './github-readiness'
import type { GitHubRequest } from './github-transport'

function fixture(
  options: {
    repo?: unknown
    classic?: unknown[]
    sets?: Record<string, unknown>[]
    protection?: unknown
    rules?: unknown[]
    fail?: string
  } = {},
) {
  const calls: { method: string; path: string; opts: unknown }[] = []
  const request: GitHubRequest = async (method, path, opts) => {
    calls.push({ method, path, opts })
    if (options.fail && path.includes(options.fail)) throw new Error('denied')
    let json: unknown
    if (path === 'graphql')
      json = {
        data: {
          repository: {
            branchProtectionRules: {
              nodes: options.classic ?? [],
              pageInfo: { hasNextPage: false, endCursor: null },
            },
          },
        },
      }
    else if (path.endsWith('/rulesets'))
      json = (options.sets ?? []).map((set) => ({ id: set.id, enforcement: set.enforcement }))
    else if (path.includes('/rulesets/'))
      json = options.sets?.find((set) => path.endsWith(`/${set.id}`))
    else if (path.includes('/git/matching-refs/')) json = []
    else if (path.includes('/rules/branches/')) json = options.rules ?? []
    else if (path.endsWith('/protection'))
      json = options.protection ?? {
        enforce_admins: { enabled: true },
        required_linear_history: { enabled: true },
        required_status_checks: { strict: true, contexts: ['ci'], checks: [] },
      }
    else
      json = options.repo ?? {
        allow_squash_merge: true,
        allow_rebase_merge: true,
        default_branch: 'main',
        permissions: { push: true },
      }
    return { status: 200, json, headers: {} }
  }
  return {
    calls,
    inspect: () =>
      inspectGitHubReadiness({
        request,
        owner: 'o',
        name: 'r',
        input: { rootBranch: 'release/root' },
      }),
  }
}
const byKey = (checks: Awaited<ReturnType<typeof inspectGitHubReadiness>>, key: string) =>
  checks.find((check) => check.check === key)!
const classic = (pattern: string, allowsForcePushes = false) => ({
  pattern,
  allowsForcePushes,
  restrictsPushes: false,
  requiresLinearHistory: true,
  isAdminEnforced: true,
  lockBranch: false,
  blocksCreations: false,
  requiresApprovingReviews: false,
  requiresStatusChecks: false,
  requiresCommitSignatures: false,
  requiresDeployments: false,
  bypassForcePushAllowances: { totalCount: 0 },
})
const ruleset = (include: string[], extra: Record<string, unknown> = {}) => ({
  id: 1,
  target: 'branch',
  enforcement: 'active',
  bypass_actors: [],
  conditions: { ref_name: { include, exclude: [] } },
  rules: [{ type: 'non_fast_forward' }],
  ...extra,
})

test('read-only inventory proves branches, never archive domain; branch slashes encoded', async () => {
  const fixture_ = fixture()
  const checks = await fixture_.inspect()
  expect(byKey(checks, 'build-refs').status).toBe('pass')
  expect(byKey(checks, 'archive-refs').status).toBe('unknown')
  expect(byKey(checks, 'linear-history').status).toBe('pass')
  expect(byKey(checks, 'root-freshness').status).toBe('fail')
  expect(fixture_.calls.some((call) => call.path.includes('release%2Froot'))).toBe(true)
  expect(fixture_.calls.every((call) => call.method === 'GET' || call.path === 'graphql')).toBe(
    true,
  )
  expect(JSON.stringify(fixture_.calls)).not.toContain('mutation')
  expect(
    fixture_.calls
      .filter((call) => call.path.includes('/rules/branches/'))
      .every((call) => !call.path.includes('archive')),
  ).toBe(true)
})
test('merge methods preserve explicit failure despite other missing fields', async () => {
  const checks = await fixture({ repo: { allow_squash_merge: false }, fail: 'graphql' }).inspect()
  expect(byKey(checks, 'squash').status).toBe('fail')
  expect(byKey(checks, 'rebase').status).toBe('unknown')
  expect(byKey(checks, 'build-refs').status).toBe('unknown')
})
test('literal future-name exceptions defeat namespace assurance', async () => {
  for (const options of [
    { classic: [classic('ab/special')] },
    { sets: [ruleset(['refs/heads/ab/special'])] },
  ]) {
    const checks = await fixture(options).inspect()
    expect(byKey(checks, 'build-refs').status).toBe('fail')
    expect(byKey(checks, 'node-refs').status).toBe('pass')
  }
})
test('ambiguous patterns, classic precedence, restricted actors, and omitted bypass stay unknown', async () => {
  for (const options of [
    { classic: [classic('ab/*')] },
    { classic: [classic('ab/**'), classic('ab/special', true)] },
    { classic: [{ ...classic('ab/**', true), restrictsPushes: true }] },
    { sets: [ruleset(['refs/heads/ab/**'], { bypass_actors: undefined })] },
    {
      sets: [
        ruleset(['refs/heads/ab/**'], {
          bypass_actors: [{ actor_type: 'Team', actor_id: 1, bypass_mode: 'always' }],
        }),
      ],
    },
  ])
    expect(byKey(await fixture(options).inspect(), 'build-refs').status).toBe('unknown')
})
test('PR-only bypass does not permit direct push; inactive policies do not constrain', async () => {
  expect(
    byKey(
      await fixture({
        sets: [
          ruleset(['refs/heads/ab/**'], {
            bypass_actors: [{ actor_type: 'User', actor_id: 1, bypass_mode: 'pull_request' }],
          }),
        ],
      }).inspect(),
      'build-refs',
    ).status,
  ).toBe('fail')
  for (const enforcement of ['evaluate', 'disabled'])
    expect(
      byKey(await fixture({ sets: [ruleset(['~ALL'], { enforcement })] }).inspect(), 'build-refs')
        .status,
    ).toBe('pass')
})
test('missing write permission is a hard failure even with unavailable policy reads', async () => {
  const checks = await fixture({
    repo: { permissions: { push: false } },
    fail: 'graphql',
  }).inspect()
  for (const key of ['build-refs', 'node-refs', 'archive-refs'])
    expect(byKey(checks, key).status).toBe('fail')
})
test('failed policy and target enumeration never imply absence', async () => {
  for (const fail of ['graphql', '/rulesets', '/git/matching-refs/', '/rules/branches/']) {
    const checks = await fixture({ fail }).inspect()
    expect(byKey(checks, 'linear-history').status).toBe('unknown')
    if (fail === 'graphql' || fail === '/rulesets')
      expect(byKey(checks, 'build-refs').status).toBe('unknown')
  }
})
test('protected target recommendations inspect actual classic settings', async () => {
  const checks = await fixture({
    classic: [classic('release/root')],
    protection: {
      enforce_admins: { enabled: false },
      required_linear_history: { enabled: false },
      required_status_checks: { strict: true, contexts: ['ci'], checks: [] },
    },
  }).inspect()
  expect(byKey(checks, 'linear-history').status).toBe('fail')
  expect(byKey(checks, 'root-freshness').status).toBe('fail')
})
test('applicability supports literal unrelated roots without guessing fnmatch', () => {
  expect(patternOverlaps('refs/heads/main', 'refs/heads/ab/', '')).toBe('no')
  expect(patternOverlaps('refs/heads/ab/exception', 'refs/heads/ab/', '')).toBe('yes')
  expect(patternMatches('ab/**', 'ab/x/y', '')).toBe('yes')
  expect(patternMatches('ab/[xy]', 'ab/x', '')).toBe('unknown')
})

test('HTTP errors and partial GraphQL errors never prove policy absence', async () => {
  for (const status of [401, 403, 404, 429, 500]) {
    const checks = await inspectGitHubReadiness({
      owner: 'o',
      name: 'r',
      input: { rootBranch: 'main' },
      request: async () => ({ status, headers: {}, json: {} }),
    })
    expect(checks.every((check) => check.status === 'unknown')).toBe(true)
  }
  const checks = await inspectGitHubReadiness({
    owner: 'o',
    name: 'r',
    input: { rootBranch: 'main' },
    request: async (_method, path) =>
      path === 'graphql'
        ? {
            status: 200,
            headers: {},
            json: {
              errors: [{ message: 'scope required' }],
              data: {
                repository: {
                  branchProtectionRules: {
                    nodes: [],
                    pageInfo: { hasNextPage: false, endCursor: null },
                  },
                },
              },
            },
          }
        : { status: 403, headers: {}, json: {} },
  })
  expect(byKey(checks, 'build-refs').status).toBe('unknown')
})
test('classic cursor pagination and REST inventory pagination include later exact-name restrictions', async () => {
  const calls: string[] = []
  const request: GitHubRequest = async (_method, path, opts) => {
    calls.push(`${path}:${opts?.query?.page ?? ''}`)
    let json: unknown
    if (path === 'graphql') {
      if (!opts) throw new Error('Expected GraphQL options')
      const cursor = (opts.body as { variables: { cursor: string | null } }).variables.cursor
      json = {
        data: {
          repository: {
            branchProtectionRules: {
              nodes: cursor ? [classic('ab-node/later')] : [],
              pageInfo: { hasNextPage: !cursor, endCursor: cursor ? null : 'next' },
            },
          },
        },
      }
    } else if (path.endsWith('/rulesets'))
      json =
        opts?.query?.page === '1'
          ? Array.from({ length: 100 }, (_, i) => ({ id: i + 1, enforcement: 'disabled' }))
          : [{ id: 101, enforcement: 'active' }]
    else if (path.endsWith('/rulesets/101')) json = { ...ruleset(['refs/heads/ab/later']), id: 101 }
    else if (path.includes('/git/matching-refs/') || path.includes('/rules/branches/')) json = []
    else
      json = {
        allow_squash_merge: true,
        allow_rebase_merge: true,
        default_branch: 'main',
        permissions: { push: true },
      }
    return { status: 200, headers: {}, json }
  }
  const checks = await inspectGitHubReadiness({
    request,
    owner: 'o',
    name: 'r',
    input: { rootBranch: 'main' },
  })
  expect(byKey(checks, 'build-refs').status).toBe('fail')
  expect(byKey(checks, 'node-refs').status).toBe('fail')
  expect(calls.filter((path) => path.startsWith('graphql'))).toHaveLength(2)
  expect(calls).toContain('repos/o/r/rulesets:2')
})
test('classic force allowance alone does not prove actor or publication permission', async () => {
  for (const override of [
    { isAdminEnforced: false },
    { bypassForcePushAllowances: { totalCount: 1 } },
    { requiresApprovingReviews: true },
    { requiresStatusChecks: true },
    { requiresCommitSignatures: true },
    { blocksCreations: true },
  ]) {
    expect(
      byKey(
        await fixture({ classic: [{ ...classic('ab/**', true), ...override }] }).inspect(),
        'build-refs',
      ).status,
    ).toBe('unknown')
  }
})
test('root fence requires nonempty strict checks and enforcement for all actors', async () => {
  const good = {
    enforce_admins: { enabled: true },
    required_linear_history: { enabled: true },
    required_status_checks: { strict: true, contexts: ['ci'], checks: [] },
  }
  expect(
    byKey(
      await fixture({ classic: [classic('release/root')], protection: good }).inspect(),
      'root-freshness',
    ).status,
  ).toBe('pass')
  for (const required_status_checks of [
    { strict: false, contexts: ['ci'], checks: [] },
    { strict: true, contexts: [], checks: [] },
  ])
    expect(
      byKey(
        await fixture({
          classic: [classic('release/root')],
          protection: { ...good, required_status_checks },
        }).inspect(),
        'root-freshness',
      ).status,
    ).toBe('fail')
})

test('literal exclusions cannot hide other blocked future names', async () => {
  for (const include of [['refs/heads/ab/special'], ['refs/heads/ab/**']]) {
    const checks = await fixture({
      sets: [
        ruleset(include, {
          conditions: { ref_name: { include, exclude: ['refs/heads/ab/other'] } },
        }),
      ],
    }).inspect()
    expect(byKey(checks, 'build-refs').status).toBe('fail')
  }
})
