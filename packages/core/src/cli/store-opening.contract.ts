/**
 * Shared behavioral contract for finite sessionless commands that own a
 * BuildStore. Register this against distinct command shells so selection,
 * credentials, production composition, and cleanup cannot drift per command.
 */
import { describe, expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Exec } from '../ports/workspace/git-worktree'
import { MemoryBuildStore } from '../store/memory'
import { startStoreServer } from '../store/remote/server'
import { mintToken } from '../store/remote/token'
import type { BuildStore } from '../store/types'
import type { StoreOpener } from './store-opening'

const MAIN_REPO = '/main/repo'
const LINKED_REPO = '/linked/worktree'

const mainRepoExec: Exec = async () => ({
  stdout: `${MAIN_REPO}/.git\n${MAIN_REPO}/.git\n${MAIN_REPO}\n`,
  stderr: '',
  exitCode: 0,
})

const noGit: Exec = async () => ({
  stdout: '',
  stderr: 'not a git repository',
  exitCode: 128,
})

export interface StoreOpeningCommandOpts {
  targetRepo: string
  env: Record<string, string | undefined>
  exec: Exec
  stdout: (line: string) => void
  storeRef?: string
  openStore?: StoreOpener
}

export interface StoreOpeningCommandAdapter {
  run: (opts: StoreOpeningCommandOpts) => Promise<void>
  /** Extract a command-specific marker proving it used canonical main-repo
   * identity (for example a filtered build slug or a projected repo path). */
  canonicalMarker: (stdout: string[]) => string | undefined
  expectedCanonicalMarker: string
}

function trackedStore(
  store: MemoryBuildStore,
  opts: { failOperations?: boolean; onClose: () => void },
): BuildStore {
  return new Proxy(store, {
    get(target, prop) {
      if (prop === 'close') {
        return async () => opts.onClose()
      }
      const value = Reflect.get(target, prop, target) as unknown
      if (typeof value !== 'function') return value
      if (opts.failOperations === true) {
        return async () => {
          throw new Error('store operation failed')
        }
      }
      return value.bind(target) as unknown
    },
  }) as unknown as BuildStore
}

async function capture(
  adapter: StoreOpeningCommandAdapter,
  opts: Omit<StoreOpeningCommandOpts, 'stdout'>,
): Promise<string[]> {
  const stdout: string[] = []
  await adapter.run({ ...opts, stdout: (line) => stdout.push(line) })
  return stdout
}

export function describeStoreOpeningContract(
  name: string,
  adapter: StoreOpeningCommandAdapter,
): void {
  describe(`sessionless store-opening contract: ${name}`, () => {
    test('shares reference precedence, normalization, URL preservation, and opaque token forwarding', async () => {
      const store = new MemoryBuildStore()
      const opened: Array<{ ref: string; token?: string }> = []
      const openStore: StoreOpener = (ref, token) => {
        opened.push({ ref, ...(token !== undefined ? { token } : {}) })
        return store
      }
      const base = {
        targetRepo: LINKED_REPO,
        exec: mainRepoExec,
        openStore,
      }

      await capture(adapter, {
        ...base,
        env: { AB_STORE: 'environment' },
        storeRef: 'flag/../selected',
      })
      await capture(adapter, {
        ...base,
        env: { AB_STORE: 'environment/../selected-env' },
      })
      await capture(adapter, {
        ...base,
        env: { AB_STORE: '/absolute/state' },
        storeRef: '  ',
      })
      await capture(adapter, {
        ...base,
        env: { AB_STORE: ' \t' },
        storeRef: '',
      })
      await capture(adapter, {
        ...base,
        env: {},
        storeRef: 'http://store.example.test/api',
      })
      await capture(adapter, {
        ...base,
        env: {},
        storeRef: 'https://store.example.test/api?x=1',
      })
      await capture(adapter, {
        ...base,
        env: { AB_TOKEN: '' },
        storeRef: 'https://store.example.test/empty-token',
      })
      await capture(adapter, {
        ...base,
        env: { AB_TOKEN: ' opaque token ' },
        storeRef: 'https://store.example.test/opaque-token',
      })

      expect(opened).toEqual([
        { ref: `${MAIN_REPO}/selected` },
        { ref: `${MAIN_REPO}/selected-env` },
        { ref: '/absolute/state' },
        { ref: `${MAIN_REPO}/.autobuild` },
        { ref: 'http://store.example.test/api' },
        { ref: 'https://store.example.test/api?x=1' },
        { ref: 'https://store.example.test/empty-token' },
        {
          ref: 'https://store.example.test/opaque-token',
          token: ' opaque token ',
        },
      ])
    })

    test('uses canonical main-repository identity', async () => {
      const store = new MemoryBuildStore()
      await store.createBuild({ slug: 'main-build', repo: MAIN_REPO })
      await store.createBuild({ slug: 'other-build', repo: '/other/repo' })
      await store.ensureRepo(MAIN_REPO)
      const stdout = await capture(adapter, {
        targetRepo: LINKED_REPO,
        env: {},
        exec: mainRepoExec,
        openStore: () => store,
      })
      expect(adapter.canonicalMarker(stdout)).toBe(adapter.expectedCanonicalMarker)
    })

    test('closes exactly once on success, store failure, and output failure', async () => {
      const run = async (mode: 'success' | 'store' | 'output'): Promise<number> => {
        const store = new MemoryBuildStore()
        let closes = 0
        const tracked = trackedStore(store, {
          failOperations: mode === 'store',
          onClose: () => {
            closes += 1
          },
        })
        const command = adapter.run({
          targetRepo: LINKED_REPO,
          env: {},
          exec: mainRepoExec,
          openStore: () => tracked,
          stdout:
            mode === 'output'
              ? () => {
                  throw new Error('output failed')
                }
              : () => {},
        })
        if (mode === 'success') await command
        else {
          await expect(command).rejects.toThrow(
            mode === 'store' ? 'store operation failed' : 'output failed',
          )
        }
        return closes
      }

      expect(await run('success')).toBe(1)
      expect(await run('store')).toBe(1)
      expect(await run('output')).toBe(1)
    })

    test('propagates opener failure without phantom cleanup', async () => {
      let closes = 0
      const unopened = new MemoryBuildStore()
      unopened.close = async () => {
        closes += 1
      }
      await expect(
        adapter.run({
          targetRepo: LINKED_REPO,
          env: {},
          exec: mainRepoExec,
          stdout: () => {},
          openStore: () => {
            throw new Error('open failed')
          },
        }),
      ).rejects.toThrow('open failed')
      expect(closes).toBe(0)
    })

    test('production composition opens a local SQLite root', async () => {
      const repo = await mkdtemp(join(tmpdir(), 'ab-store-opening-local-'))
      try {
        await adapter.run({
          targetRepo: repo,
          env: {},
          exec: noGit,
          stdout: () => {},
          storeRef: 'state',
        })
        expect(existsSync(join(repo, 'state', 'autobuild.sqlite'))).toBe(true)
      } finally {
        await rm(repo, { recursive: true, force: true })
      }
    })

    test('production composition forwards a token to remote HTTP and rejects missing or invalid credentials', async () => {
      const secret = 'store-opening-secret'
      const now = new Date('2026-07-15T12:00:00.000Z')
      const backing = new MemoryBuildStore({ clock: () => now })
      const server = startStoreServer({
        store: backing,
        secret,
        clock: () => now,
      })
      const token = mintToken(secret, {
        build: '*',
        session: '*',
        exp: now.getTime() + 60_000,
      })
      try {
        await adapter.run({
          targetRepo: LINKED_REPO,
          env: { AB_TOKEN: token },
          exec: mainRepoExec,
          stdout: () => {},
          storeRef: server.url,
        })
        await expect(
          adapter.run({
            targetRepo: LINKED_REPO,
            env: {},
            exec: mainRepoExec,
            stdout: () => {},
            storeRef: server.url,
          }),
        ).rejects.toThrow(/missing bearer token/)
        await expect(
          adapter.run({
            targetRepo: LINKED_REPO,
            env: { AB_TOKEN: 'invalid-token' },
            exec: mainRepoExec,
            stdout: () => {},
            storeRef: server.url,
          }),
        ).rejects.toThrow(/invalid or expired token/)
      } finally {
        await server.stop()
        await backing.close()
      }
    })
  })
}
