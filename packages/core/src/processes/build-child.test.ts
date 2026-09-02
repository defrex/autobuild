import { expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseConfig } from '../config/load'
import { DISPATCHER, humanActor } from '../events/envelope'
import { openLocalStore } from '../store/local/store'
import {
  BUILD_EFFECTIVE_CONFIG_ARTIFACT,
  effectiveBuildConfigContent,
} from './build-execution-state'
import { runBuildChild } from './build-child'

const config = parseConfig(`forge = "local-git"
[roles.default]
runtime = "pi"
[tickets]
source = "file"
readyState = "ready"
`)

test('build child uses durable location and a close failure cannot falsify a clean park', async () => {
  const tmp = await mkdtemp(join(tmpdir(), 'ab-build-child-'))
  const stateRoot = join(tmp, 'store')
  const durableWorkspace = join(tmp, 'durable-workspace')
  const misleadingCwd = join(tmp, 'not-the-workspace')
  const slug = 'durable-location'
  const store = openLocalStore(stateRoot)
  try {
    await store.createBuild({
      slug,
      repo: tmp,
      branch: `ab/${slug}`,
      ticket: { source: 'file', id: 'T-1', title: 'Durable location' },
    })
    await store.append(slug, {
      actor: DISPATCHER,
      type: 'build.created',
      payload: {
        ticket: { source: 'file', id: 'T-1', title: 'Durable location' },
        repo: tmp,
        baseBranch: 'main',
      },
    })
    await store.append(slug, {
      actor: DISPATCHER,
      type: 'workspace.provisioned',
      payload: {
        provider: 'fake',
        ref: durableWorkspace,
        path: durableWorkspace,
        branch: `ab/${slug}`,
        base: { source: 'remote', sha: 'base-sha' },
      },
    })
    await store.append(slug, {
      actor: humanActor('operator'),
      type: 'build.pause-requested',
      payload: { reason: 'hold before workspace setup' },
    })
    await store.putArtifact(slug, {
      kind: BUILD_EFFECTIVE_CONFIG_ARTIFACT,
      content: effectiveBuildConfigContent(config),
    })
    await store.close()

    const original = process.cwd()
    await mkdir(misleadingCwd, { recursive: true })
    process.chdir(misleadingCwd)
    try {
      await runBuildChild(
        { slug, storeRef: stateRoot, instance: 'child-1', parentPid: process.pid },
        process.env,
        (ref) => {
          const opened = openLocalStore(ref)
          const close = opened.close.bind(opened)
          opened.close = async () => {
            await close()
            throw new Error('scripted close failure after successful park')
          }
          return opened
        },
      )
    } finally {
      process.chdir(original)
    }

    const reopened = openLocalStore(stateRoot)
    try {
      const events = await reopened.getEvents(slug)
      expect(events.at(-1)?.type).toBe('build.paused')
      expect(events.some((event) => event.type === 'runner.attached')).toBe(false)
    } finally {
      await reopened.close()
    }
  } finally {
    try {
      await store.close()
    } catch {
      // Already closed before the child opened the same SQLite file.
    }
    await rm(tmp, { recursive: true, force: true })
  }
})
