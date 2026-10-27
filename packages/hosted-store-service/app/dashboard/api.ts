import type { ProjectSettings } from '../../src/web/project-secrets'
import type {
  OperatorAnswerRequest,
  OperatorApiClient,
  OperatorBuildControlRequest,
  OperatorDashboardSnapshot,
  OperatorTicketDetail,
  OperatorTicketMoveRequest,
  OperatorTicketPage,
  OperatorTicketQueue,
} from '@defrex/autobuild-hosted-store-service/operator-api'

export class WebOperatorError extends Error {
  constructor(
    readonly status: number,
    readonly kind: string,
    message: string,
    readonly progress?: unknown,
  ) {
    super(message)
  }
}

export async function webRequest<T>(repo: string, path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`/api/web/repos/${encodeURIComponent(repo)}/${path}`, {
    ...init,
    cache: 'no-store',
    headers: { ...(init?.body ? { 'content-type': 'application/json' } : {}), ...init?.headers },
  })
  if (response.status === 401) {
    window.location.assign('/sign-in')
    throw new WebOperatorError(401, 'auth', 'sign in required')
  }
  if (!response.ok) {
    const value = (await response.json().catch(() => ({}))) as {
      kind?: string
      error?: string
      progress?: unknown
    }
    throw new WebOperatorError(
      response.status,
      value.kind ?? 'error',
      value.error ?? `request failed (${response.status})`,
      value.progress,
    )
  }
  return response.json() as Promise<T>
}

export const dashboard = (repo: string, signal?: AbortSignal) =>
  webRequest<OperatorDashboardSnapshot>(repo, 'dashboard', { signal })
/** Without `state`, the queue lists Triage; every listing names the lifecycle states. */
export const tickets = (
  repo: string,
  state: string | undefined,
  page: OperatorTicketPage,
  signal?: AbortSignal,
) => {
  const query = new URLSearchParams()
  if (state !== undefined) query.set('state', state)
  query.set('limit', String(page.limit))
  if (page.offset !== undefined) query.set('offset', String(page.offset))
  if (page.order !== undefined) query.set('order', page.order)
  return webRequest<OperatorTicketQueue>(repo, `tickets?${query}`, { signal })
}
/** Every state the source knows, with how many tickets each holds. */
export const ticketStates = (repo: string, signal?: AbortSignal) =>
  webRequest<{ name: string; tickets: number; about?: string }[]>(repo, 'tickets/states', {
    signal,
  })
export const ticket = (repo: string, id: string, signal?: AbortSignal) =>
  webRequest<OperatorTicketDetail>(repo, `tickets/${encodeURIComponent(id)}`, { signal })
export const moveTicket = (repo: string, id: string, body: OperatorTicketMoveRequest) =>
  webRequest<OperatorTicketDetail>(repo, `tickets/${encodeURIComponent(id)}/move`, {
    method: 'POST',
    body: JSON.stringify(body),
  })
type BuildControlResult = Awaited<ReturnType<OperatorApiClient['controlBuild']>>

export const buildControl = (repo: string, slug: string, body: OperatorBuildControlRequest) =>
  webRequest<BuildControlResult>(repo, `builds/${encodeURIComponent(slug)}/control`, {
    method: 'POST',
    body: JSON.stringify(body),
  })
export const answerBuild = (repo: string, slug: string, body: OperatorAnswerRequest) =>
  webRequest<BuildControlResult>(repo, `builds/${encodeURIComponent(slug)}/answer`, {
    method: 'POST',
    body: JSON.stringify(body),
  })
export const setting = (repo: string, name: 'intake' | 'auto-merge-default', enabled: boolean) =>
  webRequest(repo, `settings/${name}`, { method: 'PUT', body: JSON.stringify({ enabled }) })
export const bulk = (repo: string, action: 'pause' | 'resume') =>
  webRequest(repo, 'bulk-control', { method: 'POST', body: JSON.stringify({ action }) })
export const harvest = (
  repo: string,
  body: { action: 'toggle-gate' } | { action: 'run'; run: string },
) => webRequest(repo, 'harvest/control', { method: 'POST', body: JSON.stringify(body) })

/** Browser secrets use the cookie session, never a project machine credential. */
export const projectSettings = (repo: string) => webRequest<ProjectSettings>(repo, 'secrets')
export const setProjectSecret = (repo: string, name: string, value: string) =>
  webRequest(repo, 'secrets/set', { method: 'POST', body: JSON.stringify({ name, value }) })
export const removeProjectSecret = (repo: string, name: string) =>
  webRequest(repo, 'secrets/remove', { method: 'POST', body: JSON.stringify({ name }) })
