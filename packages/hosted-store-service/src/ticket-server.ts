import { systemClock, type Clock, type TicketSource } from '@defrex/autobuild/plugin-sdk'
import {
  tokenResource,
  verifyToken,
  clientIdentityError,
  stableVersion,
  AUTOBUILD_VERSION_HEADER,
  REMOTE_STORE_PROTOCOL_VERSION_HEADER,
  type ErrorBody,
  type ErrorKind,
} from '@defrex/autobuild/remote-store'
import {
  hostedTicketRequestSchemas,
  type HostedTicketContext,
  type HostedTicketOperation,
} from '@defrex/autobuild/hosted-tickets'

export interface TicketServerOptions {
  secret: string
  sourceFor(context: HostedTicketContext): TicketSource | Promise<TicketSource>
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

  function authorize(req: Request): void {
    const match = /^Bearer\s+(.+)$/i.exec(req.headers.get('authorization') ?? '')
    if (!match) throw new TicketRequestError(401, 'auth', 'missing bearer token')
    const scope = verifyToken(options.secret, match[1]!, clock())
    if (scope === null) throw new TicketRequestError(401, 'auth', 'invalid or expired token')
    const resource = tokenResource(scope)
    if (resource.kind !== 'deployment') {
      throw new TicketRequestError(
        403,
        'auth',
        `token scoped to ${resource.kind} "${resource.id}" may not access ticket operations`,
      )
    }
  }

  async function body(req: Request): Promise<unknown> {
    try {
      return await req.json()
    } catch {
      throw new TicketRequestError(400, 'validation', 'request body is not valid JSON')
    }
  }

  async function route(req: Request, operation: HostedTicketOperation): Promise<Response> {
    const raw = await body(req)
    const parsed = hostedTicketRequestSchemas[operation].safeParse(raw)
    if (!parsed.success) {
      throw new TicketRequestError(
        400,
        'validation',
        `invalid request body: ${parsed.error.message}`,
      )
    }
    const context = parsed.data.context
    const source = await options.sourceFor(context)

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
        authorize(req)
        const operation = url.pathname.slice('/tickets/'.length) as HostedTicketOperation
        if (!Object.hasOwn(hostedTicketRequestSchemas, operation)) {
          return failure(404, 'not-found', `no route: ${req.method} ${url.pathname}`)
        }
        return await route(req, operation)
      } catch (error) {
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
