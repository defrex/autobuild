import { z } from 'zod'
import type { GitHubRequest } from './github-transport'
import { readinessChecks, type ForgeReadinessCheck, type ForgeReadinessInput } from './readiness'

const access =
  'Grant Metadata:read and Administration:read for inspection (classic private repositories: repo scope); Contents:write is separately required for publication.'
const ruleSchema = z.object({
  type: z.string().min(1),
  ruleset_id: z.number().int().positive().optional(),
  parameters: z.unknown().optional(),
})
const rulesetSchema = z.object({
  id: z.number().int(),
  target: z.enum(['branch', 'tag', 'push']),
  enforcement: z.enum(['active', 'disabled', 'evaluate']),
  bypass_actors: z
    .array(
      z.object({
        actor_type: z.string(),
        actor_id: z.number().nullable(),
        bypass_mode: z.enum(['always', 'pull_request', 'exempt']),
      }),
    )
    .optional(),
  conditions: z
    .object({ ref_name: z.object({ include: z.array(z.string()), exclude: z.array(z.string()) }) })
    .optional(),
  rules: z.array(ruleSchema),
})
type Ruleset = z.infer<typeof rulesetSchema>
const classicSchema = z.object({
  pattern: z.string(),
  allowsForcePushes: z.boolean(),
  restrictsPushes: z.boolean(),
  requiresLinearHistory: z.boolean(),
  isAdminEnforced: z.boolean(),
  lockBranch: z.boolean(),
  blocksCreations: z.boolean(),
  requiresApprovingReviews: z.boolean(),
  requiresStatusChecks: z.boolean(),
  requiresCommitSignatures: z.boolean(),
  requiresDeployments: z.boolean(),
  bypassForcePushAllowances: z.object({ totalCount: z.number().int().nonnegative() }),
})
type Classic = z.infer<typeof classicSchema>
type Applicability = 'yes' | 'no' | 'unknown'

/** Deliberately small subset of GitHub fnmatch: literals and trailing /**.
 * Everything else stays uncertain; never use a regex approximation as proof. */
export function patternMatches(pattern: string, name: string, defaultRef: string): Applicability {
  if (pattern === '~ALL') return 'yes'
  if (pattern === '~DEFAULT_BRANCH') return name === defaultRef ? 'yes' : 'no'
  if (!/[?*[\\]/.test(pattern)) return pattern === name ? 'yes' : 'no'
  if (pattern.endsWith('/**') && !/[?*[\\]/.test(pattern.slice(0, -3)))
    return name.startsWith(pattern.slice(0, -2)) ? 'yes' : 'no'
  return 'unknown'
}
/** Whether some future name in a namespace can be selected. Literal exceptions
 * inside the namespace count, even when no such ref exists yet. */
export function patternOverlaps(
  pattern: string,
  prefix: string,
  defaultRef: string,
): Applicability {
  if (pattern === '~ALL') return 'yes'
  if (pattern === '~DEFAULT_BRANCH') return defaultRef.startsWith(prefix) ? 'yes' : 'no'
  if (!/[?*[\\]/.test(pattern)) return pattern.startsWith(prefix) ? 'yes' : 'no'
  const literal = pattern.split(/[?*[\\]/)[0]!
  if (!prefix.startsWith(literal) && !literal.startsWith(prefix)) return 'no'
  if (pattern.endsWith('/**') && !/[?*[\\]/.test(pattern.slice(0, -3))) return 'yes'
  return 'unknown'
}
function any(values: Applicability[]): Applicability {
  return values.includes('yes') ? 'yes' : values.includes('unknown') ? 'unknown' : 'no'
}
function applies(
  set: Ruleset,
  value: string,
  defaultRef: string,
  namespace = false,
): Applicability {
  if (set.target === 'push') return 'yes'
  if (set.target !== 'branch') return 'no'
  if (!set.conditions) return 'unknown'
  const conditions = set.conditions.ref_name
  const match = namespace ? patternOverlaps : patternMatches
  const include = any(conditions.include.map((pattern) => match(pattern, value, defaultRef)))
  if (include === 'no') return 'no'
  if (!namespace) {
    const exclude = any(
      conditions.exclude.map((pattern) => patternMatches(pattern, value, defaultRef)),
    )
    if (exclude === 'yes') return 'no'
    return exclude === 'unknown' ? 'unknown' : include
  }
  // An exclusion of the entire prefix proves disjointness. Partial exclusions
  // cannot prove that all future names are exempt.
  if (conditions.exclude.some((pattern) => pattern === '~ALL' || pattern === `${value}**`))
    return 'no'
  if (conditions.exclude.every((pattern) => patternOverlaps(pattern, value, defaultRef) === 'no'))
    return include
  // Literal exclusions remove finitely many names. A supported recursive
  // include still restricts infinitely many names in the owned namespace.
  const literalExclusions = conditions.exclude.every((pattern) => !/[?*[\\~]/.test(pattern))
  if (literalExclusions) {
    for (const pattern of conditions.include) {
      if (patternOverlaps(pattern, value, defaultRef) !== 'yes') continue
      if (pattern === '~ALL' || pattern.endsWith('/**')) return 'yes'
      const concrete = pattern === '~DEFAULT_BRANCH' ? defaultRef : pattern
      if (
        conditions.exclude.every(
          (exclude) => patternMatches(exclude, concrete, defaultRef) === 'no',
        )
      )
        return 'yes'
    }
  }
  return 'unknown'
}

export async function inspectGitHubReadiness(opts: {
  request: GitHubRequest
  owner: string
  name: string
  input: ForgeReadinessInput
}): Promise<ForgeReadinessCheck[]> {
  const { request } = opts
  const root = `repos/${encodeURIComponent(opts.owner)}/${encodeURIComponent(opts.name)}`
  const checks = readinessChecks('unknown', `Inspection incomplete. ${access}`)
  const set = (
    key: ForgeReadinessCheck['check'],
    status: ForgeReadinessCheck['status'],
    detail: string,
  ) => {
    const check = checks.find((item) => item.check === key)!
    check.status = status
    check.detail = detail
  }
  async function get<T>(
    path: string,
    schema: z.ZodType<T>,
    query?: Record<string, string>,
  ): Promise<T> {
    const response = await request('GET', path, query ? { query } : undefined)
    if (response.status < 200 || response.status >= 300) throw new Error('GitHub inspection failed')
    return schema.parse(response.json)
  }
  async function pages<T>(
    path: string,
    schema: z.ZodType<T>,
    query: Record<string, string> = {},
  ): Promise<T[]> {
    const result: T[] = []
    for (let page = 1; ; page++) {
      const batch = await get(path, z.array(schema), {
        ...query,
        per_page: '100',
        page: String(page),
      })
      result.push(...batch)
      if (batch.length < 100) return result
    }
  }
  let write: boolean | undefined
  let defaultRef: string | undefined
  try {
    const repo = await get(root, z.record(z.string(), z.unknown()))
    for (const key of ['squash', 'rebase'] as const) {
      const parsed = z.boolean().safeParse(repo[`allow_${key}_merge`])
      if (parsed.success)
        set(key, parsed.data ? 'pass' : 'fail', `GitHub allow_${key}_merge is ${parsed.data}.`)
    }
    const permissions = z.object({ push: z.boolean() }).safeParse(repo.permissions)
    write = permissions.success ? permissions.data.push : undefined
    const branch = z.string().min(1).safeParse(repo.default_branch)
    defaultRef = branch.success ? `refs/heads/${branch.data}` : undefined
  } catch {
    /* Independent policy reads can still provide useful evidence. */
  }
  if (write === false)
    for (const key of ['build-refs', 'node-refs', 'archive-refs'] as const)
      set(
        key,
        'fail',
        'The authenticated forge identity lacks repository push permission; grant Contents:write.',
      )

  let classic: Classic[] | undefined
  try {
    classic = []
    let cursor: string | null = null
    const seen = new Set<string>()
    for (;;) {
      const response = await request('POST', 'graphql', {
        body: {
          query: `query($owner: String!, $name: String!, $cursor: String) { repository(owner: $owner, name: $name) { branchProtectionRules(first: 100, after: $cursor) { nodes { pattern allowsForcePushes restrictsPushes requiresLinearHistory isAdminEnforced lockBranch blocksCreations requiresApprovingReviews requiresStatusChecks requiresCommitSignatures requiresDeployments bypassForcePushAllowances { totalCount } } pageInfo { hasNextPage endCursor } } } }`,
          variables: { owner: opts.owner, name: opts.name, cursor },
        },
      })
      if (response.status < 200 || response.status >= 300)
        throw new Error('GraphQL inspection failed')
      const envelope = z
        .object({
          errors: z.array(z.unknown()).optional(),
          data: z
            .object({
              repository: z.object({
                branchProtectionRules: z.object({
                  nodes: z.array(classicSchema),
                  pageInfo: z.object({
                    hasNextPage: z.boolean(),
                    endCursor: z.string().nullable(),
                  }),
                }),
              }),
            })
            .optional(),
        })
        .parse(response.json)
      if (envelope.errors?.length || !envelope.data) throw new Error('Incomplete classic inventory')
      const connection = envelope.data.repository.branchProtectionRules
      classic.push(...connection.nodes)
      if (!connection.pageInfo.hasNextPage) break
      cursor = connection.pageInfo.endCursor
      if (!cursor || seen.has(cursor)) throw new Error('Incomplete classic pagination')
      seen.add(cursor)
    }
  } catch {
    classic = undefined
  }
  let sets: Ruleset[] | undefined
  try {
    const inventory = await pages(
      `${root}/rulesets`,
      z.object({ id: z.number().int(), enforcement: z.enum(['active', 'disabled', 'evaluate']) }),
      { includes_parents: 'true' },
    )
    sets = []
    for (const item of inventory) {
      if (item.enforcement !== 'active') continue
      const detail = await get(`${root}/rulesets/${item.id}`, rulesetSchema, {
        includes_parents: 'true',
      })
      if (detail.enforcement === 'active') sets.push(detail)
    }
  } catch {
    sets = undefined
  }

  for (const [key, prefix] of [
    ['build-refs', 'refs/heads/ab/'],
    ['node-refs', 'refs/heads/ab-node/'],
  ] as const) {
    if (write === false) continue
    let unknown = write !== true || !classic || !sets || !defaultRef
    let blocked = false
    const details: string[] = []
    if (classic) {
      const overlaps = classic.filter(
        (rule) =>
          patternOverlaps(rule.pattern, prefix.slice(11), defaultRef?.slice(11) ?? '') !== 'no',
      )
      for (const rule of overlaps) {
        const overlap = patternOverlaps(rule.pattern, prefix.slice(11), defaultRef?.slice(11) ?? '')
        if (overlap === 'unknown' || overlaps.length > 1 || rule.restrictsPushes) unknown = true
        else if (!rule.isAdminEnforced || rule.bypassForcePushAllowances.totalCount > 0)
          unknown = true
        else if (!rule.allowsForcePushes || rule.lockBranch) {
          blocked = true
          details.push(
            `Classic protection ${rule.pattern} forbids force pushes or locks publication.`,
          )
        } else if (
          rule.blocksCreations ||
          rule.requiresApprovingReviews ||
          rule.requiresStatusChecks ||
          rule.requiresCommitSignatures ||
          rule.requiresDeployments
        )
          unknown = true
      }
    }
    for (const rule of sets ?? []) {
      const appliesTo = applies(rule, prefix, defaultRef ?? '', true)
      if (appliesTo === 'no') continue
      // Actor/team/app membership is not inferred from repository write access.
      // PR-only bypasses never authorize a direct push.
      const directBypass = rule.bypass_actors?.some((actor) => actor.bypass_mode !== 'pull_request')
      const restrictions = rule.rules.filter(
        (item) => item.type !== 'deletion' && item.type !== 'required_linear_history',
      )
      if (!restrictions.length) continue
      if (appliesTo === 'unknown' || rule.bypass_actors === undefined || directBypass) {
        unknown = true
        continue
      }
      if (
        restrictions.some((item) =>
          ['non_fast_forward', 'update', 'creation', 'pull_request'].includes(item.type),
        )
      ) {
        blocked = true
        details.push(`Active ruleset ${rule.id} restricts direct publication or force pushes.`)
      } else unknown = true // Content-dependent and future rule types cannot prove publication.
    }
    set(
      key,
      blocked ? 'fail' : unknown ? 'unknown' : 'pass',
      blocked
        ? details.join(' ')
        : unknown
          ? `Cannot prove publication and force-push permission throughout ${prefix}. ${access}`
          : `Repository push permission and complete policy inventory permit rewrites throughout ${prefix}.`,
    )
  }
  if (write !== false)
    set(
      'archive-refs',
      'unknown',
      `GitHub branch protection APIs do not establish publication permission for non-head refs/autobuild/archive/. ${access} Manually verify this ref domain without creating or overwriting probe archives.`,
    )

  try {
    // Matching refs returns the complete array and has no pagination parameters.
    // A full response can contain 100+ refs, so the paginated helper would loop.
    const nodes = await get(
      `${root}/git/matching-refs/heads/ab-node/`,
      z.array(z.object({ ref: z.string() })),
    )
    const targets = [
      opts.input.rootBranch,
      ...nodes.map((node) => {
        if (!node.ref.startsWith('refs/heads/ab-node/')) throw new Error('Unexpected target ref')
        return node.ref.slice(11)
      }),
    ]
    let uncertain = !classic || !sets || !defaultRef
    const missing: string[] = []
    let rootFence: boolean | undefined
    for (const branch of new Set(targets)) {
      const active = await pages(`${root}/rules/branches/${encodeURIComponent(branch)}`, ruleSchema)
      const matches = (classic ?? []).filter(
        (rule) => patternMatches(rule.pattern, branch, defaultRef?.slice(11) ?? '') !== 'no',
      )
      if (
        matches.some(
          (rule) => patternMatches(rule.pattern, branch, defaultRef?.slice(11) ?? '') === 'unknown',
        )
      )
        uncertain = true
      let linear = active.some((rule) => rule.type === 'required_linear_history')
      let protection: z.infer<typeof protectionSchema> | undefined
      if (matches.length) {
        protection = await get(
          `${root}/branches/${encodeURIComponent(branch)}/protection`,
          protectionSchema,
        )
        linear ||= protection.required_linear_history.enabled
      }
      if ((matches.length || active.length) && !linear) missing.push(branch)
      if (branch === opts.input.rootBranch && classic && sets && defaultRef) {
        rootFence = !!(
          protection?.enforce_admins.enabled &&
          protection.required_status_checks?.strict &&
          protection.required_status_checks.contexts.length +
            protection.required_status_checks.checks.length >
            0
        )
        for (const check of active) {
          if (check.type !== 'required_status_checks') continue
          const parameters = z
            .object({
              strict_required_status_checks_policy: z.boolean(),
              required_status_checks: z.array(z.object({ context: z.string() })),
            })
            .safeParse(check.parameters)
          if (!parameters.success) {
            if (rootFence !== true) rootFence = undefined
            continue
          }
          if (
            !parameters.data.strict_required_status_checks_policy ||
            !parameters.data.required_status_checks.length
          )
            continue
          const rule = sets.find((rule) => rule.id === check.ruleset_id)
          if (!rule || rule.bypass_actors === undefined) {
            if (rootFence !== true) rootFence = undefined
          } else if (rule.bypass_actors.length === 0) rootFence = true
        }
      }
    }
    set(
      'linear-history',
      missing.length ? 'fail' : uncertain ? 'unknown' : 'pass',
      missing.length
        ? `Protected targets missing Require linear history: ${missing.join(', ')}.`
        : uncertain
          ? `Protected target inventory incomplete. ${access}`
          : 'All protected root/node targets require linear history; unprotected targets impose no recommendation.',
    )
    if (rootFence !== undefined)
      set(
        'root-freshness',
        rootFence ? 'pass' : 'fail',
        rootFence
          ? `Root ${opts.input.rootBranch} enforces strict nonempty checks for all actors: fenced merge.`
          : `Root ${opts.input.rootBranch} does not enforce strict nonempty checks for all actors: best-effort merge.`,
      )
  } catch {
    /* No vacuous success on incomplete target or policy reads. */
  }
  return checks
}
const protectionSchema = z.object({
  required_linear_history: z.object({ enabled: z.boolean() }),
  enforce_admins: z.object({ enabled: z.boolean() }),
  required_status_checks: z
    .object({ strict: z.boolean(), contexts: z.array(z.string()), checks: z.array(z.unknown()) })
    .nullable(),
})
