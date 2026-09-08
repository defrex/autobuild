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
import { BUILD_RUNNER_OPTIONS_ENV } from '../ports/workspace/local-build-execution'
import { runBuildChild } from './build-child'

const config = parseConfig(`forge = "local-git"
[roles.default]
runtime = "pi"
[tickets]
source = "file"
readyState = "ready"
`)

test('the real entrypoint stays alive past the local watchdog interval in environment mode', async () => {
  const tmp = await mkdtemp(join(tmpdir(), 'ab-build-child-environment-'))
  const stateRoot = join(tmp, 'store')
  const workspace = join(tmp, 'workspace')
  const slug = 'environment-supervision'
  const instance = 'environment-child-1'
  const store = openLocalStore(stateRoot)
  let child: ReturnType<typeof Bun.spawn> | undefined
  try {
    await mkdir(workspace, { recursive: true })
    await store.createBuild({
      slug,
      repo: tmp,
      branch: `ab/${slug}`,
      ticket: { source: 'file', id: 'T-ENV', title: 'Environment supervision' },
    })
    await store.append(slug, {
      actor: DISPATCHER,
      type: 'build.created',
      payload: {
        ticket: { source: 'file', id: 'T-ENV', title: 'Environment supervision' },
        repo: tmp,
        baseBranch: 'main',
      },
    })
    await store.append(slug, {
      actor: DISPATCHER,
      type: 'workspace.provisioned',
      payload: {
        provider: 'vercel-sandbox',
        ref: 'sandbox-environment',
        path: workspace,
        branch: `ab/${slug}`,
        base: { source: 'remote', sha: 'base-sha' },
      },
    })
    const slowConfig = parseConfig(`forge = "local-git"
[roles.default]
runtime = "pi"
[tickets]
source = "file"
readyState = "ready"
[commands]
setup = "sleep 2"
`)
    await store.putArtifact(slug, {
      kind: BUILD_EFFECTIVE_CONFIG_ARTIFACT,
      content: effectiveBuildConfigContent(slowConfig),
    })
    await store.close()

    child = Bun.spawn(
      [process.execPath, new URL('../../../../bin/ab-build-runner.ts', import.meta.url).pathname],
      {
        env: {
          ...process.env,
          [BUILD_RUNNER_OPTIONS_ENV]: JSON.stringify({
            slug,
            storeRef: stateRoot,
            instance,
            workspaceRef: 'sandbox-environment',
            supervision: { kind: 'environment' },
          }),
        },
        stdin: 'ignore',
        stdout: 'ignore',
        stderr: 'ignore',
      },
    )
    await Bun.sleep(700)
    expect(child.exitCode).toBeNull()
    child.kill('SIGTERM')
    await child.exited
  } finally {
    if (child?.exitCode === null) {
      child.kill('SIGKILL')
      await child.exited
    }
    try {
      await store.close()
    } catch {
      // Closed before the subprocess opens the same SQLite store.
    }
    await rm(tmp, { recursive: true, force: true })
  }
}, 10_000)

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
        { slug, storeRef: stateRoot, instance: 'child-1', workspaceRef: durableWorkspace },
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
