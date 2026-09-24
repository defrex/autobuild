import { expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { NetworkPolicy } from '@vercel/sandbox'
import { abDispatch, type DispatchWiring } from '../cli/dispatch'
import { agentActor, DISPATCHER, KERNEL } from '../events/envelope'
import { randomUuids, sequentialIds } from '../ids'
import { FakeForge } from '../ports/forge/fake'
import { ScriptedAgentRunner, defaultTurnResult } from '../ports/runner/fake'
import { FakeTicketSource } from '../ports/tickets/fake'
import { spawnExec, type Exec } from '../ports/workspace/git-worktree'
import {
  VERCEL_AUTOBUILD_PATH,
  VERCEL_BUN_BIN_PATH,
  VERCEL_BUN_EXECUTABLE,
  VERCEL_BUN_PREFIX,
  VERCEL_BUN_VERSION,
  VERCEL_DISTRIBUTION_VERSION_MARKER,
  VercelSandboxProvider,
  type VercelCommand,
  type VercelCommandLookup,
  type VercelSandboxFacade,
  type VercelSandboxHandle,
} from '../ports/workspace/vercel-sandbox'
import { MemoryBuildStore } from '../store/memory'
import { systemClock } from '../store/types'

const SHA = 'a'.repeat(40)
const BASE = 'b'.repeat(40)

/** Composes dispatch, the Vercel provider, remote park facts, exact-SHA
 * settlement, and PR creation without any host worktree or local child. The
 * fake guest writes only Store facts; SDK output is deliberately empty. */
test('fake Vercel SDK lifecycle reaches PR creation across publication parks', async () => {
  const tmp = await mkdtemp(join(tmpdir(), 'ab-vercel-composed-'))
  const repo = join(tmp, 'repo')
  const store = new MemoryBuildStore()
  const ids = sequentialIds()
  const forge = new FakeForge({ headSha: SHA })
  const remote = { head: null as string | null }
  let stage = 0
  const commands: Array<Record<string, unknown>> = []

  class SandboxDouble implements VercelSandboxHandle {
    readonly name = 'autobuild-composed'
    provisioned = false
    deleted = false
    /** Simulated `/opt/autobuild/.distribution-version` marker content. */
    distributionVersion: string | undefined
    /** Exit code of the most recent detached command, for `getCommand`
     * re-observation. The plain lookup reports `null` until some wait has
     * observed an exit — exactly the provider's behavior — and a wait while
     * the guest is still running blocks until its signal aborts. */
    lastExitCode: number | null = null
    getCommand(): Promise<VercelCommandLookup> {
      return Promise.resolve({
        exitCode: this.lastExitCode,
        wait: (waitParams?: { signal?: AbortSignal }) =>
          this.lastExitCode === null
            ? new Promise<never>((_, reject) => {
                waitParams?.signal?.addEventListener(
                  'abort',
                  () => reject(waitParams.signal!.reason ?? new Error('aborted')),
                  { once: true },
                )
              })
            : Promise.resolve({ exitCode: this.lastExitCode }),
      })
    }

    async runCommand(params: Record<string, unknown>) {
      commands.push(params)
      if (params.cmd === 'test') return { exitCode: this.provisioned ? 0 : 1 }
      if (params.cmd === 'touch') this.provisioned = true
      if (
        params.cmd === 'cat' &&
        (params.args as string[])?.[0] === VERCEL_DISTRIBUTION_VERSION_MARKER
      ) {
        if (this.distributionVersion === undefined) return { exitCode: 1 }
        return { exitCode: 0, stdout: async () => this.distributionVersion }
      }
      if (
        params.cmd === 'sh' &&
        (params.args as string[])?.[1] === 'printf %s "$1" > "$2"' &&
        (params.args as string[])?.[4] === VERCEL_DISTRIBUTION_VERSION_MARKER
      ) {
        this.distributionVersion = (params.args as string[])![3] as string
        return { exitCode: 0 }
      }
      if (params.cmd === 'git' && (params.args as string[] | undefined)?.includes('push')) {
        remote.head = (params.args as string[]).at(-1)!.split(':')[0]!
      }
      if (params.detached === true) {
        const launch = JSON.parse(
          (params.env as Record<string, string>).AB_BUILD_RUNNER_OPTIONS!,
        ) as { slug: string }
        const command: VercelCommand = {
          exitCode: null,
          cmdId: 'cmd-e2e',
          kill: async () => undefined,
          wait: async () => {
            stage += 1
            if (stage === 1) {
              const plan = await store.putArtifact(launch.slug, { kind: 'plan', content: '# Plan' })
              await store.append(launch.slug, {
                actor: agentActor('plan', 's-plan'),
                type: 'plan.completed',
                payload: {
                  round: 1,
                  artifact: { kind: plan.kind, rev: plan.revision },
                  verifySteps: [],
                },
              })
              const review = await store.putArtifact(launch.slug, {
                kind: 'plan-review',
                content: 'approved',
              })
              await store.append(launch.slug, {
                actor: agentActor('plan-review', 's-plan-review'),
                type: 'plan-review.verdict',
                payload: {
                  round: 1,
                  verdict: 'approve',
                  findings: [],
                  artifact: { kind: review.kind, rev: review.revision },
                },
              })
              const notes = await store.putArtifact(launch.slug, {
                kind: 'implement-notes',
                content: 'implemented',
              })
              await store.append(launch.slug, {
                actor: agentActor('implement', 's-implement'),
                type: 'publication.requested',
                payload: {
                  operation: 'implement',
                  branch: `ab/${launch.slug}`,
                  sha: SHA,
                  round: 1,
                  base: BASE,
                  artifact: { kind: notes.kind, rev: notes.revision },
                },
              })
            } else if (stage === 2) {
              const review = await store.putArtifact(launch.slug, {
                kind: 'code-review',
                content: 'approved',
              })
              await store.append(launch.slug, {
                actor: agentActor('code-review', 's-code-review'),
                type: 'code-review.verdict',
                payload: {
                  round: 1,
                  verdict: 'approve',
                  findings: [],
                  artifact: { kind: review.kind, rev: review.revision },
                },
              })
              await store.append(launch.slug, {
                actor: KERNEL,
                type: 'verify.completed',
                payload: { step: 'types', attempt: 1, outcome: 'pass' },
              })
              const report = await store.putArtifact(launch.slug, {
                kind: 'verify-report:e2e',
                content: 'agent verification passed',
              })
              await store.append(launch.slug, {
                actor: agentActor('verify:e2e', 's-verify'),
                type: 'verify.completed',
                payload: {
                  step: 'e2e',
                  attempt: 1,
                  outcome: 'pass',
                  report: { kind: report.kind, rev: report.revision },
                },
              })
              await store.append(launch.slug, {
                actor: KERNEL,
                type: 'publication.requested',
                payload: {
                  operation: 'finalize-step',
                  step: 'release-notes',
                  branch: `ab/${launch.slug}`,
                  sha: SHA,
                },
              })
            } else if (stage === 3) {
              const description = await store.putArtifact(launch.slug, {
                kind: 'pr-description',
                content: '# Composed remote build\n\nCreated through fake Vercel.\n',
              })
              await store.append(launch.slug, {
                actor: agentActor('finalize', 's-finalize'),
                type: 'publication.requested',
                payload: {
                  operation: 'finalize',
                  branch: `ab/${launch.slug}`,
                  sha: SHA,
                  description: { kind: description.kind, rev: description.revision },
                },
              })
            } else {
              // Reconcile re-attachment is idempotent: a runner that starts
              // after the reconcile request already exists appends nothing.
              const existing = await store.getEvents(launch.slug)
              if (
                !existing.some(
                  (event) =>
                    event.type === 'publication.requested' &&
                    event.payload.operation === 'reconcile',
                )
              ) {
                await store.append(launch.slug, {
                  actor: KERNEL,
                  type: 'reconcile.started',
                  payload: { attempt: 1, baseSha: BASE },
                })
                const notes = await store.putArtifact(launch.slug, {
                  kind: 'reconcile-notes',
                  content: 'merged updated base',
                })
                await store.append(launch.slug, {
                  actor: agentActor('reconcile', 's-reconcile'),
                  type: 'publication.requested',
                  payload: {
                    operation: 'reconcile',
                    branch: `ab/${launch.slug}`,
                    sha: 'c'.repeat(40),
                    artifact: { kind: notes.kind, rev: notes.revision },
                  },
                })
              }
            }
            const result = { exitCode: 0 }
            this.lastExitCode = result.exitCode
            return result
          },
        }
        return command
      }
      return {
        exitCode:
          params.cmd === 'git' && (params.args as string[] | undefined)?.includes('--unset-all')
            ? 5
            : 0,
      }
    }
    async writeFiles() {}
    async stop() {}
    async delete() {
      this.deleted = true
    }
    async update(_params: { networkPolicy: NetworkPolicy }) {}
  }

  const sandbox = new SandboxDouble()
  let created = false
  const facade: VercelSandboxFacade = {
    get: async () => (created && !sandbox.deleted ? sandbox : null),
    create: async () => {
      created = true
      sandbox.deleted = false
      return sandbox
    },
    listSnapshots: async () => [],
    deleteSnapshot: async () => {},
  }
  const hostCommands: string[][] = []
  const exec: Exec = async (cmd, options) => {
    hostCommands.push([...cmd])
    const ref = cmd.at(-1)
    if (cmd.includes('get-url'))
      return { stdout: 'https://github.com/acme/app.git\n', stderr: '', exitCode: 0 }
    if (cmd.includes('ls-remote')) {
      const sha = ref === 'refs/heads/main' ? BASE : remote.head
      return { stdout: sha === null ? '' : `${sha}\t${ref}\n`, stderr: '', exitCode: 0 }
    }
    return spawnExec(cmd, options)
  }

  try {
    await mkdir(repo, { recursive: true })
    await Bun.write(
      join(repo, 'autobuild.toml'),
      '[tickets]\nsource = "file"\nreadyState = "Ready"\n[roles.default]\nruntime = "claude"\n',
    )
    await writeFile(join(repo, 'README.md'), 'fixture')
    await spawnExec(['git', 'init', '-q', '-b', 'main'], { cwd: repo })
    await spawnExec(['git', 'add', '.'], { cwd: repo })
    await spawnExec(
      [
        'git',
        '-c',
        'user.name=Autobuild Test',
        '-c',
        'user.email=test@invalid',
        'commit',
        '-qm',
        'fixture',
      ],
      { cwd: repo },
    )
    const tickets = new FakeTicketSource([
      {
        ref: { source: 'file', id: 'T-1', title: 'Composed remote build' },
        title: 'Composed remote build',
        body: '## Problem\nRemote.\n## Acceptance criteria\n- Works.\n## Out of scope\n- None.\n',
        state: 'Ready',
        labels: [],
      },
    ])
    const provider = new VercelSandboxProvider({
      config: {
        image: 'vercel/sandbox/universal:latest',
        vcpus: 4,
        timeoutSeconds: 2700,
        failoverRegions: [],
        environmentVariables: [],
      },
      env: { GITHUB_TOKEN: 'publication-secret' },
      storeRef: 'https://store.example.test',
      storeToken: 'scoped-token',
      repo,
      facade,
      exec,
      // Bounded observation waits resolve in milliseconds, never the 5 s default.
      observeWaitMs: 25,
      packageArchive: async () => new Uint8Array([1]),
    })
    const runner = new ScriptedAgentRunner({
      script: async () => defaultTurnResult('unused local runtime'),
    })
    const wiring: DispatchWiring = {
      store,
      tickets,
      forge,
      workspaces: provider,
      buildExecution: provider.buildExecution,
      runtimes: { claude: { runner, servesModels: [] } },
      storeRef: 'https://store.example.test',
      token: 'scoped-token',
      ids,
      uuids: randomUuids(),
      clock: systemClock,
    }
    const dispatch = () =>
      abDispatch({
        targetRepo: repo,
        env: { GITHUB_TOKEN: 'publication-secret' },
        exec,
        stdout: () => undefined,
        stderr: () => undefined,
        once: true,
        plain: true,
        wire: () => wiring,
      })

    // Each --once settles the PREVIOUS execution at its settlement stage and
    // launches the next runner; a launch may land in the kicking invocation's
    // background continuation or in the next invocation's recovery, so the
    // sequence waits on durable facts rather than dispatch counts.
    const requested =
      (operation: string) =>
      (events: Awaited<ReturnType<typeof store.getEvents>>): boolean =>
        events.some(
          (event) =>
            event.type === 'publication.requested' && event.payload.operation === operation,
        )
    const dispatchUntil = async (
      predicate: (events: Awaited<ReturnType<typeof store.getEvents>>) => boolean,
    ): Promise<void> => {
      for (let attempt = 0; attempt < 6; attempt += 1) {
        await dispatch()
        const slug = (await store.listBuilds())[0]?.slug
        const events = slug === undefined ? [] : await store.getEvents(slug)
        if (predicate(events)) return
      }
      throw new Error('log never reached the expected state')
    }

    await dispatchUntil(requested('implement')) // provision + implementation publication request
    await dispatchUntil(requested('finalize-step')) // settles implement; verification request
    await dispatchUntil(requested('finalize')) // settles the finalize step; PR publication request

    const build = (await store.listBuilds())[0]!
    await store.append(build.slug, {
      actor: DISPATCHER,
      type: 'pr.conflicted',
      payload: { baseSha: BASE },
    })
    await dispatchUntil((events) => events.some((event) => event.type === 'reconcile.started'))
    await dispatch() // settles the reconcile publication

    const events = await store.getEvents(build.slug)
    expect(events.filter((event) => event.type === 'publication.requested')).toHaveLength(4)
    expect(events.some((event) => event.type === 'implement.completed')).toBe(true)
    expect(events.some((event) => event.type === 'verify.completed')).toBe(true)
    expect(
      events.some(
        (event) =>
          event.type === 'finalize.step-completed' &&
          event.payload.ok &&
          event.payload.headSha === SHA,
      ),
    ).toBe(true)
    expect(events.some((event) => event.type === 'finalize.completed')).toBe(true)
    expect(events.some((event) => event.type === 'reconcile.completed')).toBe(true)
    expect(events.some((event) => event.type === 'phase.failed')).toBe(false)
    expect(forge.opened).toHaveLength(1)
    expect(remote.head).toBe('c'.repeat(40))
    const detached = commands.filter((command) => command.detached === true)
    expect(detached).toHaveLength(5)
    expect(commands).toContainEqual({
      cmd: 'npm',
      args: ['install', '--prefix', VERCEL_BUN_PREFIX, '--no-save', `bun@${VERCEL_BUN_VERSION}`],
    })
    expect(
      commands.filter(
        (command) =>
          command.cmd === VERCEL_BUN_EXECUTABLE &&
          (command.args as string[] | undefined)?.[0] === '--version',
      ),
    ).toHaveLength(6)
    for (const launch of detached) {
      expect(launch).toMatchObject({
        cmd: 'sh',
        args: [
          '-c',
          `PATH=${VERCEL_BUN_BIN_PATH}:$PATH exec ${VERCEL_BUN_EXECUTABLE} ${VERCEL_AUTOBUILD_PATH}/bin/ab-build-runner.ts`,
        ],
      })
    }
    expect(hostCommands.some((command) => command.includes('worktree'))).toBe(false)
  } finally {
    await store.close()
    await rm(tmp, { recursive: true, force: true })
  }
}, 30_000)

/** The detached-guest settlement scenario (AUT-352): the launching invocation
 * detaches while the guest is still running, the guest then exits, and the
 * next invocation's settlement observes the recorded command through the
 * provider's real contract — the plain lookup reports no exit until some wait
 * observed one — and settles the build within that one tick. Proves
 * `execution.ended` with the observed exit code, the `implement.completed`
 * completion fact with the settled publication, the next phase's runner
 * re-attached in place, and no reap of the environment. Each `--once`
 * invocation wires a fresh provider, exactly as separate invocation processes
 * do, so the detached execution's in-memory supervision never leaks into the
 * invocation that settles it. */
test('a guest that exits after the launching invocation detached is settled by the next tick', async () => {
  const tmp = await mkdtemp(join(tmpdir(), 'ab-vercel-detached-'))
  const repo = join(tmp, 'repo')
  const store = new MemoryBuildStore()
  const ids = sequentialIds()
  const forge = new FakeForge({ headSha: SHA })
  const remote = { head: null as string | null }
  const commands: Array<Record<string, unknown>> = []

  class DetachedSandboxDouble implements VercelSandboxHandle {
    readonly name = 'autobuild-detached'
    provisioned = false
    deleted = false
    /** Simulated `/opt/autobuild/.distribution-version` marker content. */
    distributionVersion: string | undefined
    /** Observed exit per command id: what the plain lookup reports, `null`
     * until some wait has observed an exit — the provider's behavior. */
    readonly observed = new Map<string, number | null>()
    /** Wait calls per command id. The first wait on a command is the
     * launching invocation's supervision long-poll, which blocks until its
     * teardown detach aborts it; the guest keeps running. */
    private readonly waits = new Map<string, number>()
    /** Durable acts the guest performs when a later invocation's bounded
     * observation wait reaches its exit; one-shot, then the guest is gone. */
    guestActs: (() => Promise<void>) | undefined
    launches = 0

    getCommand(cmdId: string): Promise<VercelCommandLookup> {
      if (!this.observed.has(cmdId)) {
        return Promise.reject(
          Object.assign(new Error('command not found'), { response: { status: 404 } }),
        )
      }
      return Promise.resolve({
        exitCode: this.observed.get(cmdId) ?? null,
        wait: (waitParams?: { signal?: AbortSignal }) => this.waitCommand(cmdId, waitParams),
      })
    }

    private waitCommand(
      cmdId: string,
      params?: { signal?: AbortSignal },
    ): Promise<{ exitCode: number }> {
      const count = (this.waits.get(cmdId) ?? 0) + 1
      this.waits.set(cmdId, count)
      if (count > 1 && this.guestActs !== undefined) {
        // A later invocation's bounded observation wait reaches the guest's
        // exit: the guest performs its final acts and exits 0, and the plain
        // lookup reports the exit from now on.
        const acts = this.guestActs
        this.guestActs = undefined
        return acts().then(() => {
          this.observed.set(cmdId, 0)
          return { exitCode: 0 }
        })
      }
      // The launching invocation's supervision long-poll (first wait), or an
      // observation of a guest still running: blocks until its signal
      // aborts, modelling an interrupted long-poll.
      return new Promise<never>((_, reject) => {
        params?.signal?.addEventListener(
          'abort',
          () => reject(params.signal!.reason ?? new Error('aborted')),
          { once: true },
        )
      })
    }

    async runCommand(params: Record<string, unknown>) {
      commands.push(params)
      if (params.cmd === 'test') return { exitCode: this.provisioned ? 0 : 1 }
      if (params.cmd === 'touch') this.provisioned = true
      if (
        params.cmd === 'cat' &&
        (params.args as string[])?.[0] === VERCEL_DISTRIBUTION_VERSION_MARKER
      ) {
        if (this.distributionVersion === undefined) return { exitCode: 1 }
        return { exitCode: 0, stdout: async () => this.distributionVersion }
      }
      if (
        params.cmd === 'sh' &&
        (params.args as string[])?.[1] === 'printf %s "$1" > "$2"' &&
        (params.args as string[])?.[4] === VERCEL_DISTRIBUTION_VERSION_MARKER
      ) {
        this.distributionVersion = (params.args as string[])![3] as string
        return { exitCode: 0 }
      }
      if (params.cmd === 'git' && (params.args as string[] | undefined)?.includes('push')) {
        remote.head = (params.args as string[]).at(-1)!.split(':')[0]!
      }
      if (params.detached === true) {
        this.launches += 1
        const cmdId = `cmd-e2e-${this.launches}`
        this.observed.set(cmdId, null)
        const command: VercelCommand = {
          exitCode: null,
          cmdId,
          kill: async () => undefined,
          wait: (waitParams?: { signal?: AbortSignal }) => this.waitCommand(cmdId, waitParams),
        }
        return command
      }
      return {
        exitCode:
          params.cmd === 'git' && (params.args as string[] | undefined)?.includes('--unset-all')
            ? 5
            : 0,
      }
    }
    async writeFiles() {}
    async stop() {}
    async delete() {
      this.deleted = true
    }
    async update(_params: { networkPolicy: NetworkPolicy }) {}
  }

  const sandbox = new DetachedSandboxDouble()
  let created = false
  let creates = 0
  const facade: VercelSandboxFacade = {
    get: async () => (created && !sandbox.deleted ? sandbox : null),
    create: async () => {
      created = true
      creates += 1
      sandbox.deleted = false
      return sandbox
    },
    listSnapshots: async () => [],
    deleteSnapshot: async () => {},
  }
  const hostCommands: string[][] = []
  const exec: Exec = async (cmd, options) => {
    hostCommands.push([...cmd])
    const ref = cmd.at(-1)
    if (cmd.includes('get-url'))
      return { stdout: 'https://github.com/acme/app.git\n', stderr: '', exitCode: 0 }
    if (cmd.includes('ls-remote')) {
      const sha = ref === 'refs/heads/main' ? BASE : remote.head
      return { stdout: sha === null ? '' : `${sha}\t${ref}\n`, stderr: '', exitCode: 0 }
    }
    return spawnExec(cmd, options)
  }

  try {
    await mkdir(repo, { recursive: true })
    await Bun.write(
      join(repo, 'autobuild.toml'),
      '[tickets]\nsource = "file"\nreadyState = "Ready"\n[roles.default]\nruntime = "claude"\n',
    )
    await writeFile(join(repo, 'README.md'), 'fixture')
    await spawnExec(['git', 'init', '-q', '-b', 'main'], { cwd: repo })
    await spawnExec(['git', 'add', '.'], { cwd: repo })
    await spawnExec(
      [
        'git',
        '-c',
        'user.name=Autobuild Test',
        '-c',
        'user.email=test@invalid',
        'commit',
        '-qm',
        'fixture',
      ],
      { cwd: repo },
    )
    const tickets = new FakeTicketSource([
      {
        ref: { source: 'file', id: 'T-1', title: 'Detached guest settlement' },
        title: 'Detached guest settlement',
        body: '## Problem\nRemote.\n## Acceptance criteria\n- Works.\n## Out of scope\n- None.\n',
        state: 'Ready',
        labels: [],
      },
    ])
    const runner = new ScriptedAgentRunner({
      script: async () => defaultTurnResult('unused local runtime'),
    })
    // Fresh provider per invocation, sharing the one environment double: the
    // model of separate invocation processes around one persistent sandbox.
    const makeWiring = (): DispatchWiring => {
      const provider = new VercelSandboxProvider({
        config: {
          image: 'vercel/sandbox/universal:latest',
          vcpus: 4,
          timeoutSeconds: 2700,
          failoverRegions: [],
          environmentVariables: [],
        },
        env: { GITHUB_TOKEN: 'publication-secret' },
        storeRef: 'https://store.example.test',
        storeToken: 'scoped-token',
        repo,
        facade,
        exec,
        // Bounded observation waits resolve in milliseconds, never the 5 s
        // default.
        observeWaitMs: 25,
        packageArchive: async () => new Uint8Array([1]),
      })
      return {
        store,
        tickets,
        forge,
        workspaces: provider,
        buildExecution: provider.buildExecution,
        runtimes: { claude: { runner, servesModels: [] } },
        storeRef: 'https://store.example.test',
        token: 'scoped-token',
        ids,
        uuids: randomUuids(),
        clock: systemClock,
      }
    }
    const dispatch = () =>
      abDispatch({
        targetRepo: repo,
        env: { GITHUB_TOKEN: 'publication-secret' },
        exec,
        stdout: () => undefined,
        stderr: () => undefined,
        once: true,
        plain: true,
        wire: () => makeWiring(),
      })

    // The guest's final acts, performed when the settlement invocation's
    // bounded observation wait reaches the detached command: the same
    // durable sequence the incident evidence recorded (plan, approved plan
    // review, implement notes, and the implement publication request).
    sandbox.guestActs = async () => {
      const slug = (await store.listBuilds())[0]!.slug
      const plan = await store.putArtifact(slug, { kind: 'plan', content: '# Plan' })
      await store.append(slug, {
        actor: agentActor('plan', 's-plan'),
        type: 'plan.completed',
        payload: {
          round: 1,
          artifact: { kind: plan.kind, rev: plan.revision },
          verifySteps: [],
        },
      })
      const review = await store.putArtifact(slug, {
        kind: 'plan-review',
        content: 'approved',
      })
      await store.append(slug, {
        actor: agentActor('plan-review', 's-plan-review'),
        type: 'plan-review.verdict',
        payload: {
          round: 1,
          verdict: 'approve',
          findings: [],
          artifact: { kind: review.kind, rev: review.revision },
        },
      })
      const notes = await store.putArtifact(slug, {
        kind: 'implement-notes',
        content: 'implemented',
      })
      await store.append(slug, {
        actor: agentActor('implement', 's-implement'),
        type: 'publication.requested',
        payload: {
          operation: 'implement',
          branch: `ab/${slug}`,
          sha: SHA,
          round: 1,
          base: BASE,
          artifact: { kind: notes.kind, rev: notes.revision },
        },
      })
    }

    const countEvents = async (type: string): Promise<number> => {
      const slug = (await store.listBuilds())[0]?.slug
      if (slug === undefined) return 0
      return (await store.getEvents(slug)).filter((event) => event.type === type).length
    }
    const dispatchUntil = async (predicate: () => Promise<boolean>): Promise<void> => {
      for (let attempt = 0; attempt < 6; attempt += 1) {
        await dispatch()
        if (await predicate()) return
      }
      throw new Error('log never reached the expected state')
    }

    // First invocation: provisions, launches the implement guest, and
    // detaches at teardown while the guest is still running — its
    // supervision long-poll blocks and is aborted, so no exit is observed.
    await dispatchUntil(async () => (await countEvents('execution.started')) >= 1)
    const slug = (await store.listBuilds())[0]!.slug
    const firstCommandId = [...sandbox.observed.keys()][0]!
    expect(sandbox.launches).toBe(1)
    // The provider's plain lookup still reports no exit: nothing has waited.
    expect(sandbox.observed.get(firstCommandId)).toBeNull()

    // Second invocation: settlement observes the recorded command — the
    // lookup shows no exit, so its bounded wait performs the guest's final
    // acts and observes exit 0 — and settles the execution, lease, and
    // publication.
    await dispatchUntil(async () => (await countEvents('execution.ended')) >= 1)
    const events = await store.getEvents(slug)
    const ended = events.find((event) => event.type === 'execution.ended')
    expect(ended?.payload).toMatchObject({
      outcome: 'completed',
      exitCode: 0,
    })
    expect((ended!.payload as { workspaceRef: string }).workspaceRef).toMatch(
      /^autobuild-detached-guest-settlement-g0-/,
    )
    expect(events.some((event) => event.type === 'implement.completed')).toBe(true)
    expect(remote.head).toBe(SHA)
    // The lookup now reports the exit the wait observed.
    expect(sandbox.observed.get(firstCommandId)).toBe(0)

    // The next phase re-attaches in place: a second runner launches on the
    // same environment, and nothing reaps it.
    await dispatchUntil(async () => (await countEvents('execution.started')) >= 2)
    const detached = commands.filter((command) => command.detached === true)
    expect(detached).toHaveLength(2)
    expect(sandbox.launches).toBe(2)
    expect(sandbox.deleted).toBe(false)
    expect(creates).toBe(1)
    expect(hostCommands.some((command) => command.includes('worktree'))).toBe(false)
  } finally {
    await store.close()
    await rm(tmp, { recursive: true, force: true })
  }
}, 30_000)
