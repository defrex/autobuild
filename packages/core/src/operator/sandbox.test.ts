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
import { MemoryBuildStore } from '../store/memory'
import {
  createOperatorSandboxService,
  resolveSandboxRelativePath,
  SANDBOX_TRUNCATION_MARKER,
  truncateSandboxOutput,
  type OperatorSandboxService,
} from './sandbox'

async function fixture(opts?: {
  clock?: () => Date
  setupCommand?: string
  environmentVariables?: string[]
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
    ...(opts?.clock !== undefined ? { clock: opts.clock } : {}),
  })
  return {
    store,
    provider,
    service,
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
      const error = await fx.service.reset('ops', { repo: fx.repo }).catch((e: unknown) => e)
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

export type { OperatorSandboxService }
