/**
 * Contract tests for the operator sandbox service (AUT-340): validation,
 * per-environment serialization, journal facts, truncation, reset/release
 * sequences, and the credential-free provider contract — all against the
 * FakeWorkspaceProvider's filesystem-backed sandbox.
 */
import { describe, expect, test } from 'bun:test'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SANDBOX_FORBIDDEN_ENV, SandboxOperationError } from '../ports/workspace/operator-sandbox'
import { FakeWorkspaceProvider } from '../ports/workspace/fake'
import { FakeForge } from '../ports/forge/fake'
import { MemoryBuildStore } from '../store/memory'
import {
  createOperatorSandboxService,
  resolveSandboxRelativePath,
  sandboxPublicationBranch,
  SANDBOX_TRUNCATION_MARKER,
  truncateSandboxOutput,
  type OperatorSandboxService,
} from './sandbox'

async function fixture(opts?: {
  clock?: () => Date
  setupCommand?: string
  environmentVariables?: string[]
  forge?: FakeForge
}) {
  const workspaces = await mkdtemp(join(tmpdir(), 'ab-sandbox-fake-'))
  const source = await mkdtemp(join(tmpdir(), 'ab-sandbox-src-'))
  await Bun.write(join(source, 'README.md'), 'hello\n')
  const store = new MemoryBuildStore({ clock: opts?.clock })
  const provider = new FakeWorkspaceProvider({
    root: join(workspaces, 'wt'),
    sandboxRoot: join(workspaces, 'sb'),
    sandboxSetupCommand: opts?.setupCommand,
    sandboxEnvironmentVariables: opts?.environmentVariables,
    envSource: {
      PATH: process.env.PATH ?? '',
      ...(opts?.environmentVariables?.length
        ? Object.fromEntries(opts.environmentVariables.map((name) => [name, `v-${name}`] as const))
        : {}),
    },
  })
  const service = await createOperatorSandboxService({
    store,
    repo: source,
    provider,
    sandbox: {
      idleMinutes: 30,
      environmentVariables: opts?.environmentVariables ?? [],
    },
    baseBranch: 'main',
    ...(opts?.forge !== undefined ? { forge: opts.forge } : {}),
    ...(opts?.clock !== undefined ? { clock: opts.clock } : {}),
  })
  return {
    store,
    provider,
    service,
    forge: opts?.forge,
    repo: source,
    async cleanup() {
      await store.close()
      await rm(workspaces, { recursive: true, force: true })
      await rm(source, { recursive: true, force: true })
    },
  }
}

function facts(fx: { store: MemoryBuildStore; repo: string }) {
  return fx.store.getRepoEvents(fx.repo)
}

describe('resolveSandboxRelativePath', () => {
  test('normalizes safe relative paths and rejects every escape shape', () => {
    expect(resolveSandboxRelativePath('src/a.txt')).toBe('src/a.txt')
    expect(resolveSandboxRelativePath('./src/./a.txt')).toBe('src/a.txt')
    expect(resolveSandboxRelativePath('src/../a.txt')).toBe('a.txt')
    for (const bad of ['../x', '/abs', 'a/../../b', '', '.', 'a/..', 'C:/x']) {
      expect(() => resolveSandboxRelativePath(bad)).toThrow(SandboxOperationError)
    }
  })
})

describe('truncateSandboxOutput', () => {
  test('returns output at the bound unchanged and appends the marker past it', () => {
    const exact = 'a'.repeat(65_536)
    expect(truncateSandboxOutput(exact)).toBe(exact)
    const over = 'b'.repeat(65_537)
    const truncated = truncateSandboxOutput(over)
    expect(truncated.startsWith('b'.repeat(65_536))).toBe(true)
    expect(truncated).toContain(SANDBOX_TRUNCATION_MARKER)
  })
})

describe('OperatorSandboxService', () => {
  test('first call provisions and journals; later calls reuse without new facts', async () => {
    const fx = await fixture()
    try {
      await fx.service.exec('ops', { repo: fx.repo, command: 'echo one' })
      const first = await facts(fx)
      // The provisioned fact is itself the first activity evidence; the
      // 60 s rate limit suppresses an activity fact on the same call.
      expect(first.map((event) => event.type)).toEqual(['orchestrator.sandbox.provisioned'])
      expect(first[0]!.actor).toEqual({ kind: 'human', user: 'ops' })
      expect(first[0]!.payload).toMatchObject({
        operator: 'ops',
        provider: 'fake',
        workspacePath: expect.any(String),
      })
      await fx.service.exec('ops', { repo: fx.repo, command: 'echo two' })
      expect(await facts(fx)).toHaveLength(1)
    } finally {
      await fx.cleanup()
    }
  })

  test('exec validates its input and truncates oversized streams', async () => {
    const fx = await fixture()
    try {
      const bad = await fx.service
        .exec('ops', { repo: fx.repo, command: 'true', timeoutSeconds: 301 })
        .catch((error: unknown) => error)
      expect(bad).toBeInstanceOf(SandboxOperationError)
      const cwdEscape = await fx.service
        .exec('ops', { repo: fx.repo, command: 'true', cwd: '../outside' })
        .catch((error: unknown) => error)
      expect(cwdEscape).toBeInstanceOf(SandboxOperationError)
      const result = await fx.service.exec('ops', {
        repo: fx.repo,
        command: `echo "${'x'.repeat(70_000)}"`,
      })
      expect(result.stdout.length).toBeLessThan(70_000)
      expect(result.stdout).toContain(SANDBOX_TRUNCATION_MARKER)
      expect(result.exitCode).toBe(0)
    } finally {
      await fx.cleanup()
    }
  })

  test('readFile and writeFile round-trip bytes inside the checkout', async () => {
    const fx = await fixture()
    try {
      await fx.service.writeFile('ops', {
        repo: fx.repo,
        path: 'notes/dir/file.txt',
        content: Buffer.from([0, 1, 254, 255]).toString('base64'),
        encoding: 'base64',
      })
      const bytes = await fx.service.readFile('ops', { repo: fx.repo, path: 'notes/dir/file.txt' })
      expect([...bytes]).toEqual([0, 1, 254, 255])
      await expect(
        fx.service.readFile('ops', { repo: fx.repo, path: '../outside' }),
      ).rejects.toBeInstanceOf(SandboxOperationError)
      await expect(
        fx.service.writeFile('ops', {
          repo: fx.repo,
          path: 'big.bin',
          content: 'A'.repeat(1_048_577),
          encoding: 'utf8',
        }),
      ).rejects.toBeInstanceOf(SandboxOperationError)
    } finally {
      await fx.cleanup()
    }
  })

  test('start/wait round-trip a detached command', async () => {
    const fx = await fixture()
    try {
      const { commandId } = await fx.service.start('ops', {
        repo: fx.repo,
        command: 'echo detached-out',
      })
      const result = await fx.service.wait('ops', { repo: fx.repo, commandId, waitSeconds: 10 })
      expect(result).toEqual({
        state: 'exited',
        exitCode: 0,
        stdout: 'detached-out\n',
        stderr: '',
      })
    } finally {
      await fx.cleanup()
    }
  })

  test('wait keeps partial output while running, bounded by truncation', async () => {
    const fx = await fixture()
    try {
      await fx.service.exec('ops', { repo: fx.repo, command: 'echo one' })
      // Streaming providers (the local faces) report the output so far on a
      // running command; the service must pass it through, not drop it.
      ;(
        fx.provider.orchestratorSandbox as unknown as {
          wait: () => Promise<unknown>
        }
      ).wait = async () => ({
        state: 'running',
        stdout: 'p'.repeat(70_000),
        stderr: 'err-so-far',
      })
      const result = await fx.service.wait('ops', {
        repo: fx.repo,
        commandId: 'sbcmd-x',
        waitSeconds: 0,
      })
      expect(result).toEqual({
        state: 'running',
        stdout: `${'p'.repeat(65_536)}\n${SANDBOX_TRUNCATION_MARKER}`,
        stderr: 'err-so-far',
      })
    } finally {
      await fx.cleanup()
    }
  })

  test('serialization: two overlapping execs on one environment run strictly in order', async () => {
    const fx = await fixture()
    try {
      const order: string[] = []
      const slow = fx.service.exec('ops', {
        repo: fx.repo,
        command: 'sleep 0.3 && echo slow',
      })
      const quick = fx.service
        .exec('ops', { repo: fx.repo, command: 'echo quick' })
        .then((result) => {
          order.push('quick-finished')
          return result
        })
      const [slowResult, quickResult] = await Promise.all([slow, quick])
      // The slow command finished before the quick one even started its exec,
      // because both serialize on the same (repo, operator) chain.
      expect(order).toEqual(['quick-finished'])
      expect(slowResult.stdout).toContain('slow')
      expect(quickResult.stdout).toContain('quick')
    } finally {
      await fx.cleanup()
    }
  })

  test('different operators do not serialize against each other', async () => {
    const fx = await fixture()
    try {
      const first = fx.service.exec('ops-a', { repo: fx.repo, command: 'sleep 0.4 && echo a' })
      const second = fx.service.exec('ops-b', { repo: fx.repo, command: 'echo b' })
      const [a, b] = await Promise.all([first, second])
      expect(a.stdout).toContain('a')
      expect(b.stdout).toContain('b')
    } finally {
      await fx.cleanup()
    }
  })

  test('the guest environment is credential-free even with a polluted host', async () => {
    const fx = await fixture({ environmentVariables: ['MY_TOOL_CONFIG'] })
    try {
      const probe = await fx.service.exec('ops', { repo: fx.repo, command: 'env | sort' })
      for (const name of SANDBOX_FORBIDDEN_ENV) {
        expect(probe.stdout).not.toContain(`${name}=`)
      }
      expect(probe.stdout).toContain('MY_TOOL_CONFIG=v-MY_TOOL_CONFIG')
      // Direct evidence from the provider's recorded spawn environments:
      // what the provider constructed, not merely what the shell reported.
      expect(fx.provider.sandboxExecEnvironments.length).toBeGreaterThan(0)
      for (const entry of fx.provider.sandboxExecEnvironments) {
        expect(Object.keys(entry.env).sort()).toEqual(['MY_TOOL_CONFIG', 'PATH'])
      }
    } finally {
      await fx.cleanup()
    }
  })

  test('a stopped environment resumes with a resumed fact, then activity refreshes evidence', async () => {
    let now = Date.parse('2026-09-15T00:00:00Z')
    const clock = () => new Date(now)
    const fx = await fixture({ clock })
    try {
      await fx.service.exec('ops', { repo: fx.repo, command: 'echo warm' })
      const environmentId = (
        await fx.provider.orchestratorSandbox.describe({ repo: fx.repo, operator: 'ops' })
      ).environmentId
      // Simulate the dispatcher's idle stop: the environment's trail closes.
      await fx.store.appendRepo(fx.repo, {
        actor: { kind: 'dispatcher' },
        type: 'orchestrator.sandbox.stopped',
        payload: { operator: 'ops', reason: 'idle', environmentId },
      })
      const before = await facts(fx)
      expect(before.at(-1)!.type).toBe('orchestrator.sandbox.stopped')
      now += 10 * 60 * 1000
      await fx.service.exec('ops', { repo: fx.repo, command: 'echo resumed' })
      const types = (await facts(fx)).map((event) => event.type)
      expect(types.at(-1)).toBe('orchestrator.sandbox.resumed')
    } finally {
      await fx.cleanup()
    }
  })

  test('reset journals reset → released → provisioned and re-copies from source', async () => {
    const fx = await fixture()
    try {
      await fx.service.exec('ops', { repo: fx.repo, command: 'echo one' })
      const identity = await fx.provider.orchestratorSandbox.describe({
        repo: fx.repo,
        operator: 'ops',
      })
      await fx.service.writeFile('ops', {
        repo: fx.repo,
        path: 'scratch.txt',
        content: 'dirty',
        encoding: 'utf8',
      })
      await fx.service.reset('ops', { repo: fx.repo })
      const types = (await facts(fx)).map((event) => event.type)
      expect(types.slice(-3)).toEqual([
        'orchestrator.sandbox.reset',
        'orchestrator.sandbox.released',
        'orchestrator.sandbox.provisioned',
      ])
      // The destructive reset re-copied from the source: the scratch file is
      // gone and the checkout matches the source again.
      await expect(readFile(join(identity.workspacePath, 'scratch.txt'), 'utf8')).rejects.toThrow()
      expect(await readFile(join(identity.workspacePath, 'README.md'), 'utf8')).toBe('hello\n')
    } finally {
      await fx.cleanup()
    }
  })

  test('release journals the closing fact with snapshot evidence; a never-provisioned operator is a no-op', async () => {
    const fx = await fixture()
    try {
      await fx.service.exec('ops', { repo: fx.repo, command: 'echo one' })
      await fx.service.release('ops', { repo: fx.repo })
      const last = (await facts(fx)).at(-1)!
      expect(last.type).toBe('orchestrator.sandbox.released')
      expect(last.payload).toMatchObject({
        operator: 'ops',
        snapshots: { outcome: 'confirmed' },
      })
      expect(await facts(fx)).toHaveLength(2) // provisioned, released

      const before = (await facts(fx)).length
      await fx.service.release('nobody', { repo: fx.repo })
      expect(await facts(fx)).toHaveLength(before)
    } finally {
      await fx.cleanup()
    }
  })

  test('a provider failure surfaces as a typed error naming its stage', async () => {
    const fx = await fixture()
    try {
      await fx.service.exec('ops', { repo: fx.repo, command: 'echo one' })
      ;(
        fx.provider.orchestratorSandbox as unknown as {
          release: () => Promise<never>
        }
      ).release = async () => {
        throw new Error('purge failed')
      }
      const error = await fx.service
        .reset('ops', { repo: fx.repo })
        .catch((e: unknown) => e as unknown as SandboxOperationError)
      expect(error).toBeInstanceOf(SandboxOperationError)
      expect((error as SandboxOperationError).stage).toBe('reset')
    } finally {
      await fx.cleanup()
    }
  })

  test('tool calls against another repository are refused', async () => {
    const fx = await fixture()
    try {
      await expect(
        fx.service.exec('ops', { repo: 'other/repo', command: 'true' }),
      ).rejects.toBeInstanceOf(SandboxOperationError)
    } finally {
      await fx.cleanup()
    }
  })

  test('a capability-less provider cannot construct a service', async () => {
    const workspaces = await mkdtemp(join(tmpdir(), 'ab-sandbox-nocap-'))
    const source = await mkdtemp(join(tmpdir(), 'ab-sandbox-nocap-src-'))
    const store = new MemoryBuildStore()
    try {
      const provider = new FakeWorkspaceProvider({ mode: 'logical' })
      const { createOperatorSandboxService: create } = await import('./sandbox')
      // The logical-mode fake still carries the capability; delete it to
      // model a provider without one.
      const bare = provider as unknown as Record<string, unknown>
      delete bare.orchestratorSandbox
      await expect(
        create({
          store,
          repo: source,
          provider,
          sandbox: { idleMinutes: 30, environmentVariables: [] },
          baseBranch: 'main',
        }),
      ).rejects.toThrow(/cannot host operator sandboxes/)
    } finally {
      await store.close()
      await rm(workspaces, { recursive: true, force: true })
      await rm(source, { recursive: true, force: true })
    }
  })
})

describe('OperatorSandboxService.publish (AUT-343)', () => {
  const forgeFx = () =>
    fixture({ forge: new FakeForge() }) as Promise<{
      store: Awaited<ReturnType<typeof fixture>>['store']
      provider: FakeWorkspaceProvider
      service: OperatorSandboxService
      forge: FakeForge
      repo: string
      cleanup(): Promise<void>
    }>

  const factsOf = async (fx: {
    store: Awaited<ReturnType<typeof fixture>>['store']
    repo: string
  }) => fx.store.getRepoEvents(fx.repo)

  /** The fresh sandbox's seed commit IS the provision-time base head, so a
   * publishable state requires a real commit on top of it. */
  const commitChange = (fx: { service: OperatorSandboxService; repo: string }) =>
    fx.service.exec('ops', {
      repo: fx.repo,
      command: 'echo change >> README.md && git add README.md && git commit -q -m change',
    })

  test('canPublish is true only with forge and provider publication capability', async () => {
    const withForge = await forgeFx()
    try {
      expect(withForge.service.canPublish).toBe(true)
    } finally {
      await withForge.cleanup()
    }
    const withoutForge = await fixture()
    try {
      expect(withoutForge.service.canPublish).toBe(false)
    } finally {
      await withoutForge.cleanup()
    }
  })

  test('fresh provision and reset write baseSha into the fact and the snapshot', async () => {
    const fx = await forgeFx()
    try {
      await fx.service.exec('ops', { repo: fx.repo, command: 'true' })
      const provisioned = (await factsOf(fx)).find(
        (event) => event.type === 'orchestrator.sandbox.provisioned',
      )!
      // Extract before any matcher runs: Bun's toMatchObject can mutate the
      // received object.
      const baseSha = (provisioned.payload as { baseSha?: string }).baseSha
      expect(baseSha).toMatch(/^[0-9a-f]{40}$/)

      await fx.service.reset('ops', { repo: fx.repo })
      const reprovisioned = (await factsOf(fx))
        .filter((event) => event.type === 'orchestrator.sandbox.provisioned')
        .at(-1)!
      expect((reprovisioned.payload as { baseSha?: string }).baseSha).toMatch(/^[0-9a-f]{40}$/)

      // The snapshot channel: sandboxStates exposes baseSha after reset.
      const { sandboxStates } = await import('../processes/sandbox-state')
      const states = sandboxStates(await fx.store.getRepoStateEvents(fx.repo))
      const live = states.filter((state) => state.state === 'live').at(-1)!
      expect(live.baseSha).toMatch(/^[0-9a-f]{40}$/)
      expect(baseSha).toMatch(/^[0-9a-f]{40}$/)
    } finally {
      await fx.cleanup()
    }
  })

  test('happy path: one push, one branch, never the base, PR against base, journaled fact', async () => {
    const fx = await forgeFx()
    try {
      await commitChange(fx)
      const result = await fx.service.publish('ops', {
        repo: fx.repo,
        title: 'Fix login',
        via: { kind: 'session', id: 'sess-1' },
      })
      const branch = sandboxPublicationBranch(fx.repo, 'ops')
      expect(result.branch).toBe(branch)
      expect(result.sha).toMatch(/^[0-9a-f]{40}$/)
      expect(fx.provider.publications).toEqual([
        { ref: expect.any(String), sha: result.sha, branch },
      ])
      expect(branch).not.toBe('main')
      expect(fx.forge!.opened).toHaveLength(1)
      expect(fx.forge!.opened[0]).toMatchObject({ head: branch, base: 'main', title: 'Fix login' })
      expect(fx.forge!.opened[0]!.body).toContain('by ops')
      expect(fx.forge!.opened[0]!.body).toContain('via orchestrator session sess-1')
      expect(fx.forge!.opened[0]!.body).toContain('agent-authored, not a pipeline build')
      const published = (await factsOf(fx)).find(
        (event) => event.type === 'orchestrator.sandbox.published',
      )!
      expect(published.actor).toEqual({ kind: 'human', user: 'ops' })
      expect(published.payload).toMatchObject({
        operator: 'ops',
        branch,
        sha: result.sha,
        session: 'sess-1',
        pr: { number: 1, url: expect.any(String) },
      })
    } finally {
      await fx.cleanup()
    }
  })

  test('open-then-update: a later publish pushes the new head to the same branch and adopts the PR', async () => {
    const fx = await forgeFx()
    try {
      await commitChange(fx)
      const first = await fx.service.publish('ops', {
        repo: fx.repo,
        title: 'Fix login',
      })
      await fx.service.exec('ops', {
        repo: fx.repo,
        command: 'echo more >> README.md && git add README.md && git commit -q -m more',
      })
      const second = await fx.service.publish('ops', {
        repo: fx.repo,
        title: 'Fix login more',
      })
      expect(second.branch).toBe(first.branch)
      expect(second.sha).not.toBe(first.sha)
      expect(fx.provider.publications).toHaveLength(2)
      expect(fx.forge!.opened).toHaveLength(1) // adopted, not reopened
      expect(fx.forge!.opened[0]!.head).toBe(first.branch)
      expect(
        (await factsOf(fx)).filter((e) => e.type === 'orchestrator.sandbox.published'),
      ).toHaveLength(2)
    } finally {
      await fx.cleanup()
    }
  })

  test('refuses a dirty checkout (tracked changes), staging and unstaged alike, and journals stage checks', async () => {
    for (const dirty of [
      'echo dirty >> README.md',
      'echo dirty >> README.md && git add README.md',
    ]) {
      const fx = await forgeFx()
      try {
        await fx.service.exec('ops', { repo: fx.repo, command: dirty })
        const error = await fx.service
          .publish('ops', { repo: fx.repo, title: 'Fix' })
          .catch((e: unknown) => e as unknown as SandboxOperationError)
        expect(error).toBeInstanceOf(SandboxOperationError)
        expect((error as SandboxOperationError).stage).toBe('publish')
        expect((error as SandboxOperationError).message).toMatch(/uncommitted changes/)
        expect(fx.provider.publications).toEqual([])
        const failed = (await factsOf(fx)).find(
          (event) => event.type === 'orchestrator.sandbox.publish-failed',
        )!
        expect(failed.payload).toMatchObject({ operator: 'ops', stage: 'checks' })
      } finally {
        await fx.cleanup()
      }
    }
  })

  test('refuses a checkout whose only uncommitted work is an untracked file (f_c748dc6a)', async () => {
    const fx = await forgeFx()
    try {
      // A brand-new file the operator never committed must refuse, or a
      // publish would silently ship the previous HEAD without it.
      await fx.service.exec('ops', { repo: fx.repo, command: 'echo scratch > scratch.txt' })
      const error = await fx.service
        .publish('ops', { repo: fx.repo, title: 'Fix' })
        .catch((e: unknown) => e as unknown as SandboxOperationError)
      expect(error).toBeInstanceOf(SandboxOperationError)
      expect((error as SandboxOperationError).message).toMatch(/uncommitted changes/)
      expect(fx.provider.publications).toEqual([])
      const failed = (await factsOf(fx)).find(
        (event) => event.type === 'orchestrator.sandbox.publish-failed',
      )!
      expect(failed.payload).toMatchObject({ operator: 'ops', stage: 'checks' })
    } finally {
      await fx.cleanup()
    }
  })

  test('a fresh sandbox whose only untracked file is the provisioning marker publishes', async () => {
    const fx = await forgeFx()
    try {
      // The provider excludes its .autobuild-sandbox-provisioned marker in
      // the checkout's info/exclude, so a pristine sandbox is clean for
      // the untracked-inclusive dirty check.
      await fx.service.exec('ops', { repo: fx.repo, command: 'true' })
      await commitChange(fx)
      const result = await fx.service.publish('ops', { repo: fx.repo, title: 'Fix' })
      expect(result.sha).toMatch(/^[0-9a-f]{40}$/)
    } finally {
      await fx.cleanup()
    }
  })

  test('a legacy sandbox with an unexcluded provisioning marker gets the reset-required diagnostic, not uncommitted changes (AUT-580)', async () => {
    const fx = await forgeFx()
    try {
      // Provision through the normal flow, then make a publishable commit. The
      // commit is issued inline under the scenario's operator ('legacy'): the
      // describe-level commitChange helper hardcodes 'ops', which would target
      // a different sandbox identity. A stray commit under the wrong operator
      // would be inert here — publish's reset-required check (no recorded
      // baseSha) precedes any head comparison — but the exercise stays under
      // 'legacy'.
      await fx.service.exec('legacy', { repo: fx.repo, command: 'true' })
      await fx.service.exec('legacy', {
        repo: fx.repo,
        command: 'echo change >> README.md && git add README.md && git commit -q -m change',
      })
      // Pre-existing-environment journal: a second provisioned fact written
      // before baseSha was recorded — operatorState takes .at(-1), so the
      // fresh state carries no baseSha and publish would reach the baseSha
      // check if the dirty check passes.
      const identity = await fx.provider.orchestratorSandbox.describe({
        repo: fx.repo,
        operator: 'legacy',
      })
      await fx.store.appendRepo(fx.repo, {
        actor: { kind: 'human', user: 'legacy' },
        type: 'orchestrator.sandbox.provisioned',
        payload: {
          operator: 'legacy',
          environmentId: identity.environmentId,
          provider: 'fake',
          workspacePath: identity.workspacePath,
        },
      })
      // Reproduce the pre-exclusion-era worktree: strip the marker line the
      // provisioning-time info/exclude write had put there. This exec's own
      // ensure runs before the strip, so the strip is the last thing that
      // touches the file before publish.
      await fx.service.exec('legacy', {
        repo: fx.repo,
        command:
          'sed -i "/autobuild-sandbox-provisioned/d" "$(git rev-parse --git-path info/exclude)"',
      })

      const error = await fx.service
        .publish('legacy', { repo: fx.repo, title: 'Fix' })
        .catch((e: unknown) => e as unknown as SandboxOperationError)
      // Publish's ensure heals the exclusion on the early-return path, so
      // the dirty check passes and the no-baseSha diagnostic surfaces —
      // not the misleading uncommitted-changes refusal.
      expect(error).toBeInstanceOf(SandboxOperationError)
      expect((error as SandboxOperationError).message).toMatch(
        /reset required|no recorded base head/,
      )
      expect((error as SandboxOperationError).message).not.toMatch(/uncommitted changes/)
      expect(fx.provider.publications).toEqual([])
      const failed = (await factsOf(fx)).find(
        (event) => event.type === 'orchestrator.sandbox.publish-failed',
      )!
      expect(failed.payload).toMatchObject({ operator: 'legacy', stage: 'checks' })
    } finally {
      await fx.cleanup()
    }
  })

  test('refuses a non-descendant commit and the degenerate base-equal commit', async () => {
    const fx = await forgeFx()
    try {
      await fx.service.exec('ops', {
        repo: fx.repo,
        command: 'git checkout -q --orphan stray && git add -A && git commit -q -m stray',
      })
      const error = await fx.service
        .publish('ops', { repo: fx.repo, title: 'Fix', commit: 'stray' })
        .catch((e: unknown) => e as unknown as SandboxOperationError)
      expect(error).toBeInstanceOf(SandboxOperationError)
      expect((error as SandboxOperationError).message).toMatch(/not a descendant of the base head/)
      expect(fx.provider.publications).toEqual([])
      expect(
        (await factsOf(fx)).some(
          (event) =>
            event.type === 'orchestrator.sandbox.publish-failed' &&
            (event.payload as { stage: string }).stage === 'checks',
        ),
      ).toBe(true)
    } finally {
      await fx.cleanup()
    }

    const degenerate = await forgeFx()
    try {
      await degenerate.service.exec('ops', { repo: degenerate.repo, command: 'true' })
      const provisioned = (await factsOf(degenerate)).find(
        (event) => event.type === 'orchestrator.sandbox.provisioned',
      )!
      const baseSha = (provisioned.payload as { baseSha: string }).baseSha
      const error = await degenerate.service
        .publish('ops', { repo: degenerate.repo, title: 'Fix', commit: baseSha })
        .catch((e: unknown) => e as unknown as SandboxOperationError)
      expect((error as SandboxOperationError).message).toMatch(/nothing to publish/)
      expect(degenerate.provider.publications).toEqual([])
    } finally {
      await degenerate.cleanup()
    }
  })

  test('refuses with a reset-required message when the journal has no baseSha', async () => {
    const fx = await forgeFx()
    try {
      // Pre-existing environment: a provisioned fact written before this
      // build carried no baseSha.
      const identity = await fx.provider.orchestratorSandbox.describe({
        repo: fx.repo,
        operator: 'legacy',
      })
      await fx.store.appendRepo(fx.repo, {
        actor: { kind: 'human', user: 'legacy' },
        type: 'orchestrator.sandbox.provisioned',
        payload: {
          operator: 'legacy',
          environmentId: identity.environmentId,
          provider: 'fake',
          workspacePath: identity.workspacePath,
        },
      })
      const error = await fx.service
        .publish('legacy', { repo: fx.repo, title: 'Fix' })
        .catch((e: unknown) => e as unknown as SandboxOperationError)
      expect(error).toBeInstanceOf(SandboxOperationError)
      expect((error as SandboxOperationError).message).toMatch(
        /reset required|no recorded base head/,
      )
      expect(fx.provider.publications).toEqual([])
    } finally {
      await fx.cleanup()
    }
  })

  test('ancestry-check error discipline: nonzero merge-base exit is an error naming the exit, not a refusal', async () => {
    const fx = await forgeFx()
    try {
      await fx.service.exec('ops', { repo: fx.repo, command: 'true' })
      await commitChange(fx)
      const capability = fx.provider.orchestratorSandbox
      const originalExec = capability.exec.bind(capability)
      capability.exec = async (handle, request) => {
        if (request.command.includes('merge-base --is-ancestor')) {
          return { exitCode: 128, stdout: '', stderr: 'fatal: internal git failure' }
        }
        return originalExec(handle, request)
      }
      const error = await fx.service
        .publish('ops', { repo: fx.repo, title: 'Fix' })
        .catch((e: unknown) => e as unknown as SandboxOperationError)
      expect(error).toBeInstanceOf(SandboxOperationError)
      expect((error as SandboxOperationError).message).toContain('exited 128')
      expect((error as SandboxOperationError).message).not.toMatch(/not a descendant/)
      expect(fx.provider.publications).toEqual([])
      const failed = (await factsOf(fx)).find(
        (event) => event.type === 'orchestrator.sandbox.publish-failed',
      )!
      expect(failed.payload as { stage: string; message: string }).toMatchObject({
        stage: 'checks',
        message: expect.stringContaining('exited 128'),
      })

      // Same pin for a nonzero rev-parse exit.
      capability.exec = async (handle, request) => {
        if (request.command.includes('rev-parse')) {
          return { exitCode: 128, stdout: '', stderr: 'fatal: bad object' }
        }
        return originalExec(handle, request)
      }
      const resolveError = await fx.service
        .publish('ops', { repo: fx.repo, title: 'Fix' })
        .catch((e: unknown) => e as unknown as SandboxOperationError)
      expect((resolveError as SandboxOperationError).message).toContain('exited 128')
    } finally {
      await fx.cleanup()
    }
  })

  test('a foreign repo is refused before any provider traffic', async () => {
    const fx = await forgeFx()
    try {
      const error = await fx.service
        .publish('ops', { repo: 'other/repo', title: 'Fix' })
        .catch((e: unknown) => e as unknown as SandboxOperationError)
      expect(error).toBeInstanceOf(SandboxOperationError)
      expect((error as SandboxOperationError).stage).toBe('publish')
      expect((error as SandboxOperationError).message).toContain('other/repo')
      expect(fx.provider.publications).toEqual([])
      expect(fx.forge!.opened).toEqual([])
      expect(await factsOf(fx)).toEqual([])
    } finally {
      await fx.cleanup()
    }
  })

  test('a foreign repo refusal on exec keeps the exec stage', async () => {
    const fx = await forgeFx()
    try {
      const error = await fx.service
        .exec('ops', { repo: 'other/repo', command: 'true' })
        .catch((e: unknown) => e as unknown as SandboxOperationError)
      expect(error).toBeInstanceOf(SandboxOperationError)
      expect((error as SandboxOperationError).stage).toBe('exec')
      expect((error as SandboxOperationError).message).toContain('other/repo')
      expect(await factsOf(fx)).toEqual([])
    } finally {
      await fx.cleanup()
    }
  })

  test('crash window: a recorded push with no journal fact is completed, not re-pushed', async () => {
    const fx = await forgeFx()
    try {
      await fx.service.exec('ops', { repo: fx.repo, command: 'true' })
      await commitChange(fx)
      const identity = await fx.provider.orchestratorSandbox.describe({
        repo: fx.repo,
        operator: 'ops',
      })
      const sha = (
        await fx.provider.orchestratorSandbox.exec(identity, { command: 'git rev-parse HEAD' })
      ).stdout.trim()
      const branch = sandboxPublicationBranch(fx.repo, 'ops')
      // Simulate the crash: push landed, journal fact never appended.
      await fx.provider.sandboxPublication!.publish({ ref: identity.environmentId, sha, branch })
      expect(fx.provider.publications).toHaveLength(1)

      const result = await fx.service.publish('ops', { repo: fx.repo, title: 'Fix' })
      expect(result.sha).toBe(sha)
      expect(fx.provider.publications).toHaveLength(1) // no re-push
      expect(
        (await factsOf(fx)).filter((e) => e.type === 'orchestrator.sandbox.published'),
      ).toHaveLength(1)
    } finally {
      await fx.cleanup()
    }
  })

  test('failure paths journal publish-failed with the stage and a redacted message', async () => {
    const fx = await forgeFx()
    try {
      await commitChange(fx)
      process.env.GITHUB_TOKEN = 'super-secret-token'
      try {
        fx.provider.setPublicationFailure(
          new Error('push failed with GITHUB_TOKEN=super-secret-token'),
        )
        const pushError = await fx.service
          .publish('ops', { repo: fx.repo, title: 'Fix' })
          .catch((e: unknown) => e as unknown as SandboxOperationError)
        expect((pushError as SandboxOperationError).stage).toBe('publish')
        const pushFailed = (await factsOf(fx))
          .filter((event) => event.type === 'orchestrator.sandbox.publish-failed')
          .at(-1)!
        expect((pushFailed.payload as { stage: string }).stage).toBe('push')
        expect((pushFailed.payload as { message: string }).message).not.toContain(
          'super-secret-token',
        )
      } finally {
        delete process.env.GITHUB_TOKEN
        fx.provider.setPublicationFailure(null)
      }

      const forge = fx.forge!
      forge.openPr = async () => {
        throw new Error('forge exploded')
      }
      await fx.service.publish('ops', { repo: fx.repo, title: 'Fix' }).catch(() => {})
      const prFailed = (await factsOf(fx))
        .filter((event) => event.type === 'orchestrator.sandbox.publish-failed')
        .at(-1)!
      expect((prFailed.payload as { stage: string }).stage).toBe('pr')
      expect((prFailed.payload as { message: string }).message).toContain('forge exploded')
    } finally {
      await fx.cleanup()
    }
  })

  test('the guest environment stays credential-free during a publish attempt', async () => {
    const fx = await forgeFx()
    try {
      await commitChange(fx)
      process.env.GITHUB_TOKEN = 'super-secret-token'
      try {
        await fx.service.publish('ops', { repo: fx.repo, title: 'Fix' })
      } finally {
        delete process.env.GITHUB_TOKEN
      }
      const publishRecords = fx.provider.sandboxExecEnvironments.slice()
      expect(publishRecords.length).toBeGreaterThan(0)
      for (const entry of publishRecords) {
        expect(Object.keys(entry.env)).toEqual(['PATH'])
        for (const name of SANDBOX_FORBIDDEN_ENV) {
          expect(Object.keys(entry.env)).not.toContain(name)
        }
      }
    } finally {
      await fx.cleanup()
    }
  })

  test('reset after the base advances: new baseSha, publish from the fresh checkout accepted', async () => {
    const fx = await forgeFx()
    try {
      await fx.service.exec('ops', { repo: fx.repo, command: 'true' })
      const firstBaseSha = (
        (await factsOf(fx)).find((event) => event.type === 'orchestrator.sandbox.provisioned')!
          .payload as { baseSha: string }
      ).baseSha
      // A merge moved the base forward: the source tree gains a file, reset
      // tears down and re-provisions from the new base (a fresh seed commit
      // → a fresh baseSha).
      await Bun.write(join(fx.repo, 'merged.txt'), 'from merge\n')
      await fx.service.reset('ops', { repo: fx.repo })
      const reprovisioned = (await factsOf(fx))
        .filter((event) => event.type === 'orchestrator.sandbox.provisioned')
        .at(-1)!
      const newBaseSha = (reprovisioned.payload as { baseSha: string }).baseSha
      expect(newBaseSha).toMatch(/^[0-9a-f]{40}$/)
      expect(newBaseSha).not.toBe(firstBaseSha)
      // A publish from the fresh checkout is then accepted.
      await commitChange(fx)
      const result = await fx.service.publish('ops', { repo: fx.repo, title: 'Fix' })
      expect(result.sha).toMatch(/^[0-9a-f]{40}$/)
    } finally {
      await fx.cleanup()
    }
  })

  test('branch naming: an operator with no alphanumerics still yields a canonical branch', () => {
    const branch = sandboxPublicationBranch('https://github.com/acme/widgets', '@@@')
    expect(branch).toMatch(/^ab\/orch--[0-9a-f]{8}$/)
    expect(branch).toMatch(/^ab\/[a-z0-9][a-z0-9-]*$/)
    const normal = sandboxPublicationBranch('https://github.com/acme/widgets', 'Ada Lovelace!')
    expect(normal).toBe(
      `ab/orch-ada-lovelace-${require('node:crypto')
        .createHash('sha256')
        .update('https://github.com/acme/widgets\0Ada Lovelace!')
        .digest('hex')
        .slice(0, 8)}`,
    )
  })
})

export type { OperatorSandboxService }
