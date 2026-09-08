import { describe, expect, test } from 'bun:test'
import { resolve } from 'node:path'
import { abDispatch } from '../cli/dispatch'
import { openProductionStore } from '../cli/store-opening'
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
 * must reach PR creation and ordinary sandbox deletion through durable facts.
 */
describe.skipIf(!enabled)('Vercel Sandbox complete build (opt-in)', () => {
  test(
    'runs an independent consuming repository through publication and PR creation',
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
      for (let pass = 0; pass < 20; pass += 1) {
        await dispatchOnce()
        const observed = openProductionStore(storeRef, token)
        try {
          slug ??= (await observed.listBuilds())
            .filter((build) => build.repo === repo)
            .find((candidate) => !before.has(candidate.slug))?.slug
          if (slug !== undefined) events = await observed.getEvents(slug)
        } finally {
          await observed.close()
        }
        if (events.some((event) => event.type === 'finalize.completed')) break
      }

      expect(slug).toBeDefined()
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
