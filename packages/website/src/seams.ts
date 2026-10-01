export type Side = 'local' | 'remote'

export interface Adapter {
  id: string
  label: string
  /** Which side of the local/remote toggle the adapter sits on; absent when neutral. */
  side?: Side
}

export interface Seam {
  id: string
  name: string
  caption: string
  adapters: Adapter[]
  /** The dashed, non-selectable open-seam entry. */
  open?: string
}

export const SEAMS: Seam[] = [
  {
    id: 'tickets',
    name: 'tickets',
    caption: 'where work comes from',
    adapters: [
      { id: 'local-files', label: 'local files', side: 'local' },
      { id: 'linear', label: 'Linear', side: 'remote' },
      { id: 'hosted', label: 'hosted' },
    ],
    open: '+ plugin',
  },
  {
    id: 'dispatcher',
    name: 'dispatcher',
    caption: 'what starts builds',
    adapters: [
      { id: 'local-process', label: 'local process', side: 'local' },
      { id: 'cron', label: 'cron', side: 'remote' },
    ],
  },
  {
    id: 'workspace',
    name: 'workspace',
    caption: 'where a build runs',
    adapters: [
      { id: 'git-worktree', label: 'git worktree', side: 'local' },
      { id: 'vercel-sandbox', label: 'Vercel Sandbox', side: 'remote' },
    ],
    open: '+ plugin',
  },
  {
    id: 'runtime',
    name: 'runtime',
    caption: 'who does the thinking',
    adapters: [
      { id: 'claude-code', label: 'Claude Code' },
      { id: 'codex', label: 'Codex' },
      { id: 'pi', label: 'pi' },
    ],
    open: '+ plugin',
  },
  {
    id: 'forge',
    name: 'forge',
    caption: 'where code lands',
    adapters: [
      { id: 'local-git', label: 'local git', side: 'local' },
      { id: 'github', label: 'GitHub', side: 'remote' },
    ],
    open: '+ plugin',
  },
  {
    id: 'store',
    name: 'store',
    caption: 'where state lives',
    adapters: [
      { id: 'sqlite', label: 'SQLite', side: 'local' },
      { id: 'postgres', label: 'Postgres', side: 'remote' },
    ],
    open: '+ HTTP protocol',
  },
  {
    id: 'operators',
    name: 'operators',
    caption: 'how you watch',
    adapters: [
      { id: 'terminal', label: 'terminal', side: 'local' },
      { id: 'web-ui', label: 'web UI', side: 'remote' },
      { id: 'mcp', label: 'MCP' },
    ],
  },
]

/** seam id -> selected adapter id; exactly one per seam. */
export type SeamState = Record<string, string>

const seamById = (id: string): Seam | undefined => SEAMS.find((s) => s.id === id)

function adapterFor(seam: Seam, side: Side): Adapter | undefined {
  return seam.adapters.find((a) => a.side === side)
}

export function initialState(): SeamState {
  const state: SeamState = {}
  for (const seam of SEAMS) {
    state[seam.id] = (adapterFor(seam, 'local') ?? seam.adapters[0])?.id ?? ''
  }
  return state
}

export function selectAdapter(state: SeamState, seamId: string, adapterId: string): SeamState {
  const seam = seamById(seamId)
  if (!seam?.adapters.some((a) => a.id === adapterId)) return state
  return { ...state, [seamId]: adapterId }
}

/** Seams without a local and a remote side (runtime) keep their selection. */
export function setAll(state: SeamState, side: Side): SeamState {
  const next = { ...state }
  for (const seam of SEAMS) {
    const target = adapterFor(seam, side)
    if (target && adapterFor(seam, side === 'local' ? 'remote' : 'local')) {
      next[seam.id] = target.id
    }
  }
  return next
}

export interface Summary {
  remoteCount: number
  total: number
  knob: number
  label: string
}

export function summary(state: SeamState): Summary {
  let remoteCount = 0
  let total = 0
  for (const seam of SEAMS) {
    if (!adapterFor(seam, 'local') || !adapterFor(seam, 'remote')) continue
    total += 1
    if (adapterFor(seam, 'remote')?.id === state[seam.id]) remoteCount += 1
  }
  const label =
    remoteCount === 0
      ? 'fully local'
      : remoteCount === total
        ? 'fully remote'
        : `${remoteCount} of ${total} seams remote`
  return { remoteCount, total, knob: total === 0 ? 0 : remoteCount / total, label }
}

export function toggleTrack(state: SeamState): SeamState {
  const { remoteCount, total } = summary(state)
  return setAll(state, remoteCount === total ? 'local' : 'remote')
}
