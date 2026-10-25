import { readVerifyPipeline } from '../config/pipeline-source'
import { Dispatcher } from './dispatcher'
import { FakeForge } from '../ports/forge/fake'
import { FakeTicketSource } from '../ports/tickets/fake'
import { FakeWorkspaceProvider } from '../ports/workspace/fake'
import { nativeLandingApplied } from '../kernel/landing-state'
import { done } from '../cli/terminals'
import { parseAbPhase } from '../cli/env'
import { defaultTurnResult } from '../ports/runner/fake'
import { ScriptedAgentRunner } from '../ports/runner/fake'
import { expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { seedStore, BUILD, BRANCH } from '../cli/testkit'
import { parseConfig } from '../config/load'
import { KERNEL, humanActor } from '../events/envelope'
import { sequentialIds } from '../ids'
import { LocalGitForge } from '../ports/forge/local-git'
import { bunExec } from '../ports/forge/github'
import { leafRestackLog } from '../kernel/generators/leaf-restack-log'
import { BuildRunner, selectVerifyDiffBase } from './build-runner'
import { readBuildFacts } from '../store/reduced-reads'
import { settlePendingPublication } from '../cli/publication-settlement'

const CONFIG_TOML = `
[roles.default]
runtime = "scripted"
[tickets]
source = "file"
readyState = "ready"
[commands]
test = "true"
[verify]
steps = ["unit"]
[verify.unit]
kind = "check"
command = "test"
`
const config = parseConfig(CONFIG_TOML)
for (const conflict of [false, true])
  for (const { remote, recovery } of [false, true].flatMap((remote) =>
    (!remote && conflict ? ['none', 'contention', 'pause'] : ['none']).map((recovery) => ({
      remote,
      recovery,
    })),
  ))
    test(`automatic ${conflict ? 'conflicted' : 'clean'} ${remote ? 'trusted remote' : 'local'} restack gates verification and preserves evidence after waiting rewrites (${recovery})`, async () => {
      const cwd = await mkdtemp(join(tmpdir(), 'ab-leaf-'))
      async function git(args: string[]) {
        const result = await bunExec(['git', ...args], { cwd })
        if (result.exitCode !== 0) throw new Error(result.stderr)
        return result.stdout.trim()
      }
      async function file(name: string, text: string) {
        await writeFile(join(cwd, name), text)
        await git(['add', name])
        await git(['commit', '-qm', name])
        return git(['rev-parse', 'HEAD'])
      }
      try {
        await git(['init', '-q', '-b', 'main'])
        await git(['config', 'user.name', 'Test'])
        await git(['config', 'user.email', 'test@example.invalid'])
        await git(['config', 'commit.gpgsign', 'false'])
        await git(['config', 'rerere.enabled', 'false'])
        await file('autobuild.toml', CONFIG_TOML)
        const base = await file('base', 'base\n')
        await git(['checkout', '-qb', BRANCH])
        await file('feature', 'first\n')
        const oldHead = await file('feature', 'second\n')
        await git(['checkout', '-q', 'main'])
        const target = await file(conflict ? 'feature' : 'upstream', 'upstream\n')
        await git(['checkout', '-q', BRANCH])
        const store = await seedStore()
        await store.append(BUILD, {
          actor: KERNEL,
          type: 'workspace.provisioned',
          payload: {
            provider: 'git-worktree',
            remote,
            ref: cwd,
            branch: BRANCH,
            base: { source: 'remote', sha: base },
          },
        })
        for (const event of leafRestackLog().slice(2, 6)) {
          const payload =
            event.type === 'implement.completed'
              ? { ...event.payload, commits: { base, head: oldHead } }
              : event.payload
          await store.append(BUILD, { actor: event.actor, type: event.type, payload })
        }
        // A clean local entry has no prior observation: the runner must
        // resolve the target itself before allowing verification.
        if (remote || conflict) {
          await store.append(BUILD, {
            actor: KERNEL,
            type: 'target.moved',
            payload: { branch: 'main', sha: target },
          })
        }
        const forge = new LocalGitForge({ exec: bunExec })
        let competingHead: string | undefined
        if (!remote && (!conflict || recovery === 'contention')) {
          const capability = forge.rewrite!
          Object.defineProperty(forge, 'rewrite', {
            configurable: true,
            value: {
              ...capability,
              replace: async (input: Parameters<typeof capability.replace>[0]) => {
                if (competingHead === undefined) {
                  const tree = await git(['rev-parse', `${oldHead}^{tree}`])
                  competingHead = await git([
                    'commit-tree',
                    tree,
                    '-p',
                    oldHead,
                    '-m',
                    'external descendant',
                  ])
                  await git(['update-ref', `refs/heads/${BRANCH}`, competingHead, oldHead])
                }
                return capability.replace(input)
              },
            },
          })
        }

        let sessions = 0
        const deps = {
          store: store.scopeBuild(BUILD),
          config,
          ...(!conflict ? { readVerifyPipeline: () => readVerifyPipeline(cwd, bunExec) } : {}),
          runtimes: {
            scripted: {
              runner: new ScriptedAgentRunner({
                script: async (ctx) => {
                  expect(conflict).toBe(true)
                  const branchBefore = await git(['rev-parse', BRANCH])
                  await writeFile(join(cwd, 'feature'), 'resolved\n')
                  await git(['add', 'feature'])
                  await git(['cherry-pick', '--continue'])
                  const notes = `${cwd}-notes.md`
                  await writeFile(notes, 'Resolved the leaf and upstream changes together.\n')
                  try {
                    const parsed = parseAbPhase(ctx.opts.env.AB_PHASE!)
                    await done(
                      {
                        store,
                        forge,
                        workspacePath: cwd,
                        exec: bunExec,
                        ids: sequentialIds(),
                        env: {
                          store: 'local',
                          build: BUILD,
                          phase: parsed.phase,
                          round: parsed.round,
                          session: ctx.opts.env.AB_SESSION!,
                        },
                      },
                      { notes },
                    )
                    expect(await git(['rev-parse', BRANCH])).toBe(branchBefore)
                    if (recovery === 'pause') {
                      await store.append(BUILD, {
                        actor: humanActor('operator'),
                        type: 'build.pause-requested',
                        payload: {},
                      })
                      await store.append(BUILD, {
                        actor: KERNEL,
                        type: 'build.paused',
                        payload: {},
                      })
                    }
                  } finally {
                    await rm(notes, { force: true })
                  }
                  return defaultTurnResult()
                },
              }),
              servesModels: [],
            },
          },
          workspacePath: cwd,
          branch: BRANCH,
          slug: BUILD,
          exec: bunExec,
          forge,
          ids: sequentialIds(),
          clock: () => new Date(),
          instance: 'test',
          host: 'test',
        }
        await store.claimLease(BUILD, 'test', 3_600_000)
        deps.clock = () => new Date('2026-07-15T12:00:00.000Z')
        const runner = new BuildRunner(deps)
        const settle = async () =>
          settlePendingPublication(
            {
              store,
              storeRef: 'local',
              forge,
              workspacePath: cwd,
              exec: bunExec,
              ids: sequentialIds(),
              runId: 'test',
              publication: {
                publish: async () => {
                  throw new Error('must use rewrite')
                },
                rewrite: async (input) => {
                  for (const archive of input.archives)
                    await forge.rewrite!.archive({ ...archive, workspacePath: cwd })
                  return forge.rewrite!.replace({
                    workspacePath: cwd,
                    branch: input.branch,
                    expected: input.expected,
                    localExpected: input.localExpected,
                    sha: input.sha,
                  })
                },
              },
            },
            BUILD,
          )
        expect(await runner.step()).toMatchObject({ kind: 'restack', trigger: 'verify-entry' })
        if (!remote && !conflict) {
          expect(await runner.step()).toMatchObject({ kind: 'restack', trigger: 'verify-entry' })
          const recovered = (await readBuildFacts(store, BUILD)).value.log.restack.completed!
          expect(recovered.id).toEndWith('-retry')
          if (competingHead === undefined) throw new Error('contention was not injected')
          expect(recovered.oldHead).toBe(competingHead)
        }

        if (conflict)
          expect(await runner.step()).toMatchObject({ kind: 'run-phase', phase: 'reconcile' })
        if (recovery === 'contention') {
          const contended = (await store.getEvents(BUILD)).find(
            (e) => e.type === 'reconcile.contended',
          )
          expect(contended?.actor.kind).toBe('kernel')
          expect(contended?.payload.actual).toBe(competingHead)
          expect((await readBuildFacts(store, BUILD)).value.publication.pending()).toBe(false)
          expect(await runner.step()).toMatchObject({ kind: 'run-phase', phase: 'reconcile' })
          const prepared = (await store.getEvents(BUILD)).filter(
            (e) => e.type === 'reconcile.prepared',
          )
          expect(prepared).toHaveLength(2)
          expect(prepared.at(-1)?.payload.oldHead).toBe(competingHead)
          expect(prepared.at(-1)?.payload.id).not.toBe(prepared[0]?.payload.id)
          expect((await store.getEvents(BUILD)).filter((e) => e.type === 'phase.failed')).toEqual(
            [],
          )
        }
        if (recovery === 'pause') {
          expect((await readBuildFacts(store, BUILD)).value.state.status).toBe('paused')
          expect((await readBuildFacts(store, BUILD)).value.publication.pending()).toBe(true)
          expect(await git(['rev-parse', BRANCH])).toBe(oldHead)
          // Park again after publication so run() cannot enter finalize.
          const append = store.append.bind(store)
          store.append = async (slug, write) => {
            const event = await append(slug, write)
            if (write.type === 'reconcile.completed') {
              await append(slug, {
                actor: humanActor('operator'),
                type: 'build.pause-requested',
                payload: {},
              })
            }
            return event
          }
          await store.append(BUILD, {
            actor: humanActor('operator'),
            type: 'build.resume-requested',
            payload: {},
          })
          await runner.run()
          store.append = append
          expect((await readBuildFacts(store, BUILD)).value.publication.pending()).toBe(false)
          expect((await readBuildFacts(store, BUILD)).value.state.status).toBe('paused')
          await store.append(BUILD, {
            actor: humanActor('operator'),
            type: 'build.resume-requested',
            payload: {},
          })
          expect(await runner.step()).toEqual({ kind: 'acknowledge', command: 'resume' })
        }
        if (remote) {
          expect(await git(['rev-parse', BRANCH])).toBe(oldHead)
          const request = (
            await readBuildFacts(store, BUILD)
          ).value.publication.latestUncompletedRequest()!
          expect(request.payload.operation).toBe(conflict ? 'reconcile' : 'restack')
          await store.append(BUILD, {
            actor: humanActor('operator'),
            type: 'build.resume-requested',
            payload: {},
          })
          const sessionStarts = (await store.getEvents(BUILD)).filter(
            (e) => e.type === 'session.started',
          ).length
          await runner.run()
          expect(
            (await store.getEvents(BUILD)).filter((e) => e.type === 'session.started'),
          ).toHaveLength(sessionStarts)
          expect((await readBuildFacts(store, BUILD)).value.publication.pending()).toBe(true)
          await settle()
          await settle()
        }
        const canonical = await git(['rev-parse', BRANCH])
        expect(await git(['show', '-s', '--format=%P', canonical])).toBe(target)
        expect(await git(['rev-list', '--count', `${target}..${canonical}`])).toBe('1')
        expect(await git(['diff', '--name-only', target, canonical])).toBe('feature')
        expect((await readBuildFacts(store, BUILD)).value.state.implement.commits).toEqual({
          base: target,
          head: canonical,
        })
        expect(selectVerifyDiffBase(await store.getEvents(BUILD))).toBe(target)
        expect(await runner.step()).toMatchObject({ kind: 'run-check', step: 'unit' })
        const verification = (await store.getEvents(BUILD)).find(
          (e) => e.type === 'verify.completed',
        )!
        expect(verification.payload).toMatchObject({
          baseSha: target,
          headSha: canonical,
          outcome: 'pass',
        })
        if ((await readBuildFacts(store, BUILD)).value.state.pendingCommands.length)
          await store.append(BUILD, { actor: KERNEL, type: 'build.resumed', payload: {} })
        const pr = await forge.openPr({
          workspacePath: cwd,
          head: BRANCH,
          base: 'main',
          title: 'Verified contribution',
          body: 'Restack fixture',
        })
        await store.append(BUILD, {
          actor: KERNEL,
          type: 'finalize.completed',
          payload: { pr },
        })
        // Model native auto-merge that persists across arbitrary branch pushes.
        // Drive real dispatcher decisions and commands around the real restack.
        const native = new FakeForge()
        native.setPrState(pr.number, { state: 'open', mergeable: true })
        native.setPrHeadSha(pr.number, pr.headSha)
        native.setGatePresence(pr.number, 'present')
        forge.setAutoMerge = native.setAutoMerge.bind(native)
        const readPr = forge.getPrState.bind(forge)
        forge.getPrState = (_path, number) => readPr(cwd, number)
        const tickets = new FakeTicketSource([
          {
            ref: { source: 'linear', id: 'ENG-42' },
            title: 'Feature',
            body: '',
            state: 'In Progress',
            labels: [],
            resolved: false,
            revision: 'fixture',
          },
        ])
        Object.defineProperty(tickets, 'name', { value: 'linear' })
        const dispatcher = new Dispatcher({
          store,
          tickets,
          forge,
          config: { ...config, landing: [{ mode: 'consent' }] },
          workspaces: new FakeWorkspaceProvider({ mode: 'logical' }),
          repo: 'acme/app',
          checkout: cwd,
          exec: async (args, options) =>
            args[0] === 'git' && args[1] === 'ls-remote'
              ? {
                  exitCode: 0,
                  stderr: '',
                  stdout: `${await git(['rev-parse', 'main'])}\trefs/heads/main\n`,
                }
              : bunExec(args, options),
          launchRunner: async () => 'already-active',
          ids: sequentialIds(),
          clock: deps.clock,
        })
        const poll = async () => {
          const report = await dispatcher.tick({ acceptNewWork: false })
          expect(report.janitorDiagnostics).toEqual([])
        }
        await poll()
        const decided = (await readBuildFacts(store, BUILD)).value.state.landing!.decision!
        const consent = await store.append(BUILD, {
          actor: humanActor('operator'),
          type: 'build.land-requested',
          payload: { decisionSeq: decided.seq },
        })
        await poll()
        expect(native.isAutoMergeEnabled(pr.number)).toBe(true)
        const capability = forge.rewrite!
        Object.defineProperty(forge, 'rewrite', {
          value: {
            ...capability,
            replace: async (input: Parameters<typeof capability.replace>[0]) => {
              expect(native.isAutoMergeEnabled(pr.number)).toBe(false)
              expect(
                (await readBuildFacts(store, BUILD)).value.state.landing?.native?.enabled,
              ).toBe(false)
              return capability.replace(input)
            },
          },
        })
        // Several target moves collapse into one transaction on the newest snapshot.
        await git(['checkout', '-q', 'main'])
        const intermediate = await file('upstream', 'newer\n')
        const newest = await file('upstream', 'newest\n')
        await git(['checkout', '-q', BRANCH])
        for (const sha of [intermediate, target, newest])
          await store.append(BUILD, {
            actor: KERNEL,
            type: 'target.moved',
            payload: { branch: 'main', sha },
          })
        await poll()
        expect(native.isAutoMergeEnabled(pr.number)).toBe(false)
        expect(await runner.step()).toMatchObject({
          kind: 'restack',
          trigger: 'awaiting-landing',
        })
        if (remote) await settle()
        const rewritten = await git(['rev-parse', BRANCH])
        expect(await git(['show', '-s', '--format=%P', rewritten])).toBe(newest)
        expect((await store.getEvents(BUILD)).filter((e) => e.type === 'verify.completed')).toEqual(
          [verification],
        )
        expect(await runner.step()).toEqual({ kind: 'wait', reason: 'awaiting-pr' })
        if (!conflict) {
          const events = await store.getEvents(BUILD)
          expect(events.filter((event) => event.type === 'verify.config-captured')).toHaveLength(1)
          expect(events.filter((event) => event.type === 'verify.config-superseded')).toHaveLength(
            0,
          )
          expect(events.filter((event) => event.type === 'verify.completed')).toEqual([
            verification,
          ])
          const pin = (await readBuildFacts(store, BUILD)).value.state.verify.configPin!
          expect(pin.head).toBe(canonical)
          expect(
            (
              await bunExec(['git', 'merge-base', '--is-ancestor', pin.source.commit!, rewritten], {
                cwd,
              })
            ).exitCode,
          ).toBe(1)
        }
        await poll()
        const landing = (await readBuildFacts(store, BUILD)).value.state.landing!
        expect(landing.command?.seq).toBe(consent.seq)
        expect(landing.acknowledgedSeq).toBe(consent.seq)
        expect(landing.decision?.candidate.head).toBe(rewritten)
        expect(landing.native?.candidate?.head).toBe(rewritten)
        expect(nativeLandingApplied(landing)).toBe(true)
        expect(native.isAutoMergeEnabled(pr.number)).toBe(true)
        const events = await store.getEvents(BUILD)
        sessions += events.filter((e) => e.type === 'session.started').length
        expect(sessions).toBe(recovery === 'contention' ? 2 : conflict ? 1 : 0)
        expect(events.filter((e) => e.type === 'restack.completed')).toHaveLength(2)
        expect(await git(['rev-parse', `refs/autobuild/archive/${BUILD}/${oldHead}`])).toBe(oldHead)
        if (!conflict) {
          // Keeping completed evidence must not hide a pipeline change that
          // arrives in a later clean waiting rewrite.
          await git(['checkout', '-q', 'main'])
          const configTarget = await file(
            'autobuild.toml',
            CONFIG_TOML.replaceAll('unit', 'renamed'),
          )
          await git(['checkout', '-q', BRANCH])
          await store.append(BUILD, {
            actor: KERNEL,
            type: 'target.moved',
            payload: { branch: 'main', sha: configTarget },
          })
          await poll()
          expect(await runner.step()).toMatchObject({
            kind: 'restack',
            trigger: 'awaiting-landing',
          })
          if (remote) await settle()
          expect(await runner.step()).toMatchObject({
            kind: 'run-check',
            step: 'renamed',
            attempt: 2,
          })
          const refreshed = await store.getEvents(BUILD)
          expect(
            refreshed.filter((event) => event.type === 'verify.config-superseded'),
          ).toHaveLength(1)
          expect(refreshed.filter((event) => event.type === 'verify.config-captured')).toHaveLength(
            2,
          )
        }
      } finally {
        await rm(cwd, { recursive: true, force: true })
      }
    })

test('trusted automatic publication waits for both session and guest settlement and settles once', async () => {
  const store = await seedStore()
  const original = leafRestackLog().find((e) => e.type === 'restack.prepared')!
  if (original.type !== 'restack.prepared') throw new Error('missing fixture')
  const transaction = { ...original.payload, branch: BRANCH }
  const intent = { ...transaction, headSha: 'e'.repeat(40) }
  await store.append(BUILD, {
    actor: KERNEL,
    type: 'workspace.provisioned',
    payload: {
      provider: 'sandbox',
      remote: true,
      ref: 'sandbox-1',
      branch: BRANCH,
      base: { source: 'remote', sha: transaction.oldBase },
    },
  })
  await store.append(BUILD, { actor: KERNEL, type: 'restack.prepared', payload: transaction })
  await store.append(BUILD, { actor: KERNEL, type: 'restack.publish-intended', payload: intent })
  await store.append(BUILD, {
    actor: KERNEL,
    type: 'publication.requested',
    payload: { operation: 'restack', branch: BRANCH, sha: intent.headSha, rewrite: intent },
  })
  await store.append(BUILD, {
    actor: KERNEL,
    type: 'session.started',
    payload: {
      session: 'live',
      role: 'implement',
      runner: 'scripted',
      phase: 'implement',
      round: 1,
    },
  })
  const dispatcher = { kind: 'dispatcher' } as const
  await store.append(BUILD, {
    actor: dispatcher,
    type: 'execution.started',
    payload: { provider: 'sandbox', workspaceRef: 'sandbox-1', instance: 'guest' },
  })
  await store.claimLease(BUILD, 'guest', 60_000)
  const lease = (await store.getBuild(BUILD))!.lease!
  const clock = () => new Date(Date.parse(lease.expiresAt) - 1000)
  const native = new FakeForge()
  native.setPrState(1, { state: 'open', mergeable: true })
  await native.setAutoMerge('/unused', 1, true)
  await store.append(BUILD, {
    actor: KERNEL,
    type: 'finalize.completed',
    payload: { pr: { number: 1, url: 'https://forge/1', headSha: transaction.oldHead } },
  })
  let replacements = 0
  const settle = () =>
    settlePendingPublication(
      {
        store,
        storeRef: 'local',
        clock,
        workspacePath: '/unused',
        exec: bunExec,
        forge: native,
        ids: sequentialIds(),
        runId: 'test',
        publication: {
          publish: async () => {
            throw new Error('regular push forbidden')
          },
          rewrite: async () => {
            expect(native.isAutoMergeEnabled(1)).toBe(false)
            expect(
              (await readBuildFacts(store, BUILD)).value.state.landing?.native?.operation,
            ).toMatch(/^publication:/)
            replacements++
            return { kind: 'published' }
          },
        },
      },
      BUILD,
    )
  await settle()
  expect(replacements).toBe(0)
  await store.append(BUILD, {
    actor: KERNEL,
    type: 'session.ended',
    payload: {
      session: 'live',
      outcome: 'reclaimed',
      reclaimedBy: { instance: 'recovery', resumedFromSeq: 0 },
    },
  })
  await settle()
  expect(replacements).toBe(0)
  await store.append(BUILD, {
    actor: dispatcher,
    type: 'execution.ended',
    payload: { instance: 'guest', workspaceRef: 'sandbox-1', outcome: 'completed' },
  })
  await settle()
  await settle()
  expect(replacements).toBe(1)
  expect((await store.getEvents(BUILD)).filter((e) => e.type === 'restack.completed')).toHaveLength(
    1,
  )
})
