/**
 * `ab wait-on` (SPEC §11 "Ticket waits"): every local refusal writes nothing,
 * and a declaration appends exactly one `wait.requested` that ends the
 * session's terminal allowance.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { DISPATCHER } from '../events/envelope'
import type { Exec } from '../ports/workspace/git-worktree'
import { FakeForge } from '../ports/forge/fake'
import type { MemoryBuildStore } from '../store/memory'
import { escalate, waitOn } from './terminals'
import { BRANCH, BUILD, makeDeps, makeEnv, seedStore } from './testkit'

let store: MemoryBuildStore

const BASE = 'a'.repeat(40)
const HEAD = 'b'.repeat(40)

/** Scripted git for an implement declaration: `status` output and HEAD. */
function git(opts: { head?: string; status?: string } = {}): Exec & { calls: string[][] } {
  const calls: string[][] = []
  const exec = async (cmd: string[]) => {
    calls.push(cmd)
    const ok = (stdout: string) => ({ stdout, stderr: '', exitCode: 0 })
    switch (cmd[1]) {
      case 'status':
        return ok(opts.status ?? '')
      case 'rev-parse':
        return ok(`${opts.head ?? BASE}\n`)
      case 'merge-base':
      case 'rev-list':
        return ok('')
      default:
        throw new Error(`unexpected command: ${cmd.join(' ')}`)
    }
  }
  return Object.assign(exec, { calls })
}

async function provision(remote = false) {
  await store.append(BUILD, {
    actor: DISPATCHER,
    type: 'workspace.provisioned',
    payload: {
      provider: remote ? 'vercel-sandbox' : 'worktree',
      ref: '/ws/build',
      branch: BRANCH,
      base: { source: 'remote', sha: BASE },
      ...(remote ? { remote: true } : {}),
    },
  })
}

beforeEach(async () => {
  store = await seedStore()
})

afterEach(async () => {
  await store.close()
})

const deps = (exec: Exec = git(), forge?: FakeForge) =>
  makeDeps({ store, env: makeEnv({ phase: 'implement', round: 2 }), exec, forge })
const eventCount = async () => (await store.getEvents(BUILD)).length

describe('ab wait-on', () => {
  test('local refusals append nothing', async () => {
    const before = await eventCount()
    const cases: [string[], string, RegExp][] = [
      [[], 'reason', /one or more nonblank ticket ids/],
      [['ENG-7', ' '], 'reason', /nonblank ticket ids/],
      [['ENG-7', ' ENG-7'], 'reason', /more than once/],
      [Array.from({ length: 21 }, (_, i) => `ENG-${i + 100}`), 'reason', /at most 20/],
      [['ENG-7'], '   ', /requires --reason/],
      [['ENG-42'], 'reason', /this build's own ticket/],
    ]
    for (const [tickets, reason, message] of cases)
      await expect(waitOn(deps(), { tickets, reason })).rejects.toThrow(message)
    expect(await eventCount()).toBe(before)
  })

  test('a node build cannot declare a wait', async () => {
    await store.append(BUILD, {
      actor: DISPATCHER,
      type: 'build.created',
      payload: {
        kind: 'node',
        ticket: { source: 'linear', id: 'ENG-42' },
        repo: 'acme/app',
        baseBranch: 'main',
      },
    })
    const before = await eventCount()
    await expect(waitOn(deps(), { tickets: ['ENG-7'], reason: 'r' })).rejects.toThrow(
      /a node build cannot declare a ticket wait/,
    )
    expect(await eventCount()).toBe(before)
  })

  test('a declaration appends one wait.requested and is the session terminal', async () => {
    await provision()
    const event = await waitOn(deps(), {
      tickets: [' ENG-7', 'ENG-8'],
      reason: ' needs the ENG-7 schema ',
    })
    expect(event.type).toBe('wait.requested')
    expect(event.actor).toEqual({ kind: 'agent', role: 'implement', session: 's_test' })
    expect(event.payload).toEqual({
      id: 'wait_1',
      phase: 'implement',
      round: 2,
      tickets: ['ENG-7', 'ENG-8'],
      reason: 'needs the ENG-7 schema',
    })
    const after = await eventCount()
    await expect(waitOn(deps(), { tickets: ['ENG-9'], reason: 'again' })).rejects.toThrow(
      /already declared a wait/,
    )
    await expect(escalate(deps(), { question: 'and a question' })).rejects.toThrow(
      /already declared a wait/,
    )
    expect(await eventCount()).toBe(after)
  })

  test('a session that already escalated cannot declare a wait', async () => {
    await escalate(deps(), { question: 'which API?' })
    await expect(waitOn(deps(), { tickets: ['ENG-7'], reason: 'r' })).rejects.toThrow(
      /already escalated/,
    )
  })

  describe('concurrent verifiers', () => {
    const verifier = (step: string, session: string) => {
      const out = makeDeps({ store, env: makeEnv({ phase: `verify:${step}`, round: 1, session }) })
      out.ids = (prefix) => `${prefix}_${step}`
      return out
    }
    const waits = async () =>
      (await store.getEvents(BUILD)).filter((event) => event.type === 'wait.requested')

    test('a second session cannot replace an undecided wait', async () => {
      await waitOn(verifier('a', 's_a'), { tickets: ['ENG-7'], reason: 'needs ENG-7' })
      await expect(
        waitOn(verifier('b', 's_b'), { tickets: ['ENG-8'], reason: 'needs ENG-8' }),
      ).rejects.toThrow(/session "s_a" already declared wait "wait_a" on ENG-7/)
      expect((await waits()).map((event) => event.payload.id)).toEqual(['wait_a'])
      // The other session keeps its ordinary terminals.
      await escalate(verifier('b', 's_b'), { question: 'also needs ENG-8' })
    })

    test('the declaration that loses the append race is refused, not lost', async () => {
      const b = verifier('b', 's_b')
      const append = store.appendWithArtifactsIfCurrent.bind(store)
      let raced = false
      b.store = Object.assign(Object.create(store), {
        appendWithArtifactsIfCurrent: async (...args: Parameters<typeof append>) => {
          if (!raced) {
            raced = true
            await waitOn(verifier('a', 's_a'), { tickets: ['ENG-7'], reason: 'needs ENG-7' })
          }
          return append(...args)
        },
      })
      await expect(waitOn(b, { tickets: ['ENG-8'], reason: 'needs ENG-8' })).rejects.toThrow(
        /already declared wait "wait_a"/,
      )
      expect(raced).toBe(true)
      expect((await waits()).map((event) => event.payload.id)).toEqual(['wait_a'])
    })

    test('a refused, ended or answered wait frees the declaration', async () => {
      const ends = [
        (id: string) => ({
          type: 'wait.refused' as const,
          payload: {
            id,
            cause: 'unknown-ticket' as const,
            tickets: ['ENG-7'],
            message: 'no such ticket',
          },
        }),
        (id: string) => ({
          type: 'wait.ended' as const,
          payload: { id, cause: 'operator' as const, message: 'ended' },
        }),
      ]
      for (const [index, end] of ends.entries()) {
        const step = `s${index}`
        await waitOn(verifier(step, `s_${step}`), { tickets: ['ENG-7'], reason: 'r' })
        await store.append(BUILD, { actor: DISPATCHER, ...end(`wait_${step}`) })
      }
      await waitOn(verifier('c', 's_c'), { tickets: ['ENG-7'], reason: 'r' })
      await store.append(BUILD, {
        actor: DISPATCHER,
        type: 'wait.entered',
        payload: {
          id: 'wait_c',
          escalation: 'esc_wait',
          tickets: [{ source: 'linear', id: 'ENG-7' }],
          reason: 'r',
          question: 'waiting on ENG-7',
        },
      })
      await expect(
        waitOn(verifier('d', 's_d'), { tickets: ['ENG-8'], reason: 'r' }),
      ).rejects.toThrow(/already declared wait "wait_c"/)
      await store.append(BUILD, {
        actor: { kind: 'human' as const, user: 'operator' },
        type: 'escalation.answered',
        payload: { id: 'esc_wait', answer: 'go on', resolution: 'retry' },
      })
      await waitOn(verifier('d', 's_d'), { tickets: ['ENG-8'], reason: 'r' })
      expect((await waits()).map((event) => event.payload.id)).toEqual([
        'wait_s0',
        'wait_s1',
        'wait_c',
        'wait_d',
      ])
    })
  })

  describe('implement publishes its commits first', () => {
    test('a dirty worktree is refused and writes nothing', async () => {
      await provision()
      const before = await eventCount()
      await expect(
        waitOn(deps(git({ status: ' M src/a.ts' })), { tickets: ['ENG-7'], reason: 'r' }),
      ).rejects.toThrow(/'ab wait-on' in implement requires a clean worktree/)
      expect(await eventCount()).toBe(before)
    })

    test('a local workspace pushes before declaring', async () => {
      await provision()
      const forge = new FakeForge()
      const event = await waitOn(deps(git({ head: HEAD }), forge), {
        tickets: ['ENG-7'],
        reason: 'r',
      })
      expect(forge.pushes).toEqual([{ workspacePath: '/nonexistent-workspace', branch: BRANCH }])
      expect(event.payload.publication).toEqual({
        branch: BRANCH,
        base: BASE,
        sha: HEAD,
        settlement: 'published',
      })
    })

    test('a failed push writes nothing', async () => {
      await provision()
      const forge = new FakeForge()
      forge.pushBranch = async () => {
        throw new Error('push rejected')
      }
      const before = await eventCount()
      await expect(
        waitOn(deps(git({ head: HEAD }), forge), { tickets: ['ENG-7'], reason: 'r' }),
      ).rejects.toThrow(/push rejected/)
      expect(await eventCount()).toBe(before)
    })

    test('a remote workspace requests publication, then declares', async () => {
      await provision(true)
      const forge = new FakeForge()
      await waitOn(deps(git({ head: HEAD }), forge), { tickets: ['ENG-7'], reason: 'r' })
      expect(forge.pushes).toEqual([])
      const tail = (await store.getEvents(BUILD)).slice(-2)
      expect(tail.map((event) => [event.type, event.payload])).toEqual([
        [
          'publication.requested',
          { operation: 'wait', id: 'wait_1', branch: BRANCH, sha: HEAD, base: BASE },
        ],
        [
          'wait.requested',
          expect.objectContaining({
            id: 'wait_1',
            publication: { branch: BRANCH, base: BASE, sha: HEAD, settlement: 'requested' },
          }),
        ],
      ])
    })

    test('other phases run no git', async () => {
      const exec = git()
      await waitOn(makeDeps({ store, env: makeEnv({ phase: 'plan', round: 1 }), exec }), {
        tickets: ['ENG-7'],
        reason: 'r',
      })
      expect(exec.calls).toEqual([])
    })
  })
})
