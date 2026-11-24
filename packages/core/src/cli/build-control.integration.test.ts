import { describe, expect, test } from 'bun:test'
import { agentActor, DISPATCHER, KERNEL } from '../events/envelope'
import type { EscalationSource } from '../ontology'
import type { Exec } from '../ports/workspace/git-worktree'
import { MemoryBuildStore } from '../store/memory'
import { steppingClock } from '../testing/fixed'
import {
  BuildControlError,
  abBuildControl,
  controlBuild,
  type BuildControlAction,
} from './build-control'

const REPO = '/repo'
const SLUG = 'active-build'

async function makeStore(
  opts: {
    slug?: string
    repo?: string
    active?: boolean
    ticket?: { source: string; id: string }
  } = {},
): Promise<MemoryBuildStore> {
  const slug = opts.slug ?? SLUG
  const store = new MemoryBuildStore({ clock: steppingClock() })
  await store.createBuild({
    slug,
    repo: opts.repo ?? REPO,
    ...(opts.ticket !== undefined ? { ticket: opts.ticket } : {}),
  })
  if (opts.active !== false) {
    await store.append(slug, {
      actor: KERNEL,
      type: 'runner.attached',
      payload: { instance: 'runner-1', host: 'host-1', resumedFromSeq: 0 },
    })
  }
  return store
}

async function raise(
  store: MemoryBuildStore,
  id: string,
  source: EscalationSource = 'agent',
  refs?: string[],
): Promise<void> {
  await store.append(SLUG, {
    actor: agentActor('implement', `session-${id}`),
    type: 'escalation.raised',
    payload: {
      id,
      phase: 'implement',
      round: 1,
      source,
      ...(source === 'policy' ? { policyCause: 'phase-attempt-limit' as const } : {}),
      question: `Question ${id}?`,
      ...(refs !== undefined ? { refs } : {}),
    },
  })
}

function eventTypes(store: MemoryBuildStore): Promise<string[]> {
  return store.getEvents(SLUG).then((events) => events.map((event) => event.type))
}

const CONFORMING_SPEC = [
  '# Replacement',
  '',
  '## Acceptance criteria',
  '- The replacement is used.',
  '',
  '## Out of scope',
  '- Nothing else.',
  '',
].join('\n')

async function seedSpec(store: MemoryBuildStore, body = 'old spec'): Promise<void> {
  const meta = await store.putArtifact(SLUG, { kind: 'spec', content: body })
  await store.append(SLUG, {
    actor: agentActor('spec', 'session-spec'),
    type: 'spec.authored',
    payload: { artifact: { kind: 'spec', rev: meta.revision }, session: 'session-spec' },
  })
}

describe('abBuildControl — sessionless repository/store shell', () => {
  const noGit: Exec = async () => ({
    stdout: '',
    stderr: 'not a git repo',
    exitCode: 128,
  })

  test('uses explicit store precedence, forwards the opaque remote token, and closes on success', async () => {
    const store = await makeStore()
    let closeCount = 0
    store.close = async () => {
      closeCount += 1
    }
    const opened: { ref: string; token?: string }[] = []

    await abBuildControl({
      targetRepo: REPO,
      env: {
        AB_STORE: 'from-env',
        AB_TOKEN: ' remote-token ',
        USER: 'shell-op',
      },
      exec: noGit,
      slug: SLUG,
      action: { kind: 'pause' },
      storeRef: 'https://store.example/control',
      openStore: (ref, token) => {
        opened.push({ ref, ...(token !== undefined ? { token } : {}) })
        return store
      },
    })

    expect(opened).toEqual([{ ref: 'https://store.example/control', token: ' remote-token ' }])
    expect(closeCount).toBe(1)
    expect((await store.getEvents(SLUG)).at(-1)?.actor).toEqual({
      kind: 'human',
      user: 'shell-op',
    })
  })

  test('falls back from AB_STORE to the repository-local store root', async () => {
    const store = await makeStore()
    store.close = async () => {}
    const opened: string[] = []
    const openStore = (ref: string): MemoryBuildStore => {
      opened.push(ref)
      return store
    }

    await abBuildControl({
      targetRepo: REPO,
      env: { AB_STORE: 'env-store' },
      exec: noGit,
      slug: SLUG,
      action: { kind: 'pause' },
      openStore,
    })
    await abBuildControl({
      targetRepo: REPO,
      env: {},
      exec: noGit,
      slug: SLUG,
      action: { kind: 'resume' },
      openStore,
    })

    expect(opened).toEqual(['/repo/env-store', '/repo/.autobuild'])
  })

  test('closes the selected store when a control precondition fails', async () => {
    const store = await makeStore()
    let closeCount = 0
    store.close = async () => {
      closeCount += 1
    }

    await expect(
      abBuildControl({
        targetRepo: REPO,
        env: { AB_STORE: 'env-store' },
        exec: noGit,
        slug: 'missing',
        action: { kind: 'pause' },
        openStore: () => store,
      }),
    ).rejects.toBeInstanceOf(BuildControlError)
    expect(closeCount).toBe(1)
  })

  test('refuses own-phase controls before opening a store but permits another build', async () => {
    const store = await makeStore()
    let opens = 0
    const openStore = (): MemoryBuildStore => {
      opens += 1
      return store
    }

    await expect(
      abBuildControl({
        targetRepo: REPO,
        env: {
          AB_SESSION: 'session-1',
          AB_BUILD: SLUG,
          AB_STORE: 'store',
        },
        exec: noGit,
        slug: SLUG,
        action: { kind: 'abort' },
        openStore,
      }),
    ).rejects.toThrow(/own phase session.*AB_SESSION\/AB_BUILD conflict/)
    expect(opens).toBe(0)

    await abBuildControl({
      targetRepo: REPO,
      env: {
        AB_SESSION: 'session-1',
        AB_BUILD: 'different-build',
        AB_STORE: 'store',
      },
      exec: noGit,
      slug: SLUG,
      action: { kind: 'abort' },
      openStore,
    })
    expect(opens).toBe(1)
    expect((await eventTypes(store)).at(-1)).toBe('build.abort-requested')
  })
})

describe('revise-spec re-pins ticket assets (SPEC §6.3)', () => {
  const ticket = { source: 'fake', id: 'T-42' }
  const enc = (text: string) => new TextEncoder().encode(text)
  const file = (name: string, text: string) => ({
    kind: 'mock',
    name,
    layout: 'file' as const,
    entries: [{ type: 'file' as const, path: name, content: enc(text) }],
  })
  const pin = (name: string, revision: number, size: number) => ({
    kind: 'mock',
    name,
    revision,
    layout: 'file' as const,
    size,
    fileCount: 1,
    dirCount: 0,
  })

  /** A build that froze `a.png` rev 0 at its claim. */
  async function pinnedStore(): Promise<MemoryBuildStore> {
    const store = await makeStore({ ticket })
    await store.putTicketAsset(REPO, ticket.id, file('a.png', 'one'))
    await store.append(SLUG, {
      actor: DISPATCHER,
      type: 'build.created',
      payload: { ticket, repo: REPO, baseBranch: 'main', assets: [pin('a.png', 0, 3)] },
    })
    await seedSpec(store)
    return store
  }

  const fromTicket: BuildControlAction = {
    kind: 'answer',
    resolve: { kind: 'revise-spec', body: { kind: 'ticket' } },
  }

  test('file native re-pin uses the supplied preparation callback and freezes bytes', async () => {
    const { FileTicketSource } = await import('../ports/tickets/file')
    const { preparePinnedAssets } = await import('../store/ticket-assets')
    const { mkdtemp, rm } = await import('node:fs/promises')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const dir = await mkdtemp(join(tmpdir(), 'native-repin-'))
    try {
      const source = new FileTicketSource({ dir })
      await source.create({ title: 'Source', body: CONFORMING_SPEC }, { requestedId: ticket.id })
      await source.assets.putTicketAsset(REPO, ticket.id, file('a.png', 'native bytes'))
      const store = await pinnedStore()
      await raise(store, 'esc-1')
      await controlBuild({
        store,
        repo: REPO,
        slug: SLUG,
        env: {},
        action: fromTicket,
        readTicketBody: async () => CONFORMING_SPEC,
        prepareTicketAssets: (ref, destination, repo) =>
          preparePinnedAssets(source, destination, repo, ref.id),
      })
      await source.assets.removeTicketAsset(REPO, ticket.id, 'mock', 'a.png')
      const asset = await store.getPinnedTicketAsset(SLUG, 'mock', 'a.png')
      expect(
        asset?.entries[0]?.type === 'file' && new TextDecoder().decode(asset.entries[0].content),
      ).toBe('native bytes')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
