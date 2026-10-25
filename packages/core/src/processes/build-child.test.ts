import { temporaryDirectories as ownTempDirectories } from '../testing/temp-directories'
import { historicalEffectiveConfig } from '../config/effective-artifact.fixture'
import { spawnExec } from '../ports/workspace/git-worktree'
import { leafTransaction } from '../kernel/generators/leaf-restack-log'
import { afterEach, expect, test } from 'bun:test'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseConfig } from '../config/load'
import { DISPATCHER, KERNEL, agentActor, humanActor } from '../events/envelope'
import { openLocalStore } from '../store/local/store'
import { MemoryBuildStore } from '../store/memory'
import type { AbEvent, EventWrite } from '../events/catalog'
import {
  BUILD_EFFECTIVE_CONFIG_ARTIFACT,
  effectiveBuildConfigContent,
} from './build-execution-state'
import { BUILD_RUNNER_OPTIONS_ENV } from '../ports/workspace/local-build-execution'
import { runBuildChild } from './build-child'

const mkdtemp = ownTempDirectories(afterEach)

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
      content: JSON.stringify({
        ...JSON.parse(effectiveBuildConfigContent(config)),
        orchestrator: historicalEffectiveConfig(true).orchestrator,
      }),
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

test('build child captures the deposited repository opt-out and skips check and agent execution', async () => {
  const tmp = await mkdtemp(join(tmpdir(), 'ab-build-child-reconcile-policy-'))
  const slug = 'deposited-reconcile-policy'
  const store = new MemoryBuildStore()
  const ticket = { source: 'file', id: 'T-POLICY', title: 'Deposited reconcile policy' }
  try {
    await store.createBuild({ slug, repo: tmp, branch: `ab/${slug}`, ticket })
    const writes: EventWrite[] = [
      {
        actor: DISPATCHER,
        type: 'build.created',
        payload: { ticket, repo: tmp, baseBranch: 'main' },
      },
      {
        actor: DISPATCHER,
        type: 'workspace.provisioned',
        payload: {
          provider: 'fake',
          ref: tmp,
          path: tmp,
          branch: `ab/${slug}`,
          base: { source: 'remote', sha: 'base-sha' },
        },
      },
      {
        actor: DISPATCHER,
        type: 'spec.imported',
        payload: { artifact: { kind: 'spec', rev: 0 }, ticket },
      },
      {
        actor: agentActor('plan-review', 'seed-plan-review'),
        type: 'plan-review.verdict',
        payload: {
          round: 1,
          verdict: 'approve',
          findings: [],
          artifact: { kind: 'plan-review', rev: 0 },
        },
      },
      {
        actor: agentActor('code-review', 'seed-code-review'),
        type: 'code-review.verdict',
        payload: {
          round: 1,
          verdict: 'approve',
          findings: [],
          artifact: { kind: 'code-review', rev: 0 },
        },
      },
      {
        actor: KERNEL,
        type: 'verify.completed',
        payload: { step: 'check', attempt: 1, outcome: 'pass' },
      },
      {
        actor: KERNEL,
        type: 'verify.completed',
        payload: { step: 'agent', attempt: 1, outcome: 'pass' },
      },
      { actor: KERNEL, type: 'reconcile.started', payload: { attempt: 1, baseSha: 'new-base' } },
      {
        actor: agentActor('reconcile', 'seed-reconcile'),
        type: 'reconcile.completed',
        payload: { mergeCommit: 'merge-sha', artifact: { kind: 'reconcile-notes', rev: 0 } },
      },
    ]
    for (const write of writes) await store.append(slug, write)
    // Policy selection follows the mandatory entry gate; Git mechanics are
    // covered by the real-workspace restack suite.
    await store.append(slug, {
      actor: KERNEL,
      type: 'restack.completed',
      payload: {
        ...leafTransaction,
        branch: `ab/${slug}`,
        cycle: writes.length,
        headSha: 'e'.repeat(40),
      },
    })
    const configToml = `forge = "local-git"
[roles.default]
runtime = "pi"
[tickets]
source = "file"
readyState = "ready"
[commands]
check = "exit 91"
[verify]
steps = ["check", "agent"]
afterReconcile = false
[verify.check]
kind = "check"
command = "check"
[verify.agent]
kind = "agent"
skill = "must-never-launch"
`
    const config = parseConfig(configToml)
    await writeFile(join(tmp, 'autobuild.toml'), configToml)
    for (const args of [
      ['init'],
      ['config', 'user.email', 'test@example.com'],
      ['config', 'user.name', 'Test'],
      ['add', '.'],
      ['commit', '-m', 'pipeline'],
    ]) {
      const result = await spawnExec(['git', ...args], { cwd: tmp })
      expect(result.exitCode).toBe(0)
    }

    await store.putArtifact(slug, {
      kind: BUILD_EFFECTIVE_CONFIG_ARTIFACT,
      content: JSON.stringify({
        ...JSON.parse(effectiveBuildConfigContent(config)),
        orchestrator: historicalEffectiveConfig(true).orchestrator,
      }),
    })
    // Park after verification so this test exercises the real child's config
    // loading/getConfig and routing without launching a finalize agent.
    const append = store.append.bind(store)
    store.append = async (build, write) => {
      const event = await append(build, write)
      const fact = event as AbEvent
      // Fail before any repair agent could launch if the opt-out is lost.
      if (fact.type === 'verify.completed') {
        expect(fact.payload).toMatchObject({
          outcome: 'skipped',
          skipCause: 'post-reconcile-policy',
        })
      }
      if (fact.type === 'verify.completed' && fact.payload.step === 'agent') {
        await append(build, {
          actor: humanActor('test'),
          type: 'build.pause-requested',
          payload: {},
        })
      }
      return event
    }
    await runBuildChild(
      { slug, storeRef: 'memory', instance: 'policy-child', workspaceRef: tmp },
      {},
      () => store,
    )
    const events = await store.getEvents(slug)
    const policy = events.find((event) => event.type === 'verify.reconcile-policy-captured')
    expect(policy?.payload).toEqual({
      cycle: events.find((event) => event.type === 'verify.config-captured')!.seq,
      reconcileSeq: writes.length,
      steps: [
        { step: 'check', enabled: false, source: 'verify.afterReconcile' },
        { step: 'agent', enabled: false, source: 'verify.afterReconcile' },
      ],
    })
    expect(
      events
        .filter((event) => event.type === 'verify.completed')
        .slice(-2)
        .map((event) => event.payload),
    ).toEqual(
      ['check', 'agent'].map((step) => ({
        baseSha: leafTransaction.targetBase,
        headSha: 'e'.repeat(40),
        restackId: leafTransaction.id,
        step,
        attempt: 2,
        outcome: 'skipped',
        skipCause: 'post-reconcile-policy',
        reason: 'skipped by post-reconcile policy: verify.afterReconcile = false',
      })),
    )
    expect(events.some((event) => event.type === 'session.started')).toBe(false)
    expect(events.at(-1)?.type).toBe('build.paused')
  } finally {
    await store.close()
    await rm(tmp, { recursive: true, force: true })
  }
})

test('a real local child suspends on shutdown and a new child resumes the native session without resetting workspace files', async () => {
  const { signalProcessGroup } = await import('./process-group')
  const { chmod, writeFile, readFile } = await import('node:fs/promises')
  const tmp = await mkdtemp(join(tmpdir(), 'ab-native-child-'))
  const workspace = join(tmp, 'workspace')
  const nativeState = join(tmp, 'native')
  const bin = join(tmp, 'bin')
  const stateRoot = join(tmp, 'store')
  const slug = 'native-child'
  const store = openLocalStore(stateRoot)
  const children: Array<ReturnType<typeof Bun.spawn>> = []
  try {
    await Promise.all([mkdir(workspace), mkdir(nativeState), mkdir(bin)])
    const executable = join(bin, 'codex')
    await writeFile(
      executable,
      `#!/bin/sh\nexec '${process.execPath}' '${new URL('../ports/runner/native-cli-fixture.ts', import.meta.url).pathname}' "$@"\n`,
    )
    await chmod(executable, 0o755)
    const git = (args: string[]) => {
      const result = Bun.spawnSync(['git', ...args], { cwd: workspace })
      if (result.exitCode !== 0) throw new Error(new TextDecoder().decode(result.stderr))
    }
    git(['init', '-q'])
    await writeFile(join(workspace, 'committed.txt'), 'committed work')
    git(['add', 'committed.txt'])
    git([
      '-c',
      'user.name=Capture',
      '-c',
      'user.email=capture@example.test',
      'commit',
      '-qm',
      'preserve work',
    ])
    await writeFile(join(workspace, 'uncommitted.txt'), 'work in flight')
    await store.createBuild({ slug, repo: tmp, branch: `ab/${slug}` })
    await store.append(slug, {
      actor: DISPATCHER,
      type: 'build.created',
      payload: {
        repo: tmp,
        baseBranch: 'main',
        ticket: { source: 'file', id: 'NATIVE', title: 'Native continuation' },
      },
    })
    await store.append(slug, {
      actor: DISPATCHER,
      type: 'workspace.provisioned',
      payload: {
        provider: 'git-worktree',
        ref: workspace,
        path: workspace,
        localPath: workspace,
        branch: `ab/${slug}`,
        base: { source: 'remote', sha: 'base' },
      },
    })
    const spec = await store.putArtifact(slug, { kind: 'spec', content: '# Continue native work' })
    await store.append(slug, {
      actor: DISPATCHER,
      type: 'spec.imported',
      payload: {
        artifact: { kind: 'spec', rev: spec.revision },
        ticket: { source: 'file', id: 'NATIVE', title: 'Native continuation' },
      },
    })
    const config = parseConfig(
      `forge = "local-git"\n[roles.default]\nruntime = "codex"\n[tickets]\nsource = "file"\nreadyState = "ready"\n`,
    )
    await store.putArtifact(slug, {
      kind: BUILD_EFFECTIVE_CONFIG_ARTIFACT,
      content: JSON.stringify({
        ...JSON.parse(effectiveBuildConfigContent(config)),
        orchestrator: historicalEffectiveConfig(true).orchestrator,
      }),
    })
    const start = (instance: string) => {
      const child = Bun.spawn(
        [process.execPath, new URL('../../../../bin/ab-build-runner.ts', import.meta.url).pathname],
        {
          env: {
            ...process.env,
            PATH: `${bin}:${process.env.PATH}`,
            AB_NATIVE_FIXTURE_PROVIDER: 'codex',
            AB_NATIVE_FIXTURE_STATE: nativeState,
            AB_NATIVE_FIXTURE_RELEASE: join(tmp, 'never-release'),
            [BUILD_RUNNER_OPTIONS_ENV]: JSON.stringify({
              slug,
              instance,
              storeRef: stateRoot,
              workspaceRef: workspace,
              supervision: { kind: 'local-parent', parentPid: process.pid },
            }),
          },
          detached: true,
          stdin: 'ignore',
          stdout: 'ignore',
          stderr: 'ignore',
        },
      )
      children.push(child)
      return child
    }
    const waitForEvent = async (type: AbEvent['type']) => {
      const deadline = Date.now() + 8000
      for (;;) {
        const event = (await store.getEvents(slug)).find((e) => e.type === type)
        if (event) return event
        if (Date.now() > deadline)
          throw new Error(`missing ${type}: ${JSON.stringify(await store.getEvents(slug))}`)
        await Bun.sleep(20)
      }
    }
    const first = start('child-1')
    const identity = await waitForEvent('session.native-handle-recorded')
    const stoppedAt = Date.now()
    signalProcessGroup(first.pid, 'SIGINT')
    signalProcessGroup(first.pid, 'SIGTERM')
    await first.exited
    expect(Date.now() - stoppedAt).toBeLessThan(5000)
    const suspension = await waitForEvent('session.suspended')
    expect(suspension.type).toBe('session.suspended')
    await store.releaseLease(slug, 'child-1')
    const second = start('child-2')
    const acceptance = await waitForEvent('session.resumed')
    if (identity.type !== 'session.native-handle-recorded' || acceptance.type !== 'session.resumed')
      throw new Error('wrong events')
    expect(acceptance.payload.handle.nativeId).toBe(identity.payload.handle.nativeId)
    expect((await store.getEvents(slug)).filter((e) => e.type === 'plan.started')).toHaveLength(1)
    signalProcessGroup(second.pid, 'SIGTERM')
    await second.exited
    expect(await readFile(join(workspace, 'committed.txt'), 'utf8')).toBe('committed work')
    expect(await readFile(join(workspace, 'uncommitted.txt'), 'utf8')).toBe('work in flight')
    const log = await store.getEvents(slug)
    expect(log.filter((e) => e.type === 'session.suspended')).toHaveLength(2)
    expect(log.filter((e) => e.type === 'phase.failed')).toHaveLength(0)
  } finally {
    for (const child of children)
      if (child.exitCode === null) {
        child.kill('SIGKILL')
        await child.exited
      }
    await store.close()
    await rm(tmp, { recursive: true, force: true })
  }
}, 25000)

for (const kind of ['work', 'node'] as const) {
  test(`real ${kind} child executes serialized stage members concurrently`, async () => {
    const { writeFile } = await import('node:fs/promises')
    const { integrationConfig } = await import('../kernel/integration-state')
    const tmp = await mkdtemp(join(tmpdir(), 'ab-child-stages-'))
    const store = new MemoryBuildStore()
    const slug = 'staged-child'
    const ticket = { source: 'file', id: 'STAGES', title: 'Preserve stages' }
    const git = (...args: string[]) => {
      const result = Bun.spawnSync(['git', ...args], { cwd: tmp })
      if (result.exitCode !== 0) throw new Error(new TextDecoder().decode(result.stderr))
      return new TextDecoder().decode(result.stdout).trim()
    }
    try {
      // Neither command can finish until its sibling has actually begun.
      // The bounded barrier also fails a serial pipeline without timing assumptions.
      const pipeline = `forge = "local-git"
[roles.default]
runtime = "pi"
[tickets]
source = "file"
readyState = "ready"
[commands]
a = "touch a.started; i=0; until test -f b.started; do i=$((i+1)); test $i -lt 400 || exit 1; sleep 0.05; done"
b = "touch b.started; i=0; until test -f a.started; do i=$((i+1)); test $i -lt 400 || exit 1; sleep 0.05; done"
[verify]
steps = [["a", "b"]]
[verify.a]
kind = "check"
command = "a"
always = true
[verify.b]
kind = "check"
command = "b"
always = true
`
      const config = parseConfig(pipeline)
      git('init', '-q')
      await writeFile(join(tmp, 'file'), 'base')
      await writeFile(join(tmp, 'autobuild.toml'), pipeline)
      git('add', 'file', 'autobuild.toml')
      git('-c', 'user.name=Test', '-c', 'user.email=test@example.test', 'commit', '-qm', 'base')
      const parent = git('rev-parse', 'HEAD')
      await writeFile(join(tmp, 'file'), 'head')
      git('-c', 'user.name=Test', '-c', 'user.email=test@example.test', 'commit', '-qam', 'head')
      const head = git('rev-parse', 'HEAD')
      await store.createBuild({ slug, repo: tmp, branch: `ab/${slug}`, ticket })
      const seed = async (write: EventWrite) => {
        await store.append(slug, write)
      }
      await seed({
        actor: DISPATCHER,
        type: 'build.created',
        payload: { ticket, repo: tmp, baseBranch: 'main', kind },
      })
      await seed({
        actor: DISPATCHER,
        type: 'workspace.provisioned',
        payload: {
          provider: 'fake',
          ref: tmp,
          path: tmp,
          branch: `ab/${slug}`,
          base: { source: 'remote', sha: parent },
        },
      })
      if (kind === 'node') {
        await seed({ actor: DISPATCHER, type: 'node.opened', payload: { sha: parent } })
        await seed({
          actor: DISPATCHER,
          type: 'node.compared',
          payload: { headSha: head, parentSha: parent, ahead: 1 },
        })
        await seed({
          actor: DISPATCHER,
          type: 'integration.observed',
          payload: { openChildren: [], diagnostics: [], contributions: ['child'] },
        })
        await seed({
          actor: DISPATCHER,
          type: 'integration.prepared',
          payload: { id: 'stage-cycle', head, parent, config: integrationConfig(config) },
        })
      } else {
        await seed({
          actor: DISPATCHER,
          type: 'spec.imported',
          payload: { artifact: { kind: 'spec', rev: 0 }, ticket },
        })
        await store.putArtifact(slug, { kind: 'spec', content: '# Preserve stages' })
        await store.putArtifact(slug, { kind: 'plan', content: '# Run both checks' })
        await seed({
          actor: agentActor('plan', 'seed'),
          type: 'plan.completed',
          payload: { round: 1, artifact: { kind: 'plan', rev: 0 } },
        })
        await seed({
          actor: agentActor('plan-review', 'seed'),
          type: 'plan-review.verdict',
          payload: {
            round: 1,
            verdict: 'approve',
            findings: [],
            artifact: { kind: 'plan-review', rev: 0 },
          },
        })
        await seed({
          actor: agentActor('implement', 'seed'),
          type: 'implement.completed',
          payload: {
            round: 1,
            commits: { base: parent, head },
            artifact: { kind: 'implement-notes', rev: 0 },
          },
        })
        const approval = await store.append(slug, {
          actor: agentActor('code-review', 'seed'),
          type: 'code-review.verdict',
          payload: {
            round: 1,
            verdict: 'approve',
            findings: [],
            artifact: { kind: 'code-review', rev: 0 },
          },
        })
        await seed({
          actor: KERNEL,
          type: 'restack.completed',
          payload: { ...leafTransaction, branch: `ab/${slug}`, cycle: approval.seq, headSha: head },
        })
      }
      await store.putArtifact(slug, {
        kind: BUILD_EFFECTIVE_CONFIG_ARTIFACT,
        content: effectiveBuildConfigContent(config),
      })
      const append = store.append.bind(store)
      let completed = 0
      store.append = async (build, write) => {
        const event = await append(build, write)
        if (write.type === 'verify.completed' && ++completed === 2) {
          await append(build, {
            actor: humanActor('test'),
            type: 'build.pause-requested',
            payload: {},
          })
        }
        return event
      }
      const shutdown = new AbortController()
      const timer = setTimeout(() => shutdown.abort(), 30_000)
      try {
        await runBuildChild(
          { slug, storeRef: 'memory', instance: 'stage-child', workspaceRef: tmp },
          {},
          () => store,
          { shutdownSignal: shutdown.signal },
        )
      } finally {
        clearTimeout(timer)
      }
      const events = await store.getEvents(slug)
      const starts = events.filter((e) => e.type === 'verify.started')
      const finishes = events.filter((e) => e.type === 'verify.completed')
      expect(starts).toHaveLength(2)
      expect(finishes).toHaveLength(2)
      expect(Math.max(...starts.map((e) => e.seq))).toBeLessThan(
        Math.min(...finishes.map((e) => e.seq)),
      )
      for (const event of finishes) {
        expect(event.payload).toMatchObject({ outcome: 'pass' })
        if (kind === 'node')
          expect(event.payload).toMatchObject({
            restackId: 'stage-cycle',
            headSha: head,
            baseSha: parent,
          })
      }
      expect(events.at(-1)?.type).toBe('build.paused')
    } finally {
      await store.close()
      await rm(tmp, { recursive: true, force: true })
    }
  }, 40_000)
}
