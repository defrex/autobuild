import { describe, expect, test } from 'bun:test'
import { guardForge } from '../kernel/guarded-forge'
import type { Forge } from '../ports/types'
import type { Exec } from '../ports/workspace/git-worktree'
import { MemoryBuildStore } from '../store/memory'
import { manualClock } from '../testing/fixed'
import {
  FORGE_READ_ALLOWLIST,
  fenceEffects,
  fenceExec,
  fenceForge,
  isRepositoryAuthorityLapse,
  RepositoryAuthorityLapsed,
  resolveLapsedRepoLease,
  rethrowAuthorityLapse,
} from './repo-lease'

const REPO = 'repo'
const TTL = 60_000

function leaseStore() {
  const clock = manualClock()
  const store = new MemoryBuildStore({ clock })
  return { clock, store }
}

async function rejection(promise: unknown): Promise<unknown> {
  try {
    await promise
  } catch (error) {
    return error
  }
  throw new Error('expected a rejection')
}

describe('resolveLapsedRepoLease', () => {
  test('reclaims its own expired lease and extends the expiry', async () => {
    const { clock, store } = leaseStore()
    await store.ensureRepo(REPO)
    expect(await store.claimRepoLease(REPO, 'me', TTL)).toBe(true)
    clock.advance(TTL + 1_000)
    expect(await store.heartbeatRepo(REPO, 'me')).toBe(false)
    expect(await resolveLapsedRepoLease(store, REPO, 'me', TTL)).toBe('held')
    const lease = (await store.getRepo(REPO))?.lease
    expect(lease?.holder).toBe('me')
    expect(Date.parse(lease!.expiresAt)).toBe(clock().getTime() + TTL)
  })

  test('a peer holding an unexpired lease supersedes without a claim', async () => {
    const { clock, store } = leaseStore()
    await store.ensureRepo(REPO)
    await store.claimRepoLease(REPO, 'me', TTL)
    clock.advance(TTL + 1)
    await store.claimRepoLease(REPO, 'peer', TTL)
    const claim = store.claimRepoLease.bind(store)
    let claims = 0
    store.claimRepoLease = async (...args) => {
      claims++
      return claim(...args)
    }
    expect(await resolveLapsedRepoLease(store, REPO, 'me', TTL)).toBe('superseded')
    expect(claims).toBe(0)
  })

  test('a peer whose lease also expired still supersedes, and keeps the record', async () => {
    const { clock, store } = leaseStore()
    await store.ensureRepo(REPO)
    await store.claimRepoLease(REPO, 'me', TTL)
    clock.advance(TTL + 1)
    await store.claimRepoLease(REPO, 'peer', TTL)
    clock.advance(TTL + 1)
    expect(await resolveLapsedRepoLease(store, REPO, 'me', TTL)).toBe('superseded')
    expect((await store.getRepo(REPO))?.lease?.holder).toBe('peer')
  })

  test('an absent record means a peer claimed and released it', async () => {
    const { store } = leaseStore()
    await store.ensureRepo(REPO)
    expect(await resolveLapsedRepoLease(store, REPO, 'me', TTL)).toBe('superseded')
    expect((await store.getRepo(REPO))?.lease ?? undefined).toBeUndefined()
  })

  test('a throwing read or claim is unknown', async () => {
    const failingRead = {
      getRepo: async () => {
        throw new Error('down')
      },
      claimRepoLease: async () => true,
    }
    expect(await resolveLapsedRepoLease(failingRead, REPO, 'me', TTL)).toBe('unknown')
    const failingClaim = {
      getRepo: async () => ({ lease: { holder: 'me' } }),
      claimRepoLease: async (): Promise<boolean> => {
        throw new Error('down')
      },
    }
    expect(await resolveLapsedRepoLease(failingClaim, REPO, 'me', TTL)).toBe('unknown')
  })

  for (const order of [
    ['a', 'b'],
    ['b', 'a'],
  ] as const) {
    test(`two runs waking to an expired lease leave exactly one holder (${order.join(' then ')})`, async () => {
      const { clock, store } = leaseStore()
      await store.ensureRepo(REPO)
      await store.claimRepoLease(REPO, 'a', TTL)
      clock.advance(TTL + 1)
      // `b` is a standby: it claims the expired lease the ordinary way.
      const outcomes: Record<string, string> = {}
      for (const run of order) {
        outcomes[run] =
          run === 'a'
            ? await resolveLapsedRepoLease(store, REPO, 'a', TTL)
            : (await store.claimRepoLease(REPO, 'b', TTL))
              ? 'held'
              : 'standby'
      }
      const holder = (await store.getRepo(REPO))?.lease?.holder
      expect(Object.values(outcomes).filter((outcome) => outcome === 'held')).toHaveLength(1)
      expect(outcomes[holder!]).toBe('held')
      expect(outcomes).toEqual(
        order[0] === 'a' ? { a: 'held', b: 'standby' } : { a: 'superseded', b: 'held' },
      )
    })
  }
})

describe('lapse errors', () => {
  test('are recognised and rethrown, other errors are not', () => {
    const lapse = new RepositoryAuthorityLapsed()
    expect(isRepositoryAuthorityLapse(lapse)).toBe(true)
    expect(isRepositoryAuthorityLapse(new Error('x'))).toBe(false)
    expect(() => rethrowAuthorityLapse(lapse)).toThrow(RepositoryAuthorityLapsed)
    expect(() => rethrowAuthorityLapse(new Error('x'))).not.toThrow()
  })
})

/** A guard backed by a flag, like the loop's deadline comparison. */
function authority() {
  const state = { held: true }
  return {
    state,
    guard: () => {
      if (!state.held) throw new RepositoryAuthorityLapsed()
    },
  }
}

describe('fenceEffects', () => {
  class Port {
    #secret = 'private'
    readonly name = 'port'
    calls: string[] = []
    async claim(id: string): Promise<boolean> {
      this.calls.push(`claim ${id} ${this.#secret}`)
      return true
    }
    async get(id: string): Promise<string> {
      this.calls.push(`get ${id} ${this.#secret}`)
      return id
    }
    publication = {
      calls: [] as string[],
      async publish(this: { calls: string[] }, ref: string) {
        this.calls.push(`publish ${ref}`)
      },
      async isPublished() {
        return true
      },
    }
  }

  test('a listed method refuses without reaching the port, even after an await flipped the guard', async () => {
    const { state, guard } = authority()
    const port = new Port()
    const fenced = fenceEffects(port, { methods: ['claim'] }, guard)
    expect(await fenced.claim('a')).toBe(true)
    const pending = (async () => {
      await Promise.resolve()
      return fenced.claim('b')
    })()
    state.held = false
    expect(isRepositoryAuthorityLapse(await rejection(pending))).toBe(true)
    expect(port.calls).toEqual(['claim a private'])
  })

  test('unlisted methods, properties, `this`, private fields and the prototype pass through', async () => {
    const { state, guard } = authority()
    state.held = false
    const port = new Port()
    const fenced = fenceEffects(port, { methods: ['claim'] }, guard)
    expect(await fenced.get('x')).toBe('x')
    expect(fenced.name).toBe('port')
    expect(fenced instanceof Port).toBe(true)
    expect(port.calls).toEqual(['get x private'])
  })

  test('nested capabilities are fenced by their own lists', async () => {
    const { state, guard } = authority()
    const port = new Port()
    const fenced = fenceEffects(
      port,
      { methods: [], nested: { publication: { methods: ['publish'] } } },
      guard,
    )
    expect(fenced.publication).toBe(fenced.publication)
    await fenced.publication.publish('r1')
    state.held = false
    expect(isRepositoryAuthorityLapse(await rejection(fenced.publication.publish('r2')))).toBe(true)
    expect(await fenced.publication.isPublished()).toBe(true)
    expect(port.publication.calls).toEqual(['publish r1'])
  })

  test('frozen plugin members and frozen nested capabilities are still fenced', async () => {
    const { state, guard } = authority()
    state.held = false
    const calls: string[] = []
    const provider = Object.freeze({
      async provision(id: string) {
        calls.push(`provision ${id}`)
      },
      async inspect() {
        return 'ok'
      },
      buildExecution: Object.freeze({
        async start(id: string) {
          calls.push(`start ${id}`)
        },
      }),
    })
    const fenced = fenceEffects(
      provider,
      { methods: ['provision'], nested: { buildExecution: { methods: ['start'] } } },
      guard,
    )
    expect(isRepositoryAuthorityLapse(await rejection(fenced.provision('p')))).toBe(true)
    expect(isRepositoryAuthorityLapse(await rejection(fenced.buildExecution.start('s')))).toBe(true)
    expect(await fenced.inspect()).toBe('ok')
    expect(Object.keys(fenced)).toEqual(['provision', 'inspect', 'buildExecution'])
    expect(calls).toEqual([])

    const port = Object.freeze(new Port())
    const fencedPort = fenceEffects(port, { methods: ['claim'] }, guard)
    expect(fencedPort instanceof Port).toBe(true)
    expect(isRepositoryAuthorityLapse(await rejection(fencedPort.claim('c')))).toBe(true)
    expect(await fencedPort.get('g')).toBe('g')
    expect(port.calls).toEqual(['get g private'])
  })
})

describe('fenceExec', () => {
  test('refuses only git push without authority', async () => {
    const { state, guard } = authority()
    const seen: string[][] = []
    const exec: Exec = async (cmd) => {
      seen.push(cmd)
      return { exitCode: 0, stdout: '', stderr: '' }
    }
    const fenced = fenceExec(exec, guard)
    state.held = false
    expect(
      isRepositoryAuthorityLapse(
        await rejection(fenced(['git', 'push', 'origin', 'HEAD:refs/heads/x'], {})),
      ),
    ).toBe(true)
    await fenced(['git', 'fetch', 'origin'], {})
    await fenced(['ls'], {})
    expect(seen).toEqual([['git', 'fetch', 'origin'], ['ls']])
  })
})

describe('fenceForge', () => {
  function recordingForge() {
    const calls: string[] = []
    const record =
      (name: string) =>
      async (..._args: unknown[]): Promise<never> => {
        calls.push(name)
        return undefined as never
      }
    const rewrite = {
      replace: record('rewrite.replace'),
      fastForward: record('rewrite.fastForward'),
      snapshot: record('rewrite.snapshot'),
      archive: record('rewrite.archive'),
    }
    const forge: Record<string, unknown> = {
      name: 'recording',
      closesIssues: true,
      rewrite,
      kernelRewrite: {
        replace: record('kernelRewrite.replace'),
        snapshot: record('kernelRewrite.snapshot'),
        archive: record('kernelRewrite.archive'),
      },
      prAttachments: { upload: record('prAttachments.upload'), reclaim: record('reclaim') },
      pushBranch: record('pushBranch'),
      openPr: record('openPr'),
      pluginWrite: record('pluginWrite'),
      kernelExec: (async (cmd: string[]) => {
        calls.push(`kernelExec ${cmd.join(' ')}`)
        return { exitCode: 0, stdout: '', stderr: '' }
      }) as Exec,
    }
    for (const name of FORGE_READ_ALLOWLIST)
      if (name !== 'observeRequests' && name !== 'withReadScope') forge[name] = record(name)
    forge.observeRequests = () => () => {}
    forge.withReadScope = async (work: () => Promise<unknown>) => work()
    return { forge: forge as unknown as Forge, calls }
  }

  test('without authority every effect at any depth refuses and every read passes', async () => {
    const { state, guard } = authority()
    const { forge, calls } = recordingForge()
    const fenced = fenceForge(forge, guard) as unknown as Record<string, unknown> & Forge
    state.held = false
    const effects: Array<() => unknown> = [
      () => fenced.rewrite!.replace({} as never),
      () => fenced.kernelRewrite!.replace({} as never),
      () => fenced.rewrite!.fastForward!({} as never),
      () => fenced.rewrite!.snapshot({} as never),
      () => fenced.rewrite!.archive({} as never),
      () => fenced.prAttachments!.upload({} as never),
      () => fenced.pushBranch('w', 'b'),
      () => (fenced.pluginWrite as () => Promise<void>)(),
      () => fenced.kernelExec!(['git', 'push', 'origin', 'x'], {}),
    ]
    for (const effect of effects)
      expect(isRepositoryAuthorityLapse(await rejection(effect()))).toBe(true)
    expect(calls).toEqual([])

    for (const name of FORGE_READ_ALLOWLIST) {
      if (name === 'observeRequests') {
        expect(typeof fenced.observeRequests!(() => {})).toBe('function')
        continue
      }
      if (name === 'withReadScope') {
        expect(await fenced.withReadScope!(async () => 'scoped')).toBe('scoped')
        continue
      }
      await (fenced[name] as () => Promise<unknown>)()
    }
    await fenced.kernelExec!(['git', 'fetch', 'origin'], {})
    expect(fenced.name).toBe('recording')
    expect(fenced.closesIssues).toBe(true)
    expect(calls).toEqual([
      ...FORGE_READ_ALLOWLIST.filter(
        (name) => name !== 'observeRequests' && name !== 'withReadScope',
      ),
      'kernelExec git fetch origin',
    ])
  })

  test('a kernelForge-style proxy that maps rewrite to kernelRewrite is still fenced', async () => {
    const { state, guard } = authority()
    const { forge, calls } = recordingForge()
    const fenced = fenceForge(forge, guard)
    const kernelForge = new Proxy(fenced, {
      get: (target, key) =>
        key === 'rewrite' ? target.kernelRewrite : Reflect.get(target, key, target),
    })
    state.held = false
    expect(
      isRepositoryAuthorityLapse(await rejection(kernelForge.rewrite!.replace({} as never))),
    ).toBe(true)
    expect(calls).toEqual([])
  })

  test('sits under guardForge without doubling the guard', () => {
    const { guard } = authority()
    const { forge } = recordingForge()
    const store = new MemoryBuildStore({ clock: manualClock() })
    const deps = { store, repo: REPO, name: 'github' }
    const guarded = guardForge(fenceForge(forge, guard), deps)
    expect(guardForge(guarded, deps)).toBe(guarded)
  })
})
