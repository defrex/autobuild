export const TICKET_TREE_HEADER = 'x-autobuild-ticket-tree'
export const TICKET_TREE_CAPABILITY = '1'
import { z } from 'zod'
import { ticketRefSchema } from '../../ontology'
import { refineUniqueIssues } from './issue-links'
import { holdsState } from './lifecycle'

/** Explicit opt-in: released clients through 0.12 use strict decoders without revisions.
 * Source checkouts can share their release version, so version alone is insufficient. */
export const TICKET_REVISIONS_HEADER = 'x-autobuild-ticket-revisions'
export const TICKET_REVISIONS_CAPABILITY = '1'

/** Repository-owned policy sent with every hosted ticket operation. */
export const hostedTicketContextSchema = z.strictObject({
  teamKey: z.string().min(1),
  repo: z.string().min(1).optional(),
  claimedState: z.string().min(1).optional(),
  createState: z.string().min(1).optional(),
})
export type HostedTicketContext = z.infer<typeof hostedTicketContextSchema>

export const TICKET_COMMENTS_HEADER = 'x-autobuild-ticket-comments'
export const TICKET_COMMENTS_CAPABILITY = '1'

/** Explicit opt-in: published 1.2–1.4 clients decode tickets strictly without
 * issue links. Servers echo it on every ticket response so a client can tell an
 * older server's strict-schema refusal from an ordinary validation failure. */
export const TICKET_ISSUE_LINKS_HEADER = 'x-autobuild-ticket-issue-links'
export const TICKET_ISSUE_LINKS_CAPABILITY = '1'

/** Explicit opt-in: released clients decode dependency states strictly without
 * `state`. Servers include each blocker's native state name only for clients
 * that send this header; an older server ignores it and omits the field. */
export const TICKET_DEPENDENCY_STATE_HEADER = 'x-autobuild-ticket-dependency-state'
export const TICKET_DEPENDENCY_STATE_CAPABILITY = '1'

/** Explicit opt-in: released 1.2–1.4 clients publish and decode project ticket
 * policy strictly without `backlogState`/`rejectedState`. With the header a
 * publish is the complete policy (an absent role is unset); without it, absent
 * roles keep their saved values and reads omit them. Servers echo it on every
 * policy response so a client can tell an older server's strict refusal from an
 * ordinary validation failure. */
export const TICKET_POLICY_ROLES_HEADER = 'x-autobuild-ticket-policy-roles'
export const TICKET_POLICY_ROLES_CAPABILITY = '1'

export const issueLinkWireSchema = z.strictObject({
  issue: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  intent: z.enum(['closes', 'refs']),
})
export const issueLinksWireSchema = z.array(issueLinkWireSchema).superRefine(refineUniqueIssues)

export const ticketCommentWireSchema = z.strictObject({
  body: z.string(),
  createdAt: z.string(),
  author: z.string().optional(),
})

export const ticketWireSchema = z.strictObject({
  kind: z.enum(['work', 'node']).optional(),
  target: z
    .string()
    .refine((v) => v.trim().length > 0)
    .optional(),
  revision: z.string().min(1),
  ref: ticketRefSchema,
  comments: z.array(ticketCommentWireSchema).optional(),
  creationKey: z.string().optional(),
  title: z.string(),
  body: z.string(),
  state: z.string().optional(),
  resolved: z.boolean(),
  labels: z.array(z.string()),
  blockersResolved: z.boolean().optional(),
  blockedBy: z.array(z.string()).optional(),
  issueLinks: issueLinksWireSchema.optional(),
})
export const ticketListingWireSchema = z.strictObject({
  tickets: z.array(ticketWireSchema),
  diagnostics: z.array(z.string()),
})
export const dependencyStateWireSchema = z.strictObject({
  id: z.string(),
  exists: z.boolean(),
  resolved: z.boolean(),
  state: z.string().min(1).optional(),
  blockedBy: z.array(z.string()),
})
export const dependencyStatesWireSchema = z.array(dependencyStateWireSchema)
export const successWireSchema = z.strictObject({ ok: z.literal(true) })
export const claimWireSchema = z.strictObject({ claimed: z.boolean() })

const criteriaSchema = z.strictObject({
  labels: z.array(z.string()).optional(),
  state: z.string().optional(),
})
const idSchema = z.strictObject({ id: z.string().min(1) })
const draftSchema = z.strictObject({
  kind: z.enum(['work', 'node']).optional(),
  target: z
    .string()
    .refine((v) => v.trim().length > 0)
    .nullable()
    .optional(),
  title: z.string(),
  body: z.string(),
  labels: z.array(z.string()).optional(),
  blockedBy: z.array(z.string()).optional(),
  issueLinks: issueLinksWireSchema.optional(),
})
const createOptionsSchema = z.strictObject({
  requestedId: z.string().min(1).optional(),
  state: z.string().optional(),
  idempotencyKey: z.string().optional(),
})
const updateSchema = z
  .strictObject({
    kind: z.enum(['work', 'node']).optional(),
    target: z
      .string()
      .refine((v) => v.trim().length > 0)
      .nullable()
      .optional(),
    title: z.string().optional(),
    body: z.string().optional(),
    labels: z.array(z.string()).optional(),
    issueLinks: issueLinksWireSchema.optional(),
  })
  .refine((value) => Object.keys(value).length > 0, 'update must name at least one field')

function envelope<T extends z.ZodType>(input: T) {
  return z.strictObject({ context: hostedTicketContextSchema, input })
}

const mutationSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('update'), patch: updateSchema }),
  z.strictObject({ kind: z.literal('transition'), state: z.string().min(1) }),
  z.strictObject({
    kind: z.literal('blockers'),
    operation: z.enum(['block', 'unblock']),
    ids: z.array(z.string().min(1)),
  }),
])

export const hostedTicketRequestSchemas = {
  'mutate-if-revision': envelope(
    z.strictObject({
      id: z.string().min(1),
      expectedRevision: z.string().refine((v) => v.trim().length > 0),
      mutation: mutationSchema,
    }),
  ),
  'list-ready': envelope(criteriaSchema),
  states: envelope(z.strictObject({})),
  'state-counts': envelope(z.strictObject({ names: z.array(z.string().min(1)).min(1).max(16) })),
  'add-state': envelope(z.strictObject({ name: z.string(), about: z.string().optional() })),
  get: envelope(idSchema),
  claim: envelope(idSchema),
  comment: envelope(z.strictObject({ id: z.string().min(1), body: z.string() })),
  transition: envelope(z.strictObject({ id: z.string().min(1), state: z.string().min(1) })),
  create: envelope(z.strictObject({ draft: draftSchema, options: createOptionsSchema.optional() })),
  update: envelope(z.strictObject({ id: z.string().min(1), patch: updateSchema })),
  'add-blocker': envelope(z.strictObject({ id: z.string().min(1), blockerId: z.string().min(1) })),
  'remove-blocker': envelope(
    z.strictObject({ id: z.string().min(1), blockerId: z.string().min(1) }),
  ),
  'dependency-states': envelope(z.strictObject({ ids: z.array(z.string().min(1)) })),
} as const

export type HostedTicketOperation = keyof typeof hostedTicketRequestSchemas
export const HOSTED_TICKET_OPERATIONS = Object.keys(
  hostedTicketRequestSchemas,
) as HostedTicketOperation[]

const policyStateSchema = z
  .string()
  .min(1)
  .refine((value) => value.trim().length > 0, 'state must be nonblank')

const POLICY_OPTIONAL_ROLES = [
  ['backlog', 'backlogState'],
  ['rejected', 'rejectedState'],
] as const
const POLICY_LIFECYCLE_ROLES = [
  ['ready', 'readyState'],
  ['claimed', 'claimedState'],
  ['done', 'doneState'],
  ['triage', 'triageState'],
  ['proposal', 'proposalState'],
] as const

interface PolicyRoleNames {
  readyState: string
  claimedState: string
  doneState: string
  triageState: string
  proposalState: string
  backlogState?: string | undefined
  rejectedState?: string | undefined
}

/** The policy form of the config rule: backlog and rejected each hold a state
 * of their own, distinct from ready, claimed, done, triage and proposal and
 * from each other (case-insensitive). Create is not checked, as in config. */
interface PolicyRoleOverlap {
  key: string
  otherKey: string
  name: string
  held: string
  message: string
}

function policyRoleOverlaps(tickets: PolicyRoleNames): PolicyRoleOverlap[] {
  const issues: PolicyRoleOverlap[] = []
  for (const [index, [role, key]] of POLICY_OPTIONAL_ROLES.entries()) {
    const name = tickets[key]
    if (name === undefined) continue
    for (const [other, otherKey] of [
      ...POLICY_LIFECYCLE_ROLES,
      ...POLICY_OPTIONAL_ROLES.slice(index + 1),
    ]) {
      const held = tickets[otherKey]
      if (held === undefined || !holdsState(name, held)) continue
      issues.push({
        key,
        otherKey,
        name,
        held,
        message: `${key} "${name}" names the same state as the ${other} role (${otherKey} is "${held}"); the ${role} and ${other} roles must name different states`,
      })
    }
  }
  return issues
}

/** Project policy is separate from CRUD context and cannot be supplied by delegates. */
export const hostedTicketPolicySchema = z.strictObject({
  version: z.literal(1),
  tickets: z
    .strictObject({
      source: z.literal('hosted'),
      teamKey: z.string().min(1),
      readyState: policyStateSchema,
      triageState: policyStateSchema,
      claimedState: policyStateSchema,
      doneState: policyStateSchema,
      createState: policyStateSchema,
      proposalState: policyStateSchema,
      readyLabels: z.array(z.string().min(1)).optional(),
      backlogState: policyStateSchema.optional(),
      rejectedState: policyStateSchema.optional(),
    })
    .superRefine((tickets, ctx) => {
      for (const issue of policyRoleOverlaps(tickets))
        ctx.addIssue({
          code: 'custom',
          path: [issue.key],
          message: issue.message,
        })
    }),
})
export type HostedTicketPolicy = z.infer<typeof hostedTicketPolicySchema>

const POLICY_ROLE_KEYS = ['backlogState', 'rejectedState'] as const

/** The policy a publish stores. `replace` (a roles-aware client) stores the
 * publish as the complete policy. `retain-roles` (a client predating the roles)
 * fills each absent role from the saved policy; when a retained role would then
 * collide with a lifecycle name that publish just set, the saved policy is kept
 * unchanged and `kept` names the collisions, so a mapping is never erased. */
export function publishedTicketPolicy(
  previous: HostedTicketPolicy | null | undefined,
  incoming: HostedTicketPolicy,
  mode: 'replace' | 'retain-roles',
): { policy: HostedTicketPolicy; kept?: string[] } {
  if (mode === 'replace' || !previous) return { policy: incoming }
  const retained = Object.fromEntries(
    POLICY_ROLE_KEYS.flatMap((key) =>
      incoming.tickets[key] === undefined && previous.tickets[key] !== undefined
        ? [[key, previous.tickets[key]]]
        : [],
    ),
  )
  if (Object.keys(retained).length === 0) return { policy: incoming }
  const merged = { ...incoming, tickets: { ...incoming.tickets, ...retained } }
  // The publish alone was valid, so every overlap involves a retained role.
  const collisions = policyRoleOverlaps(merged.tickets)
  if (collisions.length > 0)
    return {
      policy: previous,
      kept: collisions.map((issue) => {
        const [saved, published] =
          issue.key in retained
            ? [issue, { key: issue.otherKey, name: issue.held }]
            : [{ key: issue.otherKey, name: issue.held }, issue]
        return `legacy publish names ${published.key} "${published.name}", which the saved ${saved.key} holds`
      }),
    }
  return { policy: hostedTicketPolicySchema.parse(merged) }
}

/** Policy as a reader sees it: clients predating the roles decode strictly. */
export function projectTicketPolicy(
  policy: HostedTicketPolicy,
  rolesAware: boolean,
): HostedTicketPolicy {
  if (rolesAware) return policy
  const { backlogState: _backlog, rejectedState: _rejected, ...tickets } = policy.tickets
  return { ...policy, tickets }
}

export const ticketGrantSchema = z.strictObject({
  id: z.string().min(1),
  repo: z.string().min(1),
  execution: z.string().min(1),
  kind: z.enum(['runner', 'phase']),
  parent: z.string().nullable(),
  expiresAt: z.string().datetime(),
})
export const ticketGrantResponseSchema = z.strictObject({
  token: z.string().startsWith('abt_'),
  grant: ticketGrantSchema,
})

export const ticketStateWireSchema = z.strictObject({
  name: z.string(),
  tickets: z.number().int().nonnegative(),
  about: z.string().optional(),
})
export const ticketStatesWireSchema = z.array(ticketStateWireSchema)
/** `state-counts` answers per-state totals only, never ticket rows. */
export const ticketStateCountWireSchema = z.strictObject({
  name: z.string().min(1),
  tickets: z.number().int().nonnegative(),
})
export const ticketStateCountsWireSchema = z.array(ticketStateCountWireSchema)
export const ticketStateCreateWireSchema = z.strictObject({
  state: ticketStateWireSchema,
  created: z.boolean(),
})
