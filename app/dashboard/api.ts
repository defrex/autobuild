import type {
  OperatorAnswerRequest,
  OperatorBuildControlRequest,
  OperatorDashboardSnapshot,
  OperatorTicketCreateRequest,
  OperatorTicketDetail,
  OperatorTicketQueue,
  OperatorTicketUpdateRequest,
} from 'autobuild/operator-api'

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
export const tickets = (
  repo: string,
  filters: { state?: string; labels?: string[] } = {},
  signal?: AbortSignal,
) => {
  const query = new URLSearchParams()
  if (filters.state !== undefined) query.set('state', filters.state)
  for (const label of filters.labels ?? []) query.append('label', label)
  return webRequest<OperatorTicketQueue>(repo, `tickets${query.size ? `?${query}` : ''}`, {
    signal,
  })
}
export const ticket = (repo: string, id: string, signal?: AbortSignal) =>
  webRequest<OperatorTicketDetail>(repo, `tickets/${encodeURIComponent(id)}`, { signal })
export const createTicket = (repo: string, value: OperatorTicketCreateRequest) =>
  webRequest<OperatorTicketDetail>(repo, 'tickets', { method: 'POST', body: JSON.stringify(value) })
export const updateTicket = (repo: string, id: string, value: OperatorTicketUpdateRequest) =>
  webRequest<OperatorTicketDetail>(repo, `tickets/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body: JSON.stringify(value),
  })
export const moveTicket = (repo: string, id: string, state: string) =>
  webRequest<OperatorTicketDetail>(repo, `tickets/${encodeURIComponent(id)}/move`, {
    method: 'POST',
    body: JSON.stringify({ state }),
  })
export const changeBlockers = (
  repo: string,
  id: string,
  blockerIds: string[],
  operation: 'block' | 'unblock',
) =>
  webRequest<OperatorTicketDetail>(repo, `tickets/${encodeURIComponent(id)}/${operation}`, {
    method: 'POST',
    body: JSON.stringify({ blockerIds }),
  })

export const buildControl = (repo: string, slug: string, body: OperatorBuildControlRequest) =>
  webRequest(repo, `builds/${encodeURIComponent(slug)}/control`, {
    method: 'POST',
    body: JSON.stringify(body),
  })
export const answerBuild = (repo: string, slug: string, body: OperatorAnswerRequest) =>
  webRequest(repo, `builds/${encodeURIComponent(slug)}/answer`, {
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
