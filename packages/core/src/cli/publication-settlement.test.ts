import { renderPrSummary } from './pr-summary'
import { describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { EventEnvelope, EventWrite } from '../events/catalog'
import { agentActor, DISPATCHER, humanActor, KERNEL } from '../events/envelope'
import type { EventType } from '../events/payloads'
import { FakeForge } from '../ports/forge/fake'
import { MemoryBuildStore } from '../store/memory'
import { manualClock } from '../testing/fixed'
import { settlePendingPublication, type PublicationSettlementDeps } from './publication-settlement'

const SLUG = 'remote-settlement'
const SHA = 'a'.repeat(40)
const BASE = 'b'.repeat(40)
const BRANCH = `ab/${SLUG}`

class FailOnceStore extends MemoryBuildStore {
  failCompletion = false
  failRetry = false

  override async append<T extends EventType>(
    slug: string,
    event: EventWrite<T>,
  ): Promise<EventEnvelope<T>> {
    if (this.failRetry && event.type === 'publication.retry-scheduled') {
      this.failRetry = false
      throw new Error('retry store unavailable')
    }
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
        isPublished: async (input) =>
          published.some((p) => p.sha === input.sha && p.branch === input.branch),
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
  test('trusted publication cancels persistent native enable before push, preserves hold, and recovers crashes', async () => {
    const h = await seed()
    h.forge.setPrState(1, { state: 'open', mergeable: true })
    await h.forge.setAutoMerge('/repo', 1, true)
    await h.store.append(SLUG, {
      actor: KERNEL,
      type: 'finalize.completed',
      payload: { pr: { number: 1, url: 'https://forge/1', headSha: BASE } },
    })
    const artifact = await h.store.putArtifact(SLUG, { kind: 'implement-notes', content: 'notes' })
    await h.store.append(SLUG, {
      actor: agentActor('implement', 's1'),
      type: 'publication.requested',
      payload: {
        operation: 'implement',
        branch: BRANCH,
        sha: SHA,
        base: BASE,
        round: 1,
        artifact: { kind: artifact.kind, rev: artifact.revision },
      },
    })
    const set = h.forge.setAutoMerge.bind(h.forge)
    h.forge.setAutoMerge = async () => ({ kind: 'deferred' })
    await expect(settlePendingPublication(h.deps, SLUG)).rejects.toThrow('cancellation unconfirmed')
    expect(h.published).toEqual([])
    let held = false
    h.forge.setAutoMerge = async (...args) => {
      const result = await set(...args)
      if (!held) {
        held = true
        await h.store.append(SLUG, {
          actor: humanActor('operator'),
          type: 'build.hold-requested',
          payload: {},
        })
      }
      return result
    }
    const publish = h.deps.publication!.publish
    h.deps.publication!.publish = async (input) => {
      expect(h.forge.isAutoMergeEnabled(1)).toBe(false)
      const { readBuildFacts } = await import('../store/reduced-reads')
      expect((await readBuildFacts(h.store, SLUG)).value.state.landing?.command?.kind).toBe('hold')
      await publish(input)
    }
    h.store.failCompletion = true
    await expect(settlePendingPublication(h.deps, SLUG)).rejects.toThrow('injected append crash')
    await settlePendingPublication(h.deps, SLUG)
    expect(h.published).toHaveLength(1)
    expect(
      (await h.store.getEvents(SLUG)).filter((e) => e.type === 'implement.completed'),
    ).toHaveLength(1)
  })
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

  test('a checkoutless dispatcher completes without touching host git in its scratch root', async () => {
    const h = await seed()
    const scratch = await mkdtemp(join(tmpdir(), 'ab-settlement-scratch-'))
    try {
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
      const deps: PublicationSettlementDeps = {
        ...h.deps,
        workspacePath: scratch,
        checkoutless: true,
        exec: async () => {
          throw new Error('Executable not found in $PATH: "git"')
        },
      }

      await settlePendingPublication(deps, SLUG)

      expect(h.published).toEqual([{ ref: 'sandbox-1', sha: SHA, branch: BRANCH }])
      const types = (await h.store.getEvents(SLUG)).map((event) => event.type)
      expect(types).toContain('implement.completed')
    } finally {
      await rm(scratch, { recursive: true, force: true })
    }
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
    expect(h.published).toHaveLength(1)
    expect(
      (await h.store.getEvents(SLUG)).filter((event) => event.type === 'implement.completed'),
    ).toHaveLength(1)
  })

  test('skips a request abandoned by workspace replacement and settles only its rerun', async () => {
    const h = await seed()
    const stale = await h.store.putArtifact(SLUG, { kind: 'implement-notes', content: 'lost' })
    await h.store.append(SLUG, {
      actor: agentActor('implement', 'lost-session'),
      type: 'publication.requested',
      payload: {
        operation: 'implement',
        branch: BRANCH,
        sha: SHA,
        round: 1,
        base: BASE,
        artifact: { kind: stale.kind, rev: stale.revision },
      },
    })
    await h.store.append(SLUG, {
      actor: DISPATCHER,
      type: 'workspace.released',
      payload: { ref: 'sandbox-1', reason: 'replacement' },
    })
    await h.store.append(SLUG, {
      actor: DISPATCHER,
      type: 'workspace.provisioned',
      payload: {
        provider: 'vercel-sandbox',
        ref: 'sandbox-2',
        path: '/vercel/sandbox/workspace',
        branch: BRANCH,
        base: { source: 'existing', sha: BASE },
      },
    })

    await settlePendingPublication(h.deps, SLUG)
    expect(h.published).toEqual([])

    const rerun = await h.store.putArtifact(SLUG, { kind: 'implement-notes', content: 'rerun' })
    const rerunSha = 'c'.repeat(40)
    await h.store.append(SLUG, {
      actor: agentActor('implement', 'replacement-session'),
      type: 'publication.requested',
      payload: {
        operation: 'implement',
        branch: BRANCH,
        sha: rerunSha,
        round: 1,
        base: BASE,
        artifact: { kind: rerun.kind, rev: rerun.revision },
      },
    })
    await settlePendingPublication(h.deps, SLUG)

    expect(h.published).toEqual([{ ref: 'sandbox-2', sha: rerunSha, branch: BRANCH }])
    expect(
      (await h.store.getEvents(SLUG)).filter((event) => event.type === 'implement.completed'),
    ).toHaveLength(1)
  })

  test('repairs completion when an abandoned request already reached the remote branch', async () => {
    const h = await seed()
    const artifact = await h.store.putArtifact(SLUG, { kind: 'implement-notes', content: 'landed' })
    await h.store.append(SLUG, {
      actor: agentActor('implement', 'lost-ack-session'),
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
    await h.store.append(SLUG, {
      actor: DISPATCHER,
      type: 'workspace.released',
      payload: { ref: 'sandbox-1', reason: 'replacement' },
    })
    await h.store.append(SLUG, {
      actor: DISPATCHER,
      type: 'workspace.provisioned',
      payload: {
        provider: 'vercel-sandbox',
        ref: 'sandbox-2',
        path: '/vercel/sandbox/workspace',
        branch: BRANCH,
        base: { source: 'existing', sha: BASE },
      },
    })
    let observations = 0
    h.deps.publication = {
      isPublished: async (input) => {
        observations += 1
        return input.sha === SHA && input.branch === BRANCH
      },
      publish: async () => {
        throw new Error('already-landed request must not publish again')
      },
    }

    await settlePendingPublication(h.deps, SLUG)

    expect(observations).toBe(1)
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
      isPublished: async () => false,
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

  test('finalize hosts attachments, applies auto-merge intent, and leaves the durable summary to outer settlement', async () => {
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
    expect(h.forge.autoMergeCalls).toHaveLength(0)
    expect(h.forge.comments).toHaveLength(0)
    expect(
      renderPrSummary(
        { build: SLUG, store: h.deps.storeRef, phase: 'finalize', round: 1, session: '' },
        await h.store.getEvents(SLUG),
      ),
    ).toContain(`Autobuild: ${SLUG}`)
    expect(
      renderPrSummary(
        { build: SLUG, store: h.deps.storeRef, phase: 'finalize', round: 1, session: '' },
        await h.store.getEvents(SLUG),
      ),
    ).toContain('result.png')
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

  test('drives the settlement guard across lease expiry deterministically via the injected clock', async () => {
    const clock = manualClock()
    const store = new FailOnceStore({ clock })
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
      },
    })
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
    await store.append(SLUG, {
      actor: DISPATCHER,
      type: 'execution.started',
      payload: {
        provider: 'vercel-sandbox',
        workspaceRef: 'sandbox-1',
        instance: 'inst-1',
      },
    })
    const artifact = await store.putArtifact(SLUG, {
      kind: 'implement-notes',
      content: 'notes',
    })
    await store.append(SLUG, {
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
    // With the manual clock frozen, the lease expires exactly at epoch + 60s.
    expect(await store.claimLease(SLUG, 'runner-1', 60_000)).toBe(true)

    const published: Array<{ ref: string; sha: string; branch: string }> = []
    const deps: PublicationSettlementDeps = {
      store,
      storeRef: 'https://store.example.test',
      publication: {
        isPublished: async (input) =>
          published.some((p) => p.sha === input.sha && p.branch === input.branch),
        publish: async (input) => {
          published.push(input)
        },
      },
      forge: new FakeForge(),
      workspacePath: '/repo',
      exec: async () => ({ stdout: '', stderr: '', exitCode: 0 }),
      ids: (prefix) => `${prefix}_1`,
      runId: 'run-1',
      clock,
    }

    // Guard holds: the guest execution is open and the lease is live.
    await settlePendingPublication(deps, SLUG)
    expect(published).toEqual([])
    expect(
      (await store.getEvents(SLUG)).filter((event) => event.type === 'implement.completed'),
    ).toHaveLength(0)

    // Boundary: now === expiresAt means the lease is expired (strict `>`),
    // matching the lease-sweep semantics — publication unlocks with zero
    // real-time waits because the guard reads the injected clock.
    clock.advance(60_000)
    await settlePendingPublication(deps, SLUG)
    expect(published).toEqual([{ ref: 'sandbox-1', sha: SHA, branch: BRANCH }])
    expect(
      (await store.getEvents(SLUG)).filter((event) => event.type === 'implement.completed'),
    ).toHaveLength(1)
  })

  test('a recorded execution end unlocks publication while the injected lease is still live', async () => {
    const clock = manualClock()
    const store = new FailOnceStore({ clock })
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
      },
    })
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
    await store.append(SLUG, {
      actor: DISPATCHER,
      type: 'execution.started',
      payload: {
        provider: 'vercel-sandbox',
        workspaceRef: 'sandbox-1',
        instance: 'inst-1',
      },
    })
    const artifact = await store.putArtifact(SLUG, {
      kind: 'implement-notes',
      content: 'notes',
    })
    await store.append(SLUG, {
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
    expect(await store.claimLease(SLUG, 'runner-1', 60_000)).toBe(true)
    await store.append(SLUG, {
      actor: DISPATCHER,
      type: 'execution.ended',
      payload: {
        instance: 'inst-1',
        workspaceRef: 'sandbox-1',
        outcome: 'completed',
      },
    })

    const published: Array<{ ref: string; sha: string; branch: string }> = []
    const deps: PublicationSettlementDeps = {
      store,
      storeRef: 'https://store.example.test',
      publication: {
        isPublished: async (input) =>
          published.some((p) => p.sha === input.sha && p.branch === input.branch),
        publish: async (input) => {
          published.push(input)
        },
      },
      forge: new FakeForge(),
      workspacePath: '/repo',
      exec: async () => ({ stdout: '', stderr: '', exitCode: 0 }),
      ids: (prefix) => `${prefix}_1`,
      runId: 'run-1',
      clock,
    }

    // No open execution even though the lease is live: publish proceeds,
    // with the clock still frozen at its epoch (no real time has passed).
    await settlePendingPublication(deps, SLUG)
    expect(published).toEqual([{ ref: 'sandbox-1', sha: SHA, branch: BRANCH }])
    expect(
      (await store.getEvents(SLUG)).filter((event) => event.type === 'implement.completed'),
    ).toHaveLength(1)
  })
})

describe('settlePendingPublication: the publication.lost backstop (AUT-328)', () => {
  test('an abandoned unpublished request records the loss durably, deduped per request', async () => {
    const h = await seed()
    const artifact = await h.store.putArtifact(SLUG, {
      kind: 'implement-notes',
      content: 'never merged',
    })
    const requested = await h.store.append(SLUG, {
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
    await h.store.append(SLUG, {
      actor: DISPATCHER,
      type: 'workspace.released',
      payload: { ref: 'sandbox-1', reason: 'replacement' },
    })
    h.deps.publication = {
      isPublished: async () => false,
      publish: async () => {
        throw new Error('a released workspace must never be published again')
      },
    }

    await settlePendingPublication(h.deps, SLUG)
    await settlePendingPublication(h.deps, SLUG)

    const lost = (await h.store.getEvents(SLUG)).filter(
      (event) => event.type === 'publication.lost',
    )
    expect(lost).toHaveLength(1)
    expect(lost[0]!.actor).toEqual(DISPATCHER)
    expect(lost[0]!.payload).toEqual({
      request: requested.seq,
      operation: 'implement',
      branch: BRANCH,
      sha: SHA,
      reason: 'workspace released with the publication uncompleted',
    })
  })

  test('an abandoned request the guest already pushed is settled, never recorded lost', async () => {
    const h = await seed()
    const artifact = await h.store.putArtifact(SLUG, {
      kind: 'implement-notes',
      content: 'merged before the release',
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
    await h.store.append(SLUG, {
      actor: DISPATCHER,
      type: 'workspace.released',
      payload: { ref: 'sandbox-1', reason: 'abort' },
    })
    h.deps.publication = {
      isPublished: async (input) => input.sha === SHA && input.branch === BRANCH,
      publish: async () => {
        throw new Error('an already-pushed branch must not publish again')
      },
    }

    await settlePendingPublication(h.deps, SLUG)

    const events = await h.store.getEvents(SLUG)
    expect(events.some((event) => event.type === 'publication.lost')).toBe(false)
    expect(
      events.filter(
        (event) => event.type === 'implement.completed' && event.payload.commits.head === SHA,
      ),
    ).toHaveLength(1)
  })

  test('a live guest that already pushed gets its completion fact without a publish call', async () => {
    const h = await seed()
    const artifact = await h.store.putArtifact(SLUG, {
      kind: 'implement-notes',
      content: 'pushed before parking',
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
    let publishAttempts = 0
    h.deps.publication = {
      isPublished: async (input) => input.sha === SHA && input.branch === BRANCH,
      publish: async () => {
        publishAttempts += 1
      },
    }

    await settlePendingPublication(h.deps, SLUG)

    expect(publishAttempts).toBe(0)
    const events = await h.store.getEvents(SLUG)
    expect(events.some((event) => event.type === 'publication.lost')).toBe(false)
    expect(
      events.filter(
        (event) => event.type === 'implement.completed' && event.payload.commits.head === SHA,
      ),
    ).toHaveLength(1)
  })
})

async function seedRestackPublication(withLostPublications = false) {
  const h = await seed()
  if (withLostPublications) {
    for (const [index, sha] of ['e'.repeat(40), 'f'.repeat(40)].entries()) {
      const request = await h.store.append(SLUG, {
        actor: agentActor('implement', `lost-${index}`),
        type: 'publication.requested',
        payload: {
          operation: 'implement',
          branch: BRANCH,
          sha,
          base: BASE,
          round: 1,
          artifact: { kind: 'implement-notes', rev: 0 },
        },
      })
      if (index === 0)
        await h.store.append(SLUG, {
          actor: DISPATCHER,
          type: 'publication.lost',
          payload: {
            request: request.seq,
            operation: 'implement',
            branch: BRANCH,
            sha,
            reason: 'workspace released before publication',
          },
        })
    }
    await h.store.append(SLUG, { actor: KERNEL, type: 'workspace.released', payload: {} })
    await h.store.append(SLUG, {
      actor: KERNEL,
      type: 'workspace.provisioned',
      payload: {
        provider: 'vercel-sandbox',
        ref: 'sandbox-2',
        branch: BRANCH,
        base: { source: 'remote', sha: BASE },
      },
    })
  }
  const transaction = {
    id: 'rewrite-1',
    attempt: 1,
    branch: BRANCH,
    oldHead: 'c'.repeat(40),
    oldBase: BASE,
    targetBase: BASE,
    changeSha: 'd'.repeat(40),
    workspaceHead: 'c'.repeat(40),
    localBranchHead: 'c'.repeat(40),
  }
  const artifact = { kind: 'reconcile-notes', rev: 0 }
  await h.store.append(SLUG, {
    actor: KERNEL,
    type: 'reconcile.started',
    payload: { attempt: 1, baseSha: BASE },
  })
  await h.store.append(SLUG, { actor: KERNEL, type: 'reconcile.prepared', payload: transaction })
  await h.store.append(SLUG, {
    actor: KERNEL,
    type: 'reconcile.replayed',
    payload: { id: transaction.id, conflicted: true },
  })
  await h.store.append(SLUG, {
    actor: KERNEL,
    type: 'reconcile.publish-intended',
    payload: { ...transaction, headSha: SHA, conflicted: true, artifact },
  })
  const request = await h.store.append(SLUG, {
    actor: agentActor('reconcile', 's1'),
    type: 'publication.requested',
    payload: {
      operation: 'reconcile',
      sha: SHA,
      branch: BRANCH,
      artifact,
      rewrite: { ...transaction, conflicted: true },
    },
  })
  return { ...h, transaction, request }
}

test('trusted restack publication carries archives and an explicit lease, then settles once', async () => {
  const h = await seedRestackPublication()
  const calls: unknown[] = []
  h.forge.setPrState(1, { state: 'open', mergeable: true })
  await h.forge.setAutoMerge('/repo', 1, true)
  await h.store.append(SLUG, {
    actor: KERNEL,
    type: 'finalize.completed',
    payload: { pr: { number: 1, url: 'https://forge/1', headSha: h.transaction.oldHead } },
  })
  h.deps.publication!.rewrite = async (input) => {
    expect(h.forge.isAutoMergeEnabled(1)).toBe(false)
    expect(
      (await h.store.getEvents(SLUG)).findLast((e) => e.type === 'landing.native-applied')?.payload,
    ).toMatchObject({ enabled: false, operation: `publication:${h.request.seq}` })
    calls.push(input)
    return { kind: 'published' }
  }
  await settlePendingPublication(h.deps, SLUG)
  await settlePendingPublication(h.deps, SLUG)
  expect(calls).toHaveLength(1)
  expect(calls[0]).toMatchObject({
    ref: 'sandbox-1',
    sha: SHA,
    branch: BRANCH,
    expected: h.transaction.oldHead,
    archives: expect.arrayContaining([
      {
        ref: `refs/autobuild/archive/${SLUG}/${h.transaction.oldHead}`,
        sha: h.transaction.oldHead,
      },
      { ref: `refs/autobuild/archive/${SLUG}/${SHA}`, sha: SHA },
    ]),
  })
  expect(h.published).toEqual([])
  const events = await h.store.getEvents(SLUG)
  expect(events.filter((e) => e.type === 'reconcile.rewritten')).toHaveLength(1)
  expect(events.find((e) => e.type === 'reconcile.completed')?.payload).toEqual({
    headSha: SHA,
    rewriteId: h.transaction.id,
    artifact: { kind: 'reconcile-notes', rev: 0 },
  })
})

test('remote lease mismatch durably returns to replay without completion or plain push', async () => {
  const h = await seedRestackPublication()
  h.deps.publication!.rewrite = async () => ({ kind: 'lease-mismatch', actual: 'e'.repeat(40) })
  await settlePendingPublication(h.deps, SLUG)
  const events = await h.store.getEvents(SLUG)
  expect(events.some((e) => e.type === 'reconcile.completed')).toBe(false)
  expect(events.find((e) => e.type === 'reconcile.contended')?.payload).toEqual({
    id: h.transaction.id,
    request: h.request.seq,
    actual: 'e'.repeat(40),
  })
  expect(events.find((e) => e.type === 'phase.failed')?.payload).toMatchObject({
    phase: 'reconcile',
    round: 1,
    willRetry: true,
  })
  expect(h.published).toEqual([])
})

test('a provider without trusted rewrite capability refuses without using plain publication', async () => {
  const h = await seedRestackPublication()
  await expect(settlePendingPublication(h.deps, SLUG)).rejects.toThrow(
    'lacks trusted reconcile rewrite/archive publication',
  )
  expect(h.published).toEqual([])
})

test('a genuinely lost reconcile candidate is durably retired without retrying publication', async () => {
  const h = await seedRestackPublication()
  await h.store.append(SLUG, {
    actor: DISPATCHER,
    type: 'publication.lost',
    payload: {
      request: h.request.seq,
      operation: 'reconcile',
      branch: BRANCH,
      sha: SHA,
      reason: 'replacement',
    },
  })
  h.deps.publication!.recoverCandidate = async () => false
  let calls = 0
  h.deps.publication!.rewrite = async () => {
    calls++
    throw new Error(`archive publication rejected: fatal: bad object ${SHA}`)
  }
  await settlePendingPublication(h.deps, SLUG)
  await settlePendingPublication(h.deps, SLUG)
  expect(calls).toBe(0)
  const events = await h.store.getEvents(SLUG)
  expect(
    events.some((e) => e.type === 'reconcile.completed' || e.type === 'reconcile.rewritten'),
  ).toBe(false)
  expect(h.published).toEqual([])
  expect(events.filter((event) => event.type === 'publication.candidate-retired')).toHaveLength(1)
})

test.each(['available', 'unavailable-inspection'] as const)(
  'legacy loss with %s preserves guarded publication behavior',
  async (outcome) => {
    const h = await seedRestackPublication()
    await h.store.append(SLUG, {
      actor: DISPATCHER,
      type: 'publication.lost',
      payload: {
        request: h.request.seq,
        operation: 'reconcile',
        branch: BRANCH,
        sha: SHA,
        reason: 'replacement',
      },
    })
    h.deps.publication!.recoverCandidate = async () => {
      if (outcome === 'unavailable-inspection') throw new Error('transport unavailable')
      return true
    }
    let calls = 0
    h.deps.publication!.rewrite = async (input) => {
      expect(input.sha).toBe(SHA)
      expect(input.expected).toBe(h.transaction.oldHead)
      calls++
      return { kind: 'published' }
    }
    if (outcome === 'unavailable-inspection')
      await expect(settlePendingPublication(h.deps, SLUG)).rejects.toThrow('transport unavailable')
    else {
      await settlePendingPublication(h.deps, SLUG)
      await settlePendingPublication(h.deps, SLUG)
    }
    expect(calls).toBe(outcome === 'available' ? 1 : 0)
    const events = await h.store.getEvents(SLUG)
    expect(events.filter((event) => event.type === 'publication.candidate-retired')).toHaveLength(0)
    expect(events.filter((event) => event.type === 'reconcile.completed')).toHaveLength(
      outcome === 'available' ? 1 : 0,
    )
  },
)

test('lost and abandoned publication objects do not block trusted reconcile archives', async () => {
  const h = await seedRestackPublication(true)
  let archived: string[] = []
  h.deps.publication!.rewrite = async (input) => {
    archived = input.archives.map((entry) => entry.sha)
    expect(archived).not.toContain('e'.repeat(40))
    expect(archived).not.toContain('f'.repeat(40))
    return { kind: 'published' }
  }
  await settlePendingPublication(h.deps, SLUG)
  expect(archived).toContain(SHA)
  expect(archived).toContain(h.transaction.oldHead)
  expect(
    (await h.store.getEvents(SLUG)).some((event) => event.type === 'reconcile.completed'),
  ).toBe(true)
})

test('trusted publication records an overtaken successful rewrite without completing its request', async () => {
  const h = await seedRestackPublication()
  const observed = 'e'.repeat(40)
  h.deps.publication!.rewrite = async () => ({
    kind: 'lease-mismatch',
    actual: observed,
    rewritten: true,
  })
  await settlePendingPublication(h.deps, SLUG)
  await settlePendingPublication(h.deps, SLUG)
  const events = await h.store.getEvents(SLUG)
  const receipts = events.filter((event) => event.type === 'reconcile.rewritten')
  expect(receipts).toHaveLength(1)
  expect(receipts[0]!.payload).toMatchObject({
    oldHead: h.transaction.oldHead,
    headSha: SHA,
    observedHead: observed,
  })
  expect(events.some((event) => event.type === 'reconcile.completed')).toBe(false)
  expect(events.filter((event) => event.type === 'reconcile.contended')).toHaveLength(1)
  const { readBuildSelector } = await import('../store/reduced-reads')
  expect(await readBuildSelector(h.store, SLUG, 'publishedBranchHead')).toBe(observed)
  expect(await readBuildSelector(h.store, SLUG, 'verifyDiffBase')).toBe(BASE)
})

for (const failure of ['different-head', 'read-error'] as const) {
  test(`hosted completion requires after-write authoritative readback: ${failure}`, async () => {
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
    h.deps.publication!.isPublished = async () => {
      if (h.published.length && failure === 'read-error') throw new Error('inspection offline')
      return false
    }
    await expect(settlePendingPublication(h.deps, SLUG)).rejects.toThrow(
      failure === 'read-error' ? 'inspection offline' : 'publication readback did not confirm',
    )
    expect(h.published).toHaveLength(1)
    expect((await h.store.getEvents(SLUG)).some((e) => e.type === 'implement.completed')).toBe(
      false,
    )
  })
}

test('finalize publication waits through durable forge cooldown and settles after reset', async () => {
  const { guardForge, ForgeCooldown } = await import('../kernel/guarded-forge')
  const now = manualClock()
  const h = await seed()
  h.forge.setPrState(1, { state: 'open', mergeable: true })
  await h.store.append(SLUG, {
    actor: KERNEL,
    type: 'finalize.completed',
    payload: { pr: { number: 1, url: 'https://forge/1', headSha: BASE } },
  })
  await h.store.append(SLUG, {
    actor: KERNEL,
    type: 'publication.requested',
    payload: { operation: 'finalize-step', step: 'notes', branch: BRANCH, sha: SHA },
  })
  await h.store.ensureRepo('/repo')
  await h.store.appendRepo('/repo', {
    actor: KERNEL,
    type: 'dispatcher.forge-degraded',
    payload: {
      forge: 'github',
      message: 'limited',
      firstFailureAt: now().toISOString(),
      resetAt: new Date(now().getTime() + 60_000).toISOString(),
    },
  })
  h.deps.forge = guardForge(h.forge, { store: h.store, repo: '/repo', name: 'github', now })
  await expect(settlePendingPublication(h.deps, SLUG)).rejects.toBeInstanceOf(ForgeCooldown)
  expect(h.published).toHaveLength(0)
  expect(
    (await h.store.getEvents(SLUG)).filter(
      (e) => e.type === 'finalize.step-completed' || e.type === 'observation.recorded',
    ),
  ).toEqual([])
  now.advance(60_000)
  await settlePendingPublication(h.deps, SLUG)
  expect(h.published).toHaveLength(1)
  expect(
    (await h.store.getEvents(SLUG)).find((e) => e.type === 'finalize.step-completed'),
  ).toMatchObject({ payload: { ok: true } })
})

test('release preserves pending publication on forge scheduling deferral and retries settlement', async () => {
  const { settlePublicationFactsBeforeRelease } = await import('../processes/publication-loss')
  const { readBuildFacts } = await import('../store/reduced-reads')
  const { ForgeCooldown } = await import('../kernel/guarded-forge')
  const { ForgeRequestDeferred } = await import('../ports/forge-request-context')
  for (const error of [new ForgeCooldown('cooldown'), new ForgeRequestDeferred('deferred')]) {
    const h = await seed()
    await h.store.append(SLUG, {
      actor: KERNEL,
      type: 'publication.requested',
      payload: { operation: 'finalize-step', step: 'notes', branch: BRANCH, sha: SHA },
    })
    const facts = (await readBuildFacts(h.store, SLUG)).value
    await expect(
      settlePublicationFactsBeforeRelease(
        {
          store: h.store,
          settlePublication: async () => {
            throw error
          },
        },
        SLUG,
        facts,
        'pause',
      ),
    ).rejects.toBe(error)
    expect((await h.store.getEvents(SLUG)).some((e) => e.type === 'publication.lost')).toBe(false)
    await settlePublicationFactsBeforeRelease(
      { store: h.store, settlePublication: () => settlePendingPublication(h.deps, SLUG) },
      SLUG,
      facts,
      'pause',
    )
    expect(h.published).toHaveLength(1)
    expect((await h.store.getEvents(SLUG)).some((e) => e.type === 'publication.lost')).toBe(false)
  }
})

test('transient reconcile publication and exhausted attention retain the workspace at release', async () => {
  const { ForgeFailure } = await import('../ports/forge-failure')
  const { ForgeRequestDeferred } = await import('../ports/forge-request-context')
  const { settlePublicationBeforeRelease } = await import('../processes/publication-loss')
  const { PUBLICATION_RETRY_SECONDS } = await import('../kernel/publication-retry')
  const h = await seedRestackPublication()
  const clock = manualClock()
  h.deps.clock = clock
  let calls = 0
  let failing = true
  h.deps.publication!.rewrite = async () => {
    calls++
    if (failing)
      throw new ForgeFailure('HTTP 503 Service Unavailable', {
        kind: 'transient',
        retry: 'retryable',
      })
    return { kind: 'published' }
  }
  const release = () =>
    settlePublicationBeforeRelease(
      {
        store: h.store,
        settlePublication: (slug) => settlePendingPublication({ ...h.deps }, slug),
      },
      SLUG,
      [],
      'cleanup',
    )
  for (const seconds of PUBLICATION_RETRY_SECONDS) {
    await expect(release()).rejects.toBeInstanceOf(ForgeRequestDeferred)
    const previous = calls
    await expect(release()).rejects.toBeInstanceOf(ForgeRequestDeferred)
    expect(calls).toBe(previous)
    if (calls === 1)
      await h.store.append(SLUG, {
        actor: agentActor('reconcile', 'reconstructed'),
        type: 'publication.requested',
        payload: h.request.payload,
      })
    clock.advance(seconds * 1000)
  }
  await expect(release()).rejects.toBeInstanceOf(ForgeRequestDeferred)
  await expect(release()).rejects.toBeInstanceOf(ForgeRequestDeferred)
  expect(calls).toBe(7)
  const events = await h.store.getEvents(SLUG)
  expect(events.some((e) => e.type === 'publication.lost' || e.type === 'workspace.released')).toBe(
    false,
  )
  const raises = events.filter((e) => e.type === 'escalation.raised')
  expect(raises).toHaveLength(1)
  await h.store.append(SLUG, {
    actor: humanActor('operator'),
    type: 'escalation.answered',
    payload: { id: raises[0]!.payload.id, answer: 'retry', resolution: 'retry' },
  })
  failing = false
  await release()
  expect(
    (await h.store.getEvents(SLUG)).filter((e) => e.type === 'reconcile.completed'),
  ).toHaveLength(1)
})

test('a failed retry write propagates without recording loss or releasing the workspace', async () => {
  const { ForgeFailure } = await import('../ports/forge-failure')
  const { PublicationRetryPersistenceError } = await import('../kernel/publication-retry')
  const { settlePublicationBeforeRelease } = await import('../processes/publication-loss')
  const h = await seedRestackPublication()
  h.store.failRetry = true
  h.deps.publication!.rewrite = async () => {
    throw new ForgeFailure('HTTP 503', { kind: 'transient', retry: 'retryable' })
  }
  await expect(
    settlePublicationBeforeRelease(
      { store: h.store, settlePublication: (slug) => settlePendingPublication(h.deps, slug) },
      SLUG,
      [],
      'cleanup',
    ),
  ).rejects.toBeInstanceOf(PublicationRetryPersistenceError)
  expect(
    (await h.store.getEvents(SLUG)).some(
      (e) =>
        e.type === 'publication.lost' ||
        e.type === 'workspace.released' ||
        e.type === 'phase.failed' ||
        e.type === 'publication.retry-scheduled',
    ),
  ).toBe(false)
})
