import { describe, expect, test } from 'bun:test'
import { resolve } from 'node:path'
import { abDispatch } from '../cli/dispatch'
import { openProductionStore } from '../cli/store-opening'
import { spawnExec } from '../ports/workspace/git-worktree'

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

      await abDispatch({
        targetRepo: repo,
        env: process.env,
        exec: spawnExec,
        stdout: () => undefined,
        stderr: () => undefined,
        once: true,
        storeRef,
        plain: true,
      })

      const store = openProductionStore(storeRef, token)
      try {
        const build = (await store.listBuilds())
          .filter((build) => build.repo === repo)
          .find((candidate) => !before.has(candidate.slug))
        expect(build).toBeDefined()
        const events = await store.getEvents(build!.slug)
        expect(events.some((event) => event.type === 'publication.requested')).toBe(true)
        expect(events.some((event) => event.type === 'finalize.completed')).toBe(true)
      } finally {
        await store.close()
      }
    },
    30 * 60_000,
  )
})
