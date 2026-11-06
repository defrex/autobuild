import { temporaryDirectories as ownTempDirectories } from '../testing/temp-directories'
import { afterEach, expect, test } from 'bun:test'
import { chmod, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DISPATCHER, humanActor } from '../events/envelope'
import { LocalBuildExecution } from '../ports/workspace/local-build-execution'
import { openLocalStore } from '../store/local/store'
import { bulkControlRepository } from '../cli/bulk-control'
import { reduceBuild } from '../kernel/reducer'

const mkdtemp = ownTempDirectories(afterEach)

test('local pause stops the runner and native subprocess; reattachment continues the native identity', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ab-pause-process-'))
  const store = openLocalStore(join(root, 'store'))
  const workspace = join(root, 'workspace')
  const bin = join(root, 'bin')
  const slug = 'pause-process'
  const ticket = { source: 'file', id: 'P-1', title: 'Pause' }
  const handles: Awaited<ReturnType<LocalBuildExecution['start']>>[] = []
  try {
    await Promise.all([mkdir(workspace), mkdir(bin)])
    const executable = join(bin, 'claude')
    const nativeFixture = new URL('../ports/runner/native-cli-fixture.ts', import.meta.url).pathname
    await writeFile(executable, `#!/bin/sh\nexec '${process.execPath}' '${nativeFixture}' "$@"\n`)
    await chmod(executable, 0o755)
    for (const buildSlug of [slug, `${slug}-remote`]) {
      const buildWorkspace = buildSlug === slug ? workspace : join(root, 'remote-workspace')
      if (buildSlug !== slug) await mkdir(buildWorkspace)
      await store.createBuild({
        slug: buildSlug,
        repo: 'fixture/repo',
        ticket,
        branch: 'ab/pause-process',
      })
      await store.append(buildSlug, {
        actor: DISPATCHER,
        type: 'build.created',
        payload: { ticket, repo: 'fixture/repo', baseBranch: 'main' },
      })
      await store.append(buildSlug, {
        actor: DISPATCHER,
        type: 'workspace.provisioned',
        payload: {
          provider: 'git-worktree',
          ref: buildWorkspace,
          remote: buildSlug !== slug,
          branch: 'ab/pause-process',
          base: { source: 'remote', sha: '0'.repeat(40) },
        },
      })
      await store.appendWithArtifacts(
        buildSlug,
        [{ kind: 'spec', content: 'Pause' }],
        (artifacts) => ({
          actor: DISPATCHER,
          type: 'spec.imported',
          payload: { ticket, artifact: { kind: 'spec', rev: artifacts[0]!.revision } },
        }),
      )
    }
    const execution = new LocalBuildExecution({
      entrypoint: new URL('./pause-execution-fixture.ts', import.meta.url).pathname,
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        AB_NATIVE_FIXTURE_PROVIDER: 'claude',
        AB_NATIVE_FIXTURE_STATE: root,
        AB_NATIVE_FIXTURE_RELEASE: join(root, 'never-release'),
      },
    })
    const waitFor = async (predicate: () => Promise<boolean>) => {
      const deadline = Date.now() + 7000
      while (!(await predicate())) {
        if (Date.now() >= deadline) throw new Error('pause process deadline exceeded')
        await Bun.sleep(10)
      }
    }
    const launch = async (buildSlug = slug) => {
      const handle = await execution.start({
        slug: buildSlug,
        storeRef: join(root, 'store'),
        workspaceRef: buildSlug === slug ? workspace : join(root, 'remote-workspace'),
        instance: 'fixture-runner',
      })
      handles.push(handle)
      return handle
    }
    const first = await launch()
    const remote = await launch(`${slug}-remote`)
    await waitFor(async () =>
      (await store.getEvents(`${slug}-remote`)).some(
        (e) => e.type === 'session.native-handle-recorded',
      ),
    )
    await waitFor(async () =>
      (await store.getEvents(slug)).some((e) => e.type === 'session.native-handle-recorded'),
    )
    const bulk = await bulkControlRepository({
      store,
      repo: 'fixture/repo',
      direction: 'pause',
      user: 'operator',
    })
    expect(bulk.slugs.sort()).toEqual([slug, `${slug}-remote`].sort())
    await waitFor(
      async () => reduceBuild(await store.getEvents(`${slug}-remote`)).status === 'paused',
    )
    expect((await remote.completion).exitCode).toBe(0)
    expect(
      (await store.getEvents(`${slug}-remote`)).filter((e) => e.type === 'session.suspended'),
    ).toHaveLength(1)
    await waitFor(async () => reduceBuild(await store.getEvents(slug)).status === 'paused')
    expect((await first.completion).exitCode).toBe(0)
    expect(() => process.kill(first.pid!, 0)).toThrow()
    const suspended = (await store.getEvents(slug)).find((e) => e.type === 'session.suspended')!
    expect(suspended.type).toBe('session.suspended')
    if (suspended.type !== 'session.suspended') throw new Error('missing suspension')
    await store.append(slug, {
      actor: humanActor('operator'),
      type: 'build.resume-requested',
      payload: {},
    })
    const second = await launch()
    await waitFor(async () =>
      (await store.getEvents(slug)).some((e) => e.type === 'session.resumed'),
    )
    await store.append(slug, {
      actor: humanActor('operator'),
      type: 'build.pause-requested',
      payload: {},
    })
    await waitFor(async () => reduceBuild(await store.getEvents(slug)).status === 'paused')
    expect((await second.completion).exitCode).toBe(0)
    const log = await store.getEvents(slug)
    const resumed = log.find((e) => e.type === 'session.resumed')!
    if (resumed.type !== 'session.resumed') throw new Error('missing continuation')
    expect(resumed.payload.handle.nativeId).toBe(suspended.payload.handle!.nativeId)
    expect(log.filter((e) => e.type === 'session.started' && !e.payload.continuation)).toHaveLength(
      1,
    )
    expect(log.filter((e) => e.type === 'phase.failed')).toHaveLength(0)
  } finally {
    await Promise.all(handles.map((handle) => handle.stop()))
    await store.close()
    await rm(root, { recursive: true, force: true })
  }
}, 20000)
