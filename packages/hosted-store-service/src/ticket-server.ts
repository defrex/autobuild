import { z } from 'zod'
import type { TicketGrantStore } from '@defrex/autobuild-postgres-store/ticket-grants'
import { normalizeProjectRepository } from '@defrex/autobuild-postgres-store/projects'
import { OperatorQueryError } from '@defrex/autobuild/operator'
import {
  createMachineAuth,
  MachineAuthError,
  requireMachineAccess,
  type MachineAuth,
  type MachinePrincipal,
  requireProject,
} from './machine-auth'
import { systemClock, type Clock, type TicketSource } from '@defrex/autobuild/plugin-sdk'
import {
  clientIdentityError,
  stableVersion,
  AUTOBUILD_VERSION_HEADER,
  REMOTE_STORE_PROTOCOL_VERSION_HEADER,
  type ErrorBody,
  type ErrorKind,
} from '@defrex/autobuild/remote-store'
import {
  hostedTicketRequestSchemas,
  hostedTicketPolicySchema,
  type HostedTicketPolicy,
  type HostedTicketContext,
  type HostedTicketOperation,
} from '@defrex/autobuild/hosted-tickets'

export interface TicketServerOptions {
  secret: string
  auth?: MachineAuth
  sourceFor(
    context: HostedTicketContext,
    principal: MachinePrincipal,
  ): TicketSource | Promise<TicketSource>
  statesFor?: (
    context: HostedTicketContext,
    principal: MachinePrincipal,
    source: TicketSource,
  ) => Promise<string[]>
  grants?: TicketGrantStore
  policy?: {
    get(repo: string): Promise<HostedTicketPolicy | null>
    put(repo: string, policy: HostedTicketPolicy, writer: string): Promise<void>
  }
  clock?: Clock
  /** Observes unexpected source failures without changing their wire response. */
  onInternalError?: (error: unknown, request: Request) => unknown | Promise<unknown>
}

class TicketRequestError extends Error {
  constructor(
    readonly status: number,
    readonly kind: ErrorKind,
    message: string,
  ) {
    super(message)
  }
}

function json(status: number, body: unknown): Response {
  return Response.json(body, { status })
}

function failure(status: number, kind: ErrorKind, error: string): Response {
  return json(status, { error, kind } satisfies ErrorBody)
}

/** HTTP face of the TicketSource port. Authentication deliberately runs before
 * JSON parsing and source construction, so denied callers cannot probe either. */
export function createTicketServer(options: TicketServerOptions): {
  fetch(req: Request): Promise<Response>
} {
  const clock = options.clock ?? systemClock

  function identify(req: Request): void {
    const autobuild = req.headers.get(AUTOBUILD_VERSION_HEADER)
    const protocol = req.headers.get(REMOTE_STORE_PROTOCOL_VERSION_HEADER)
    const mismatch = clientIdentityError(autobuild, protocol)
    if (mismatch !== undefined) {
      throw new TicketRequestError(409, 'conflict', mismatch)
    }
  }

  const auth =
    options.auth ??
    createMachineAuth({
      secret: options.secret,
      clock,
      credentials: { authenticate: async () => null },
      projects: { has: async () => false, list: async () => [] },
    })
  async function authenticate(req: Request): Promise<MachinePrincipal> {
    const token = /^Bearer\s+(.+)$/i.exec(req.headers.get('authorization') ?? '')?.[1]
    if (token?.startsWith('abt_')) {
      const grant = await options.grants?.authenticate(token, clock())
      if (!grant) throw new MachineAuthError(401, 'ticket grant expired or revoked')
      return { kind: 'ticket-grant', repo: grant.repo, user: 'ticket-grant', grant }
    }
    return auth.authenticate(req)
  }
  async function authorize(
    req: Request,
    operation: HostedTicketOperation,
  ): Promise<MachinePrincipal> {
    const principal = await authenticate(req)
    if (principal.kind === 'ticket-grant') {
      const read = ['get', 'list-ready', 'dependency-states', 'states'].includes(operation)
      if (read || (principal.grant.kind === 'runner' && operation === 'create')) return principal
      throw new MachineAuthError(403, 'ticket grant cannot perform this operation')
    }
    requireMachineAccess(principal)
    if (principal.kind !== 'delegated') return principal
    const kind = principal.delegation.kind
    const read =
      operation === 'get' ||
      operation === 'list-ready' ||
      operation === 'dependency-states' ||
      operation === 'states'
    if (
      ((kind === 'harvest-runner' || kind === 'harvest-phase') && read) ||
      (kind === 'harvest-runner' && operation === 'create')
    )
      return principal
    throw new MachineAuthError(
      403,
      `delegated ${kind} credential cannot perform ticket operation ${operation}`,
    )
  }

  async function body(req: Request): Promise<unknown> {
    try {
      return await req.json()
    } catch {
      throw new TicketRequestError(400, 'validation', 'request body is not valid JSON')
    }
  }

  async function route(
    req: Request,
    operation: HostedTicketOperation,
    principal: MachinePrincipal,
  ): Promise<Response> {
    const raw = await body(req)
    const parsed = hostedTicketRequestSchemas[operation].safeParse(raw)
    if (!parsed.success) {
      throw new TicketRequestError(
        400,
        'validation',
        `invalid request body: ${parsed.error.message}`,
      )
    }
    const context = { ...parsed.data.context }
    if (context.repo !== undefined) {
      try {
        context.repo = normalizeProjectRepository(context.repo)
      } catch {
        throw new TicketRequestError(
          400,
          'validation',
          'context.repo must name a normalized repository origin',
        )
      }
      requireProject(principal, context.repo)
    }
    const source = await options.sourceFor(context, principal)

    // Both v0.9 and v0.10 use strict ticket decoders without resolution fields.
    // Project only the ticket boundary; current domain values remain authoritative.
    const client = stableVersion(req.headers.get(AUTOBUILD_VERSION_HEADER))!
    const ticketResponse = (ticket: Awaited<ReturnType<TicketSource['get']>>) => {
      if (ticket === null || client.major !== 0 || client.minor > 10) return ticket
      const { resolved: _resolved, blockersResolved: _blockersResolved, ...legacy } = ticket
      return legacy
    }

    // Parse again through the operation-specific schema to preserve precise
    // inference in each branch while keeping the shared pre-source validation.
    switch (operation) {
      case 'states': {
        const names = options.statesFor ? await options.statesFor(context, principal, source) : []
        const listing = await source.listReady({})
        return json(
          200,
          names.map((name) => ({
            name,
            tickets: listing.tickets.filter((ticket) => ticket.state === name).length,
          })),
        )
      }
      case 'list-ready': {
        const request = hostedTicketRequestSchemas['list-ready'].parse(raw)
        const listing = await source.listReady(request.input)
        return json(200, { ...listing, tickets: listing.tickets.map(ticketResponse) })
      }
      case 'get': {
        const request = hostedTicketRequestSchemas.get.parse(raw)
        return json(200, ticketResponse(await source.get(request.input.id)))
      }
      case 'claim': {
        const request = hostedTicketRequestSchemas.claim.parse(raw)
        return json(200, { claimed: await source.claim(request.input.id) })
      }
      case 'comment': {
        const request = hostedTicketRequestSchemas.comment.parse(raw)
        await source.comment(request.input.id, request.input.body)
        return json(200, { ok: true })
      }
      case 'transition': {
        const request = hostedTicketRequestSchemas.transition.parse(raw)
        await source.transition(request.input.id, request.input.state)
        return json(200, { ok: true })
      }
      case 'create': {
        const request = hostedTicketRequestSchemas.create.parse(raw)
        return json(
          201,
          ticketResponse(await source.create(request.input.draft, request.input.options)),
        )
      }
      case 'update': {
        const request = hostedTicketRequestSchemas.update.parse(raw)
        await source.update(request.input.id, request.input.patch)
        return json(200, { ok: true })
      }
      case 'add-blocker': {
        const request = hostedTicketRequestSchemas['add-blocker'].parse(raw)
        await source.addBlocker(request.input.id, request.input.blockerId)
        return json(200, { ok: true })
      }
      case 'remove-blocker': {
        const request = hostedTicketRequestSchemas['remove-blocker'].parse(raw)
        await source.removeBlocker(request.input.id, request.input.blockerId)
        return json(200, { ok: true })
      }
      case 'dependency-states': {
        const request = hostedTicketRequestSchemas['dependency-states'].parse(raw)
        return json(200, await source.dependencyStates(request.input.ids))
      }
    }
  }

  return {
    async fetch(req: Request): Promise<Response> {
      try {
        const url = new URL(req.url)
        if (req.method !== 'POST' || !url.pathname.startsWith('/tickets/')) {
          return failure(404, 'not-found', `no route: ${req.method} ${url.pathname}`)
        }
        identify(req)
        if (url.pathname === '/tickets/grants') {
          const principal = await authenticate(req)
          const parsed = z
            .strictObject({
              action: z.enum(['issue', 'renew', 'revoke']),
              repo: z.string().min(1),
              execution: z.string().min(1).optional(),
              kind: z.enum(['runner', 'phase']).optional(),
              id: z.string().optional(),
            })
            .safeParse(await body(req))
          if (!parsed.success || !options.grants)
            throw new TicketRequestError(400, 'validation', 'invalid ticket grant request')
          const input = parsed.data
          try {
            input.repo = normalizeProjectRepository(input.repo)
          } catch {
            throw new TicketRequestError(400, 'validation', 'invalid project repository')
          }
          if (!input.id && principal.kind === 'ticket-grant') input.id = principal.grant.id
          requireProject(principal, input.repo)
          const project = principal.kind === 'project' || principal.kind === 'admin'
          if (input.action === 'issue') {
            if (
              !input.execution ||
              !input.kind ||
              (project && input.kind !== 'runner') ||
              (principal.kind === 'ticket-grant' &&
                input.execution !== principal.grant.execution) ||
              (!project &&
                !(
                  principal.kind === 'ticket-grant' &&
                  principal.grant.kind === 'runner' &&
                  input.kind === 'phase'
                ))
            )
              throw new MachineAuthError(403, 'ticket grant issuance forbidden')
            return json(
              201,
              await options.grants.issue(
                input.repo,
                input.execution,
                input.kind,
                principal.kind === 'ticket-grant' ? principal.grant : null,
                clock(),
              ),
            )
          }
          if (
            !input.id ||
            (!project &&
              !(
                principal.kind === 'ticket-grant' &&
                principal.grant.id === input.id &&
                principal.grant.kind === 'runner'
              ))
          )
            throw new MachineAuthError(403, 'ticket grant administration forbidden')
          if (input.action === 'renew') await options.grants.renew(input.id, input.repo, clock())
          else await options.grants.revoke(input.id, input.repo)
          return json(200, { ok: true })
        }
        if (url.pathname === '/tickets/policy') {
          const principal = await authenticate(req)
          const raw = await body(req)
          const envelope = z
            .strictObject({
              context: z.strictObject({
                teamKey: z.string().min(1),
                repo: z.string().min(1).optional(),
                claimedState: z.string().optional(),
                createState: z.string().optional(),
              }),
              input: hostedTicketPolicySchema.nullable(),
            })
            .safeParse(raw)
          if (!envelope.success)
            throw new TicketRequestError(400, 'validation', 'invalid ticket policy envelope')
          const repo =
            envelope.data.context.repo ?? (principal.kind !== 'admin' ? principal.repo : undefined)
          if (!repo || !options.policy)
            throw new MachineAuthError(403, 'registered project policy is required')
          requireProject(principal, repo)
          if (envelope.data.input === null) {
            if (
              principal.kind === 'internal' ||
              (principal.kind === 'delegated' &&
                !['harvest-runner', 'harvest-phase'].includes(principal.delegation.kind))
            )
              throw new MachineAuthError(403, 'credential cannot read ticket policy')
            return json(200, await options.policy.get(repo))
          }
          if (principal.kind !== 'project' && principal.kind !== 'admin')
            throw new MachineAuthError(
              403,
              'only project or owner authority may publish ticket policy',
            )
          await options.policy.put(repo, envelope.data.input, principal.user)
          return json(200, { ok: true })
        }
        const operation = url.pathname.slice('/tickets/'.length) as HostedTicketOperation
        if (!Object.hasOwn(hostedTicketRequestSchemas, operation)) {
          return failure(404, 'not-found', `no route: ${req.method} ${url.pathname}`)
        }
        const principal = await authorize(req, operation)
        return await route(req, operation, principal)
      } catch (error) {
        if (error instanceof OperatorQueryError) return failure(409, 'conflict', error.message)
        if (error instanceof MachineAuthError) return failure(error.status, 'auth', error.message)
        if (error instanceof TicketRequestError) {
          return failure(error.status, error.kind, error.message)
        }
        // Only the message crosses the trust boundary; causes and stacks never do.
        const message = error instanceof Error ? error.message : 'ticket backend failed'
        const notFound = /unknown (?:ticket|issue)|not found/i.test(message)
        // These are intentional domain feedback from TicketSource implementations.
        // Their historical standalone mapping remains unchanged.
        const expectedDomainFailure =
          message.startsWith('invalid ticket update') || message.includes('cannot block itself')
        if (!notFound && !expectedDomainFailure && options.onInternalError !== undefined) {
          try {
            await options.onInternalError(error, req)
          } catch {
            // Diagnostics must never replace the protocol response.
          }
        }
        return failure(notFound ? 404 : 500, notFound ? 'not-found' : 'internal', message)
      }
    },
  }
}
