import { describe, expect, test } from 'bun:test'
import type { EventEnvelope, EventWrite } from '../events/catalog'
import { agentActor, DISPATCHER, humanActor, KERNEL } from '../events/envelope'
import type { EventType } from '../events/payloads'
import { FakeForge } from '../ports/forge/fake'
import { MemoryBuildStore } from '../store/memory'
import { settlePendingPublication, type PublicationSettlementDeps } from './publication-settlement'

const SLUG = 'remote-settlement'
const SHA = 'a'.repeat(40)
const BASE = 'b'.repeat(40)
const BRANCH = `ab/${SLUG}`

class FailOnceStore extends MemoryBuildStore {
  failCompletion = false

  override async append<T extends EventType>(
    slug: string,
    event: EventWrite<T>,
  ): Promise<EventEnvelope<T>> {
    if (this.failCompletion && event.type === 'implement.completed') {
      this.failCompletion = false
      throw new Error('injected append crash')
    }
    return super.append(slug, event)
  }
}

async function seed(options: { workspace?: boolean; attachments?: boolean } = {}): Promise<{
  store: FailOnceStore
  deps: PublicationSettlementDeps
  published: Array<{ ref: string; sha: string; branch: string }>
  forge: FakeForge
}> {
  const store = new FailOnceStore()
  await store.createBuild({
    slug: SLUG,
    repo: '/repo',
    branch: BRANCH,
    ticket: { source: 'file', id: 'T-1', title: 'Remote settlement' },
  })
  await store.append(SLUG, {
    actor: DISPATCHER,
    type: 'build.created',
    payload: {
      ticket: { source: 'file', id: 'T-1', title: 'Remote settlement' },
      repo: '/repo',
      baseBranch: 'main',
      ...(options.attachments
        ? {
            pr: {
              imageHost: {
                provider: 'github-release' as const,
                repository: 'acme/assets',
                releaseId: 7,
              },
            },
          }
        : {}),
    },
  })
  if (options.workspace !== false) {
    await store.append(SLUG, {
      actor: KERNEL,
      type: 'workspace.provisioned',
      payload: {
        provider: 'vercel-sandbox',
        ref: 'sandbox-1',
        path: '/vercel/sandbox/workspace',
        branch: BRANCH,
        base: { source: 'remote', sha: BASE },
      },
    })
  }
  const published: Array<{ ref: string; sha: string; branch: string }> = []
  const forge = new FakeForge({ prAttachments: options.attachments })
  return {
    store,
    published,
    forge,
    deps: {
      store,
      storeRef: 'https://store.example.test',
      publication: {
        publish: async (input) => {
          published.push(input)
        },
      },
      forge,
      workspacePath: '/repo',
      exec: async () => ({ stdout: '', stderr: '', exitCode: 0 }),
      ids: (prefix) => `${prefix}_1`,
      runId: 'run-1',
    },
  }
}

describe('settlePendingPublication', () => {
  test('publishes exact implementation identity, appends completion, and suppresses retry duplicates', async () => {
    const h = await seed()
    const artifact = await h.store.putArtifact(SLUG, {
      kind: 'implement-notes',
      content: 'implemented remotely\n',
    })
    await h.store.append(SLUG, {
      actor: agentActor('implement', 'session-1'),
      type: 'publication.requested',
      payload: {
        operation: 'implement',
        branch: BRANCH,
        sha: SHA,
        round: 1,
        base: BASE,
        artifact: { kind: artifact.kind, rev: artifact.revision },
      },
    })

    await settlePendingPublication(h.deps, SLUG)
    await settlePendingPublication(h.deps, SLUG)

    expect(h.published).toEqual([{ ref: 'sandbox-1', sha: SHA, branch: BRANCH }])
    const completed = (await h.store.getEvents(SLUG)).filter(
      (event) => event.type === 'implement.completed',
    )
    expect(completed).toHaveLength(1)
    expect(completed[0]!.payload).toEqual({
      round: 1,
      commits: { base: BASE, head: SHA },
      artifact: { kind: 'implement-notes', rev: 0 },
    })
  })

  test('leaves a published effect retryable across the event-append crash gap', async () => {
    const h = await seed()
    const artifact = await h.store.putArtifact(SLUG, { kind: 'implement-notes', content: 'notes' })
    await h.store.append(SLUG, {
      actor: agentActor('implement', 'session-1'),
      type: 'publication.requested',
      payload: {
        operation: 'implement',
        branch: BRANCH,
        sha: SHA,
        round: 1,
        base: BASE,
        artifact: { kind: artifact.kind, rev: artifact.revision },
      },
    })
    h.store.failCompletion = true

    await expect(settlePendingPublication(h.deps, SLUG)).rejects.toThrow(/injected append crash/)
    await settlePendingPublication(h.deps, SLUG)
    expect(h.published).toHaveLength(2)
    expect(
      (await h.store.getEvents(SLUG)).filter((event) => event.type === 'implement.completed'),
    ).toHaveLength(1)
  })

  test('rejects a request with no open workspace before invoking publication', async () => {
    const h = await seed({ workspace: false })
    const artifact = await h.store.putArtifact(SLUG, { kind: 'implement-notes', content: 'notes' })
    await h.store.append(SLUG, {
      actor: agentActor('implement', 'session-1'),
      type: 'publication.requested',
      payload: {
        operation: 'implement',
        branch: BRANCH,
        sha: SHA,
        round: 1,
        base: BASE,
        artifact: { kind: artifact.kind, rev: artifact.revision },
      },
    })
    await expect(settlePendingPublication(h.deps, SLUG)).rejects.toThrow(/no open workspace/)
    expect(h.published).toEqual([])
  })

  test('a failed finalize-step publication records the ordinary failed outcome and follow-up', async () => {
    const h = await seed()
    let attempts = 0
    h.deps.publication = {
      publish: async () => {
        attempts += 1
        throw new Error('branch rejected')
      },
    }
    await h.store.append(SLUG, {
      actor: KERNEL,
      type: 'publication.requested',
      payload: {
        operation: 'finalize-step',
        step: 'release-notes',
        branch: BRANCH,
        sha: SHA,
      },
    })

    await settlePendingPublication(h.deps, SLUG)
    await settlePendingPublication(h.deps, SLUG)

    expect(attempts).toBe(1)
    const events = await h.store.getEvents(SLUG)
    expect(events.find((event) => event.type === 'finalize.step-completed')).toMatchObject({
      actor: KERNEL,
      payload: {
        step: 'release-notes',
        ok: false,
        note: 'finalize publication failed: branch rejected',
      },
    })
    expect(events.find((event) => event.type === 'observation.recorded')).toMatchObject({
      actor: KERNEL,
      payload: {
        kind: 'followup',
        summary: expect.stringContaining('branch rejected'),
      },
    })
  })

  test('finalize hosts attachments, applies auto-merge intent, and posts the durable summary', async () => {
    const h = await seed({ attachments: true })
    h.forge.setHeadSha(SHA)
    const image = await h.store.putArtifact(SLUG, {
      kind: 'visual',
      content: new Uint8Array([1, 2, 3]),
    })
    await h.store.append(SLUG, {
      actor: agentActor('verify:visual', 'session-v'),
      type: 'pr-attachment.designated',
      payload: {
        artifact: { kind: image.kind, rev: image.revision },
        filename: 'result.png',
        mediaType: 'image/png',
      },
    })
    await h.store.append(SLUG, {
      actor: humanActor('operator'),
      type: 'build.auto-merge-requested',
      payload: {},
    })
    const description = await h.store.putArtifact(SLUG, {
      kind: 'pr-description',
      content: '# Remote title\n\nRemote body.\n',
    })
    await h.store.append(SLUG, {
      actor: agentActor('finalize', 'session-1'),
      type: 'publication.requested',
      payload: {
        operation: 'finalize',
        branch: BRANCH,
        sha: SHA,
        description: { kind: description.kind, rev: description.revision },
      },
    })

    await settlePendingPublication(h.deps, SLUG)

    expect(h.forge.opened).toEqual([
      expect.objectContaining({
        workspacePath: '/repo',
        head: BRANCH,
        base: 'main',
        title: 'Remote title',
        body: 'Remote body.\n',
      }),
    ])
    expect(h.forge.prAttachmentUploads).toHaveLength(1)
    expect(h.forge.autoMergeCalls).toHaveLength(1)
    expect(h.forge.comments).toHaveLength(1)
    expect(h.forge.comments[0]!.body).toContain(`Autobuild: ${SLUG}`)
    expect(h.forge.comments[0]!.body).toContain('result.png')
    expect(
      (await h.store.getEvents(SLUG)).filter((event) => event.type === 'finalize.completed'),
    ).toHaveLength(1)
  })

  test('finalize rejects a missing description after exact publication', async () => {
    const h = await seed()
    await h.store.append(SLUG, {
      actor: agentActor('finalize', 'session-1'),
      type: 'publication.requested',
      payload: {
        operation: 'finalize',
        branch: BRANCH,
        sha: SHA,
        description: { kind: 'pr-description', rev: 0 },
      },
    })
    await expect(settlePendingPublication(h.deps, SLUG)).rejects.toThrow(/missing PR description/)
    expect(h.published).toEqual([{ ref: 'sandbox-1', sha: SHA, branch: BRANCH }])
    expect(h.forge.opened).toEqual([])
  })
})
