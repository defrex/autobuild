/**
 * Forge issue links end to end (SPEC "Forge issue links"): a leaf claimed
 * from a linked ticket opens its PR and lands its squash with one keyword
 * line per issue, an implement-phase downgrade turns `Closes` into `Refs`,
 * and a forge without issue-closing support records the links but writes
 * nothing. In-memory store, scripted agents, fake forge; no network.
 */
import { afterEach, expect, test } from 'bun:test'
import { humanActor } from '../events/envelope'
import { reduceBuild } from '../kernel/reducer'
import {
  commitAll,
  happyHandlers,
  makeHarness,
  readyTicket,
  writeFileIn,
  type E2eHarness,
} from './harness'

const SLUG = 'add-rate-limiting'
const LINKS = [
  { issue: 820, intent: 'refs' as const },
  { issue: 824, intent: 'closes' as const },
]

const harnesses: E2eHarness[] = []
afterEach(async () => {
  while (harnesses.length > 0) await harnesses.pop()!.cleanup()
})

/** Claim, run every phase to the open PR, then let the janitor squash it. */
async function landLinkedLeaf(
  options: { closesIssues?: boolean; downgrade?: boolean } = {},
): Promise<{ h: E2eHarness; message: string }> {
  const handlers = happyHandlers()
  if (options.downgrade === true)
    handlers.implement = async (cli) => {
      await cli.run(['context'])
      await writeFileIn(cli.ws, 'rate-limit.txt', 'throttle after 5\n')
      await writeFileIn(cli.ws, 'ok.marker', 'ok\n')
      await commitAll(cli.ws, 'implement: rate limiting')
      await cli.run(['issue', 'downgrade', '824', '--reason', 'only login is throttled'])
      const notes = await writeFileIn(cli.ws, '.ab/implement-notes.md', 'Partial.\n')
      await cli.run(['done', '--notes', notes])
    }
  handlers.finalize = async (cli) => {
    await cli.run(['context'])
    const pr = await writeFileIn(
      cli.ws,
      '.ab/pr-description.md',
      'Add login rate limiting\n\nThis fixes #820 for the login form.\n',
    )
    await cli.run(['artifact', 'put', 'pr-description', pr])
    await cli.run(['done'])
  }
  const h = await makeHarness({
    handlers,
    tickets: [readyTicket('T-1', { issueLinks: LINKS })],
    gatePresence: 'absent',
    ...(options.closesIssues === true ? { closesIssues: true } : {}),
  })
  harnesses.push(h)

  await h.dispatcher.tick()
  const realOpen = h.forge.openPr.bind(h.forge)
  h.forge.openPr = async (opts) => {
    const pr = await realOpen(opts)
    h.forge.setPrState(pr.number, { state: 'open', mergeable: true })
    return pr
  }
  await h.store.append(SLUG, {
    actor: humanActor('operator'),
    type: 'build.auto-merge-requested',
    payload: {},
  })
  expect((await h.runLatest()).prState).toBe('open')
  expect(h.cliErrors).toEqual([])
  await h.dispatcher.tick()
  expect(h.forge.squashMergeCalls).toHaveLength(1)
  await h.dispatcher.tick()
  const state = reduceBuild(await h.events(SLUG))
  expect(state.outcome).toBe('merged')
  return { h, message: await h.forge.readCommitMessage('', state.mergedSha!) }
}

test('a linked leaf writes keyword lines into its PR body and landed commit', async () => {
  const { h, message } = await landLinkedLeaf({ closesIssues: true })
  expect(h.forge.opened[0]!.body).toBe(
    'This refs #820 for the login form.\n\nRefs #820\nCloses #824\n',
  )
  expect(message).toBe(
    'Add login rate limiting\n\nThis refs #820 for the login form.\n\nRefs #820\nCloses #824\n\nAutobuild-Build: add-rate-limiting\n',
  )
}, 30_000)

test('an implement-phase downgrade makes the PR and landed commit reference the issue', async () => {
  const { h, message } = await landLinkedLeaf({ closesIssues: true, downgrade: true })
  const state = reduceBuild(await h.events(SLUG))
  expect(state.issueLinks[1]).toMatchObject({
    issue: 824,
    intent: 'refs',
    downgrade: { reason: 'only login is throttled' },
  })
  expect(h.forge.opened[0]!.body).toEndWith('\n\nRefs #820\nRefs #824\n')
  expect(message).toContain('\n\nRefs #820\nRefs #824\n\nAutobuild-Build: add-rate-limiting\n')
  expect(message).not.toContain('Closes')
}, 30_000)

test('a forge without issue-closing support records links and still merges without keywords', async () => {
  const { h, message } = await landLinkedLeaf()
  expect(reduceBuild(await h.events(SLUG)).issueLinks).toEqual(LINKS)
  expect(h.forge.opened[0]!.body).toBe('This fixes #820 for the login form.\n')
  expect(message).not.toContain('Closes #')
  expect(message).not.toContain('Refs #')
}, 30_000)
