/**
 * A stale local branch sharing a new build's slug (#1261). On 2026-11-25 a
 * fresh build adopted `refs/heads/ab/<slug>` left behind by a months-old
 * merged build, recorded its tip as the base, and parked forever on
 * `target-rewritten` because main does not descend from it. Real git, real
 * GitWorktreeProvider: the claim-time probe picks another slug, and a build
 * that still meets the stale ref at first provision cuts fresh from main.
 */
import { afterEach, expect, test } from 'bun:test'
import { join } from 'node:path'
import { realpath } from 'node:fs/promises'
import type { WorkspaceProvider } from '../ports/types'
import { GitWorktreeProvider } from '../ports/workspace/git-worktree'
import { fallbackSlug } from '../processes/dispatcher'
import {
  type E2eHarness,
  GIT_ID,
  git,
  happyHandlers,
  ofType,
  readyTicket,
  scenarioScope,
  writeFileIn,
} from './harness'

const scenario = scenarioScope({ test, afterEach })
const TICKET = readyTicket('T-1')
const SLUG = fallbackSlug(TICKET.title)

/** A commit main does not descend from, present on the forge under a non-build
 * ref (as GitHub keeps a merged PR's head) and as a stale local build branch. */
async function staleCommit(h: E2eHarness): Promise<string> {
  const sha = await git(
    [...GIT_ID, 'commit-tree', 'HEAD^{tree}', '-p', 'HEAD', '-m', 'old merged build'],
    h.origin,
  )
  await git(['push', '-q', 'origin', `${sha}:refs/pull/281/head`], h.origin)
  return sha
}

async function pointStaleBranch(repo: string, branch: string, sha: string): Promise<void> {
  await git(['update-ref', `refs/heads/${branch}`, sha], repo)
  await git(['update-ref', `refs/remotes/origin/${branch}`, sha], repo)
}

/** Dispatch the ticket and run its runner until plan escalates. */
async function dispatchToPlan(h: E2eHarness, reached: string[]) {
  await h.dispatcher.tick()
  const build = (await h.store.listBuilds())[0]!
  await h.runLatest()
  const events = await h.events(build.slug)
  const main = await git(['rev-parse', 'refs/heads/main'], h.remote)
  const first = ofType(events, 'workspace.provisioned')[0]!
  expect(first.payload.base.source).not.toBe('existing')
  expect(first.payload.base.sha).toBe(main)
  expect(reached).toEqual([build.slug])
  expect(ofType(events, 'target.rewritten')).toEqual([])
  return { build, events, first }
}

function handlers(reached: string[]) {
  return {
    ...happyHandlers(),
    plan: async (cli: { run(argv: string[]): Promise<string[]>; env: { build: string } }) => {
      await cli.run(['context'])
      reached.push(cli.env.build)
      await cli.run(['escalate', 'scenario stops after plan starts'])
    },
  }
}

scenario(
  'a stale local branch of the chosen slug makes the claim pick another slug',
  async (make) => {
    const reached: string[] = []
    const h = await make({ handlers: handlers(reached), tickets: [TICKET] })
    const stale = await staleCommit(h)
    await pointStaleBranch(h.origin, `ab/${SLUG}`, stale)

    const { build } = await dispatchToPlan(h, reached)
    expect(build.slug).toBe(`${SLUG}-2`)
    expect(build.branch).toBe(`ab/${SLUG}-2`)
    expect(await git(['rev-parse', `refs/heads/ab/${SLUG}`], h.origin)).toBe(stale)
  },
)

scenario(
  'a build that meets the stale branch at first provision cuts fresh from main',
  async (make) => {
    for (const attached of [false, true]) {
      const reached: string[] = []
      let stale = ''
      let foreign = ''
      const h = await make({
        handlers: handlers(reached),
        tickets: [TICKET],
        // The stale ref appears after the claim's probe, as for a build claimed
        // before the fix or a race between claim and provision.
        createWorkspaceProvider: ({ worktreeRoot }) => {
          const real = new GitWorktreeProvider({ root: worktreeRoot })
          let armed = true
          return new Proxy(real, {
            get: (target, key, receiver) =>
              key === 'provision'
                ? async (input: Parameters<WorkspaceProvider['provision']>[0]) => {
                    if (armed) {
                      armed = false
                      await pointStaleBranch(input.repo, input.branch, stale)
                      if (attached) {
                        foreign = join(await target.assertIsolatedRoot(input.repo), `ab-${SLUG}`)
                        await git(['worktree', 'add', '-q', foreign, input.branch], input.repo)
                        await writeFileIn(foreign, 'uncommitted.txt', 'foreign work\n')
                      }
                    }
                    return target.provision(input)
                  }
                : Reflect.get(target, key, receiver),
          })
        },
      })
      stale = await staleCommit(h)

      const { build } = await dispatchToPlan(h, reached)
      expect(build.slug).toBe(SLUG)
      expect(
        await git(['rev-parse', `refs/autobuild/displaced/ab/${SLUG}/${stale}`], h.origin),
      ).toBe(stale)
      if (attached) {
        const aside = join(await realpath(join(foreign, '..')), '.displaced', `ab-${SLUG}`, stale)
        expect(await Bun.file(join(aside, 'uncommitted.txt')).text()).toBe('foreign work\n')
      }
      await h.cleanup()
    }
  },
)
