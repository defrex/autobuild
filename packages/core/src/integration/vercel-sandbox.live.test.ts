import { describe, expect, test } from 'bun:test'
import { resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { abDispatch } from '../cli/dispatch'
import { openProductionStore } from '../cli/store-opening'
import { loadConfig } from '../config/load'
import { vercelSandboxConfigSchema } from '../config/schema'
import type { AbEvent } from '../events/catalog'
import { humanActor } from '../events/envelope'
import { spawnExec } from '../ports/workspace/git-worktree'
import { createVercelSdkFacade } from '../ports/workspace/vercel-sandbox'

const enabled = process.env.AB_RUN_VERCEL_SANDBOX_LIVE === '1'

/**
 * Actual-provider evidence path. The operator supplies an independent minimal
 * consuming checkout (not this repository) containing a ready file ticket and
 * a vercel-sandbox autobuild.toml, plus the hosted Store, Vercel, runtime, and
 * GitHub credentials documented in docs/configuration.md. A successful run
 * deletes the first live environment, observes a distinct replacement
 * identity, reaches PR creation, and performs ordinary terminal cleanup.
 */
describe.skipIf(!enabled)('Vercel Sandbox complete build (opt-in)', () => {
  test(
    'recovers an independent consuming repository after deleting its live sandbox',
    async () => {
      const repoInput = process.env.AB_VERCEL_SANDBOX_LIVE_REPO
      const storeRef = process.env.AB_STORE
      const token = process.env.AB_TOKEN
      if (!repoInput || !storeRef?.startsWith('https://') || !token) {
        throw new Error(
          'live Vercel test requires AB_VERCEL_SANDBOX_LIVE_REPO, HTTPS AB_STORE, and AB_TOKEN',
        )
      }
      const repo = resolve(repoInput)
      const config = await loadConfig(resolve(repo, 'autobuild.toml'))
      if (config.workspace.provider !== 'vercel-sandbox') {
        throw new Error('live Vercel test repository must select workspace provider vercel-sandbox')
      }
      const sandboxConfig = vercelSandboxConfigSchema.parse(config.workspace.config)
      if (!sandboxConfig.image.startsWith('vercel/sandbox/universal')) {
        throw new Error('live Vercel test requires the documented universal managed image')
      }
      const beforeStore = openProductionStore(storeRef, token)
      const before = new Set(
        (await beforeStore.listBuilds())
          .filter((build) => build.repo === repo)
          .map((build) => build.slug),
      )
      await beforeStore.close()

      const dispatchOnce = () =>
        abDispatch({
          targetRepo: repo,
          env: process.env,
          exec: spawnExec,
          stdout: () => undefined,
          stderr: () => undefined,
          once: true,
          storeRef,
          plain: true,
        })

      let slug: string | undefined
      let events: AbEvent[] = []
      const observe = async () => {
        const observed = openProductionStore(storeRef, token)
        try {
          slug ??= (await observed.listBuilds())
            .filter((build) => build.repo === repo)
            .find((candidate) => !before.has(candidate.slug))?.slug
          if (slug !== undefined) events = await observed.getEvents(slug)
        } finally {
          await observed.close()
        }
      }

      // Start the first remote execution without awaiting it, then delete the
      // exact environment named by its durable identity while its lease is
      // live. The attached rejection handler prevents a deliberate provider
      // interruption from becoming an unhandled promise rejection.
      const firstDispatch = dispatchOnce().then(
        () => undefined,
        (error) => error,
      )
      let original: Extract<AbEvent, { type: 'execution.started' }> | undefined
      for (let poll = 0; poll < 240; poll += 1) {
        await observe()
        original = events.findLast(
          (event): event is Extract<AbEvent, { type: 'execution.started' }> =>
            event.type === 'execution.started' &&
            !events.some(
              (candidate) =>
                candidate.type === 'execution.ended' &&
                candidate.payload.instance === event.payload.instance,
            ),
        )
        if (original !== undefined) break
        await delay(250)
      }
      expect(slug).toBeDefined()
      expect(original?.payload.environmentId).toBeDefined()
      expect(original?.payload.sessionId).toBeDefined()
      const originalSandbox = await createVercelSdkFacade(process.env).get(
        original!.payload.environmentId!,
      )
      expect(originalSandbox).not.toBeNull()
      await originalSandbox!.delete({ signal: AbortSignal.timeout(30_000) })
      await firstDispatch

      // The retained lease deliberately delays takeover. Poll ordinary
      // dispatcher invocations until expiry, replacement, and continuation.
      for (let pass = 0; pass < 180; pass += 1) {
        await dispatchOnce()
        await observe()
        if (events.some((event) => event.type === 'finalize.completed')) break
        await delay(1_000)
      }

      const executions = events.filter(
        (event): event is Extract<AbEvent, { type: 'execution.started' }> =>
          event.type === 'execution.started',
      )
      const replacement = executions.find(
        (event) => event.payload.instance !== original!.payload.instance,
      )
      expect(replacement?.payload.environmentId).toBeDefined()
      expect(replacement?.payload.sessionId).toBeDefined()
      expect(replacement?.payload.environmentId).not.toBe(original!.payload.environmentId)
      expect(replacement?.payload.sessionId).not.toBe(original!.payload.sessionId)
      expect(
        events.some(
          (event) =>
            event.type === 'workspace.released' &&
            'reason' in event.payload &&
            event.payload.reason === 'replacement',
        ),
      ).toBe(true)
      expect(events.some((event) => event.type === 'publication.requested')).toBe(true)
      const finalized = events.findLast((event) => event.type === 'finalize.completed')
      expect(finalized?.type).toBe('finalize.completed')
      const lastPublication = events.findLast((event) => event.type === 'publication.requested')
      expect(lastPublication?.type).toBe('publication.requested')
      const remote = await spawnExec(
        ['git', 'ls-remote', '--heads', 'origin', `refs/heads/ab/${slug}`],
        { cwd: repo },
      )
      expect(remote.exitCode).toBe(0)
      expect(remote.stdout.split(/\s+/)[0]).toBe(lastPublication!.payload.sha)

      const cleanupStore = openProductionStore(storeRef, token)
      await cleanupStore.append(slug!, {
        actor: humanActor('vercel-live-test'),
        type: 'build.abort-requested',
        payload: { reason: 'live test cleanup' },
      })
      await cleanupStore.close()
      for (let pass = 0; pass < 10; pass += 1) {
        await dispatchOnce()
        const observed = openProductionStore(storeRef, token)
        try {
          events = await observed.getEvents(slug!)
        } finally {
          await observed.close()
        }
        if (events.some((event) => event.type === 'workspace.released')) break
      }
      const provisioned = events.findLast((event) => event.type === 'workspace.provisioned')
      expect(events.some((event) => event.type === 'workspace.released')).toBe(true)
      expect(provisioned?.type).toBe('workspace.provisioned')
      expect(await createVercelSdkFacade(process.env).get(provisioned!.payload.ref)).toBeNull()
    },
    30 * 60_000,
  )
})
