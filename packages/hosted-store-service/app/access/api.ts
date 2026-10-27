/** Browser contract: no server/database runtime imports. */
export interface Organization {
  id: string
  name: string
  slug: string
  ownerEmail: string | null
  membershipRole: 'owner' | 'member' | null
}
export interface Member {
  email: string
  name: string | null
  role: 'owner' | 'member'
  status: 'joined' | 'pending'
}
export interface Discovery {
  isSuperUser: boolean
  organizations: Organization[]
}
export interface Snapshot {
  organization: Organization
  projects: string[]
  members: Member[]
}
export class AccessRequestError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
  }
}
export async function request<T>(
  path: string,
  method = 'GET',
  body?: unknown,
  signal?: AbortSignal,
  headers?: Record<string, string>,
): Promise<T> {
  const response = await fetch(`/api/web/${path}`, {
    method,
    cache: 'no-store',
    signal,
    headers,
    ...(body === undefined
      ? {}
      : {
          headers: { 'content-type': 'application/json', ...headers },
          body: JSON.stringify(body),
        }),
  })
  if (response.status === 401) {
    window.location.assign('/sign-in')
    throw new AccessRequestError(401, 'sign in required')
  }
  const value = await response.json()
  if (!response.ok)
    throw new AccessRequestError(
      response.status,
      value.error ?? `request failed (${response.status})`,
    )
  return value as T
}
export const orgPath = (id: string) => `orgs/${encodeURIComponent(id)}`
export const membersLink = (id: string) => `/members?org=${encodeURIComponent(id)}`
export async function snapshot(id: string, signal?: AbortSignal): Promise<Snapshot> {
  const [inspection, roster] = await Promise.all([
    request<Omit<Snapshot, 'members'>>(orgPath(id), 'GET', undefined, signal),
    request<{ members: Member[] }>(`${orgPath(id)}/members`, 'GET', undefined, signal),
  ])
  return { ...inspection, members: roster.members }
}
export async function snapshots(
  organizations: Organization[],
  signal?: AbortSignal,
): Promise<Snapshot[]> {
  const result: Snapshot[] = []
  // Bound requests to four at a time, preserving discovery order.
  for (let i = 0; i < organizations.length; i += 2)
    result.push(
      ...(await Promise.all(organizations.slice(i, i + 2).map((org) => snapshot(org.id, signal)))),
    )
  return result
}
export function organizationSlug(name: string): string {
  const slug = name
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 100)
    .replace(/-$/, '')
  if (!slug) throw new Error('Use a name containing letters or numbers to create an organization.')
  return slug
}

export interface DeletionPreview {
  repo: string
  token: string
  builds: number
  tickets: number
  secrets: number
  subscriptionAccounts: number
}

/** Fresh server discovery includes fenced projects only in the management list. */
export async function projectManagement(isSuperUser: boolean, signal?: AbortSignal) {
  const discovery = await request<Discovery>('orgs', 'GET', undefined, signal)
  const [assigned, waiting, unfinished] = await Promise.all([
    snapshots(
      discovery.organizations.filter((org) => isSuperUser || org.membershipRole === 'owner'),
      signal,
    ),
    isSuperUser
      ? request<{ projects: string[] }>('projects/unassigned', 'GET', undefined, signal)
      : Promise.resolve(undefined),
    request<{ projects: string[] }>('projects/deletions', 'GET', undefined, signal),
  ])
  return {
    snapshots: assigned,
    unassigned: waiting?.projects,
    pendingDeletions: unfinished.projects,
  }
}
