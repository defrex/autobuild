import {
  operatorErrorSchema,
  type BuildControlResult,
  type BulkControlSummary,
  type HarvestStatusView,
  type RepositoryStatus,
  type BuildSummary,
  type OperatorBuildView,
  type OperatorDashboardSnapshot,
  type OperatorTicketDetail,
  type OperatorTicketQueue,
  type OperatorAnswerRequest,
  type OperatorBuildControlRequest,
  type OperatorTicketBlockerRequest,
  type OperatorTicketCreateRequest,
  type OperatorTicketMoveRequest,
  type OperatorTicketUpdateRequest,
  type OperatorSessionApprovalRequest,
  type OperatorSessionCreateRequest,
  type OperatorSessionMessageRequest,
  type OperatorSessionWakeRequest,
} from '@defrex/autobuild/operator'
import {
  AUTOBUILD_VERSION,
  AUTOBUILD_VERSION_HEADER,
  REMOTE_STORE_PROTOCOL_VERSION,
  REMOTE_STORE_PROTOCOL_VERSION_HEADER,
} from '@defrex/autobuild/remote-store'
import type { SessionRecord, StreamRead } from '@defrex/autobuild/plugin-sdk'
import type { OperatorSessionView } from './operator-sessions'

export class OperatorApiError extends Error {
  constructor(
    readonly status: number,
    readonly kind: string,
    readonly code?: string,
    readonly progress?: unknown,
  ) {
    super(kind)
    this.name = 'OperatorApiError'
  }
}

export interface OperatorApiClientOptions {
  url: string
  token: string
  fetchFn?: typeof fetch
}

export interface DownloadedArtifact {
  content: Uint8Array
  kind: string
  revision: number
  blobRef: string
  disposition?: string
}

export class OperatorApiClient {
  private readonly base: string
  private readonly fetchFn: typeof fetch
  constructor(private readonly options: OperatorApiClientOptions) {
    this.base = options.url.replace(/\/+$/, '')
    this.fetchFn = options.fetchFn ?? fetch
  }

  private repoPath(repo: string, suffix: string): string {
    return `/operator/v1/repos/${encodeURIComponent(repo)}/${suffix}`
  }

  private async request<T>(repo: string, suffix: string, init: RequestInit = {}): Promise<T> {
    const headers = new Headers(init.headers)
    headers.set(AUTOBUILD_VERSION_HEADER, AUTOBUILD_VERSION)
    headers.set(REMOTE_STORE_PROTOCOL_VERSION_HEADER, REMOTE_STORE_PROTOCOL_VERSION)
    headers.set('authorization', `Bearer ${this.options.token}`)
    if (init.body !== undefined) headers.set('content-type', 'application/json')
    const response = await this.fetchFn(`${this.base}${this.repoPath(repo, suffix)}`, {
      ...init,
      headers,
    })
    if (!response.ok) {
      const parsed = operatorErrorSchema.safeParse(await response.json().catch(() => null))
      if (!parsed.success) throw new Error(`operator API returned HTTP ${response.status}`)
      const error = new OperatorApiError(
        response.status,
        parsed.data.kind,
        parsed.data.code,
        parsed.data.progress,
      )
      error.message = parsed.data.error
      throw error
    }
    return (await response.json()) as T
  }

  listBuilds(repo: string, scope: 'active' | 'queued' | 'all' = 'active'): Promise<BuildSummary[]> {
    return this.request(repo, `builds?scope=${scope}`)
  }
  getBuild(repo: string, slug: string): Promise<OperatorBuildView> {
    return this.request(repo, `builds/${encodeURIComponent(slug)}`)
  }
  dashboard(repo: string): Promise<OperatorDashboardSnapshot> {
    return this.request(repo, 'dashboard')
  }
  repositoryStatus(repo: string): Promise<RepositoryStatus> {
    return this.request(repo, 'status')
  }
  harvestStatus(repo: string): Promise<HarvestStatusView> {
    return this.request(repo, 'harvest/status')
  }
  listTickets(
    repo: string,
    filters: { state?: string; labels?: string[] } = {},
  ): Promise<OperatorTicketQueue> {
    const query = new URLSearchParams()
    if (filters.state !== undefined) query.set('state', filters.state)
    for (const label of filters.labels ?? []) query.append('label', label)
    const suffix = query.size > 0 ? `tickets?${query}` : 'tickets'
    return this.request(repo, suffix)
  }
  getTicket(repo: string, id: string): Promise<OperatorTicketDetail> {
    return this.request(repo, `tickets/${encodeURIComponent(id)}`)
  }
  createTicket(repo: string, request: OperatorTicketCreateRequest): Promise<OperatorTicketDetail> {
    return this.request(repo, 'tickets', { method: 'POST', body: JSON.stringify(request) })
  }
  updateTicket(
    repo: string,
    id: string,
    request: OperatorTicketUpdateRequest,
  ): Promise<OperatorTicketDetail> {
    return this.request(repo, `tickets/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: JSON.stringify(request),
    })
  }
  moveTicket(
    repo: string,
    id: string,
    request: OperatorTicketMoveRequest,
  ): Promise<OperatorTicketDetail> {
    return this.request(repo, `tickets/${encodeURIComponent(id)}/move`, {
      method: 'POST',
      body: JSON.stringify(request),
    })
  }
  blockTicket(
    repo: string,
    id: string,
    request: OperatorTicketBlockerRequest,
  ): Promise<OperatorTicketDetail> {
    return this.request(repo, `tickets/${encodeURIComponent(id)}/block`, {
      method: 'POST',
      body: JSON.stringify(request),
    })
  }
  unblockTicket(
    repo: string,
    id: string,
    request: OperatorTicketBlockerRequest,
  ): Promise<OperatorTicketDetail> {
    return this.request(repo, `tickets/${encodeURIComponent(id)}/unblock`, {
      method: 'POST',
      body: JSON.stringify(request),
    })
  }
  listSessions(repo: string): Promise<SessionRecord[]> {
    return this.request(repo, 'sessions')
  }
  createSession(repo: string, request: OperatorSessionCreateRequest): Promise<SessionRecord> {
    return this.request(repo, 'sessions', { method: 'POST', body: JSON.stringify(request) })
  }
  getSession(repo: string, sid: string): Promise<OperatorSessionView> {
    return this.request(repo, `sessions/${encodeURIComponent(sid)}`)
  }
  postSessionMessage(
    repo: string,
    sid: string,
    request: OperatorSessionMessageRequest,
  ): Promise<{ ok: boolean }> {
    return this.request(repo, `sessions/${encodeURIComponent(sid)}/messages`, {
      method: 'POST',
      body: JSON.stringify(request),
    })
  }
  setSessionWake(
    repo: string,
    sid: string,
    request: OperatorSessionWakeRequest,
  ): Promise<{ ok: boolean }> {
    return this.request(repo, `sessions/${encodeURIComponent(sid)}/wake`, {
      method: 'PUT',
      body: JSON.stringify(request),
    })
  }
  answerSessionApproval(
    repo: string,
    sid: string,
    request: OperatorSessionApprovalRequest,
  ): Promise<{ ok: boolean }> {
    return this.request(repo, `sessions/${encodeURIComponent(sid)}/approvals`, {
      method: 'POST',
      body: JSON.stringify(request),
    })
  }
  archiveSession(repo: string, sid: string): Promise<{ ok: boolean }> {
    return this.request(repo, `sessions/${encodeURIComponent(sid)}/archive`, {
      method: 'POST',
    })
  }
  readSessionTurnStream(
    repo: string,
    sid: string,
    turn: string,
    opts: { since?: number; waitSeconds?: number } = {},
  ): Promise<StreamRead> {
    const query = new URLSearchParams({ since: String(opts?.since ?? 0) })
    if (opts?.waitSeconds !== undefined) query.set('wait', String(opts.waitSeconds))
    return this.request(
      repo,
      `sessions/${encodeURIComponent(sid)}/turns/${encodeURIComponent(turn)}/stream?${query}`,
    )
  }
  controlBuild(
    repo: string,
    slug: string,
    request: OperatorBuildControlRequest,
  ): Promise<BuildControlResult> {
    return this.request(repo, `builds/${encodeURIComponent(slug)}/control`, {
      method: 'POST',
      body: JSON.stringify(request),
    })
  }
  /** The registry's generic protocol face: execute any tool from the closed
   * table by name. The body is the tool's input (repo included); failures
   * parse into OperatorApiError exactly like the typed routes. */
  callTool(repo: string, tool: string, input: unknown): Promise<unknown> {
    return this.request(repo, `tools/${encodeURIComponent(tool)}`, {
      method: 'POST',
      body: JSON.stringify(input),
    })
  }
  answer(repo: string, slug: string, request: OperatorAnswerRequest): Promise<BuildControlResult> {
    return this.request(repo, `builds/${encodeURIComponent(slug)}/answer`, {
      method: 'POST',
      body: JSON.stringify(request),
    })
  }
  setIntake(repo: string, enabled: boolean): Promise<unknown> {
    return this.request(repo, 'settings/intake', {
      method: 'PUT',
      body: JSON.stringify({ enabled }),
    })
  }
  toggleIntake(repo: string): Promise<unknown> {
    return this.request(repo, 'settings/intake/toggle', { method: 'POST' })
  }
  setAutoMergeDefault(repo: string, enabled: boolean): Promise<unknown> {
    return this.request(repo, 'settings/auto-merge-default', {
      method: 'PUT',
      body: JSON.stringify({ enabled }),
    })
  }
  toggleAutoMergeDefault(repo: string): Promise<unknown> {
    return this.request(repo, 'settings/auto-merge-default/toggle', { method: 'POST' })
  }
  bulkControl(repo: string, action: 'pause' | 'resume'): Promise<BulkControlSummary> {
    return this.request(repo, 'bulk-control', { method: 'POST', body: JSON.stringify({ action }) })
  }
  toggleHarvest(repo: string): Promise<unknown> {
    return this.request(repo, 'harvest/control', {
      method: 'POST',
      body: JSON.stringify({ action: 'toggle-gate' }),
    })
  }
  controlHarvestRun(repo: string, run: string): Promise<unknown> {
    return this.request(repo, 'harvest/control', {
      method: 'POST',
      body: JSON.stringify({ action: 'run', run }),
    })
  }
  async downloadArtifact(
    repo: string,
    slug: string,
    kind: string,
    rev?: number,
  ): Promise<DownloadedArtifact> {
    const suffix = `builds/${encodeURIComponent(slug)}/artifacts/${encodeURIComponent(kind)}${rev === undefined ? '' : `?rev=${rev}`}`
    const headers = new Headers({
      [AUTOBUILD_VERSION_HEADER]: AUTOBUILD_VERSION,
      [REMOTE_STORE_PROTOCOL_VERSION_HEADER]: REMOTE_STORE_PROTOCOL_VERSION,
      authorization: `Bearer ${this.options.token}`,
    })
    const response = await this.fetchFn(`${this.base}${this.repoPath(repo, suffix)}`, { headers })
    if (!response.ok) {
      const parsed = operatorErrorSchema.parse(await response.json())
      const error = new OperatorApiError(response.status, parsed.kind, parsed.code, parsed.progress)
      error.message = parsed.error
      throw error
    }
    return {
      content: new Uint8Array(await response.arrayBuffer()),
      kind: response.headers.get('x-autobuild-artifact-kind') ?? kind,
      revision: Number(response.headers.get('x-autobuild-artifact-revision')),
      blobRef: response.headers.get('x-autobuild-artifact-blob-ref') ?? '',
      ...(response.headers.get('content-disposition') !== null
        ? { disposition: response.headers.get('content-disposition')! }
        : {}),
    }
  }
}
