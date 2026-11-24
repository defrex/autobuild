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

async function seed(options: { workspace?: boolean } = {}): Promise<{
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
  const forge = new FakeForge()
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
    let execCalls = 0
    Object.assign(h.deps, {
      checkoutless: true,
      workspacePath: '/inert-settlement-scratch',
      exec: async () => {
        execCalls += 1
        throw new Error('host Git must not run')
      },
    })
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
    await settlePendingPublication(h.deps, SLUG)
    expect(execCalls).toBe(0)
    expect(h.published).toEqual([{ ref: 'sandbox-1', sha: SHA, branch: BRANCH }])
    const completed = (await h.store.getEvents(SLUG)).filter(
      (e) => e.type === 'implement.completed',
    )
    expect(completed[0]!.payload).toEqual({
      round: 1,
      commits: { base: BASE, head: SHA },
      artifact: { kind: 'implement-notes', rev: 0 },
    })
    expect(
      (await h.store.getEvents(SLUG)).filter((e) => e.type === 'implement.completed'),
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
})

async function seedRestackPublication() {
  const h = await seed()
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

describe('settlePendingPublication: ticket-wait commits', () => {
  const waitRequest = (h: Awaited<ReturnType<typeof seed>>) =>
    h.store.append(SLUG, {
      actor: agentActor('implement', 'session-1'),
      type: 'publication.requested',
      payload: { operation: 'wait', id: 'wait_1', branch: BRANCH, sha: SHA, base: BASE },
    })

  test('an abandoned unpublished wait request is recorded lost', async () => {
    const h = await seed()
    const requested = await waitRequest(h)
    await h.store.append(SLUG, {
      actor: DISPATCHER,
      type: 'workspace.released',
      payload: { ref: 'sandbox-1', reason: 'replacement' },
    })
    h.deps.publication = { isPublished: async () => false, publish: async () => {} }
    await settlePendingPublication(h.deps, SLUG)
    const lost = (await h.store.getEvents(SLUG)).filter((e) => e.type === 'publication.lost')
    expect(lost.map((e) => e.payload)).toEqual([
      expect.objectContaining({ request: requested.seq, operation: 'wait', sha: SHA }),
    ])
  })
})

test('legacy loss with unavailable-inspection preserves guarded publication behavior', async () => {
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
    throw new Error('transport unavailable')
  }
  let calls = 0
  h.deps.publication!.rewrite = async () => {
    calls++
    return { kind: 'published' }
  }
  await expect(settlePendingPublication(h.deps, SLUG)).rejects.toThrow('transport unavailable')
  expect(calls).toBe(0)
  const events = await h.store.getEvents(SLUG)
  expect(events.filter((event) => event.type === 'publication.candidate-retired')).toHaveLength(0)
  expect(events.filter((event) => event.type === 'reconcile.completed')).toHaveLength(0)
})
