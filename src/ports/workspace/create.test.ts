import { describe, expect, test } from 'bun:test'
import { resolve } from 'node:path'
import type { WorkspaceProvider } from '../types'
import { FakeWorkspaceProvider } from './fake'
import { GitWorktreeProvider } from './git-worktree'
import { createPluginRegistry } from '../../plugins/registry'
import { createWorkspaceProvider } from './create'

const baseOpts = () => ({
  registry: createPluginRegistry(),
  worktreeRoot: './state/worktrees',
  repoRoot: './repo',
  env: { TOKEN: 'secret', EMPTY: undefined },
})

describe('createWorkspaceProvider', () => {
  test('constructs the git-worktree builtin by default with the selected scratch root', async () => {
    const provider = await createWorkspaceProvider(
      { provider: 'git-worktree', config: {} },
      baseOpts(),
    )
    expect(provider).toBeInstanceOf(GitWorktreeProvider)
    expect(provider.name).toBe('git-worktree')
    expect((provider as unknown as { root: string }).root).toBe(
      resolve('./state/worktrees'),
    )
  })

  test('plugin factories stay lazy and receive exact config, env, and absolute repo root', async () => {
    const opts = baseOpts()
    const selected = new FakeWorkspaceProvider({ mode: 'logical' })
    const calls: unknown[] = []
    opts.registry.register({
      name: 'containers',
      apiVersion: '^1.0.0',
      workspaceProviders: {
        podman: (context) => {
          calls.push(context)
          return selected
        },
      },
    })
    expect(calls).toEqual([])

    const provider = await createWorkspaceProvider(
      {
        provider: 'podman',
        config: { image: 'bun:latest', nested: { writable: true } },
      },
      opts,
    )
    expect(provider).toBe(selected)
    expect(calls).toEqual([
      {
        config: { image: 'bun:latest', nested: { writable: true } },
        env: opts.env,
        repoRoot: resolve('./repo'),
      },
    ])
  })

  test('unknown selectors list every available provider deterministically', async () => {
    const opts = baseOpts()
    const factory = (): WorkspaceProvider =>
      new FakeWorkspaceProvider({ mode: 'logical' })
    opts.registry.register({
      name: 'extra',
      apiVersion: '^1.0.0',
      workspaceProviders: { zeta: factory, alpha: factory },
    })
    await expect(
      createWorkspaceProvider({ provider: 'missing', config: {} }, opts),
    ).rejects.toThrow(
      'unknown workspace provider "missing"; available providers: alpha, git-worktree, zeta',
    )
  })

  test('selected plugin initialization failures retain selector context', async () => {
    const opts = baseOpts()
    opts.registry.register({
      name: 'broken',
      apiVersion: '^1.0.0',
      workspaceProviders: {
        container: () => {
          throw new Error('daemon unavailable')
        },
      },
    })
    await expect(
      createWorkspaceProvider({ provider: 'container', config: {} }, opts),
    ).rejects.toThrow(
      'workspace provider "container" failed to initialize: daemon unavailable',
    )
  })
})
