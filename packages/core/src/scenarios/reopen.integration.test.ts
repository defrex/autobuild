/**
 * Reopening a settled, unmerged leaf end to end (SPEC §15.7): a leaf opens
 * its PR and settles awaiting merge; the operator reopens it with feedback;
 * the dispatcher re-admits it, implement receives the feedback through
 * `ab context`, review, verify and finalize run again, finalize adopts the
 * same PR, and the re-settled leaf merges on fresh consent. In-memory store,
 * scripted agents, fake forge; no network.
 */
import { afterEach, expect, test } from 'bun:test'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { controlBuild } from '../cli/build-control'
import { reduceBuild } from '../kernel/reducer'
import {
  commitAll,
  git,
  happyHandlers,
  makeHarness,
  readyTicket,
  writeFileIn,
  type E2eHarness,
} from './harness'

const SLUG = 'add-rate-limiting'

const harnesses: E2eHarness[] = []
afterEach(async () => {
  while (harnesses.length > 0) await harnesses.pop()!.cleanup()
})

test('a reopened leaf re-runs on its branch, updates the same PR and merges on fresh consent', async () => {
  const handlers = happyHandlers()
  const happyImplement = handlers.implement!
  const seen: unknown[] = []
  handlers.implement = async (cli) => {
    const lines = await cli.run(['context'])
    const manifest = lines.find((line) => line.startsWith('manifest: '))!.slice('manifest: '.length)
    const reopen = JSON.parse(await readFile(join(cli.ws, manifest), 'utf8')).reopen
    if (reopen === undefined) return happyImplement(cli)
    seen.push(reopen)
    await writeFileIn(cli.ws, 'flag.txt', 'renamed\n')
    await commitAll(cli.ws, 'implement: rename the flag')
    const notes = await writeFileIn(cli.ws, '.ab/implement-notes.md', 'Renamed the flag.\n')
    await cli.run(['done', '--notes', notes])
  }
  const h = await makeHarness({
    handlers,
    tickets: [readyTicket('T-1')],
    gatePresence: 'absent',
  })
  harnesses.push(h)

  await h.dispatcher.tick()
  const realOpen = h.forge.openPr.bind(h.forge)
  h.forge.openPr = async (opts) => {
    const pr = await realOpen(opts)
    h.forge.setPrState(pr.number, { state: 'open', mergeable: true })
    return pr
  }
  const first = await h.runLatest()
  expect(first.prState).toBe('open')
  expect(h.cliErrors).toEqual([])
  const pr = first.pr!.number
  const repo = (await h.store.getBuild(SLUG))!.repo
  // The reviewer holds the merge while asking for changes.
  await controlBuild({
    store: h.store,
    repo,
    slug: SLUG,
    user: 'reviewer',
    action: { kind: 'hold' },
  })
  await h.dispatcher.tick()
  let state = reduceBuild(await h.events(SLUG))
  expect(state.pipelineSettled).toBeDefined()
  expect(h.forge.squashMergeCalls).toEqual([])

  await controlBuild({
    store: h.store,
    repo,
    slug: SLUG,
    user: 'reviewer',
    action: { kind: 'reopen', feedback: 'rename the flag' },
  })
  // The hold stays in force through the reopen.
  expect(reduceBuild(await h.events(SLUG)).landing?.command?.kind).toBe('hold')
  const launches = h.launched.length
  await h.dispatcher.tick()
  expect(h.launched.length).toBe(launches + 1)
  state = await h.runLatest()
  expect(h.cliErrors).toEqual([])
  expect(seen).toEqual([expect.objectContaining({ user: 'reviewer', feedback: 'rename the flag' })])
  // Finalize adopted the existing PR; the branch carries the new commit.
  expect(h.forge.opened).toHaveLength(1)
  expect(state.pr?.number).toBe(pr)
  expect(state.prState).toBe('open')
  expect(state.implement.round).toBe(2)
  const branch = `ab/${SLUG}`
  expect(await git(['show', `${branch}:flag.txt`], h.remote)).toBe('renamed')

  await h.dispatcher.tick()
  state = reduceBuild(await h.events(SLUG))
  expect(state.pipelineSettled).toBeGreaterThan(state.reopen!.seq)
  expect(h.forge.squashMergeCalls).toEqual([])
  // The janitor decides the new candidate on its next poll.
  await h.dispatcher.tick()
  state = reduceBuild(await h.events(SLUG))
  expect(state.landing?.decision?.candidate.cycle).toBe(String(state.finalizeCompletedSeq))
  await controlBuild({
    store: h.store,
    repo,
    slug: SLUG,
    user: 'reviewer',
    action: { kind: 'land' },
  })
  await h.dispatcher.tick()
  expect(h.forge.squashMergeCalls).toHaveLength(1)
  await h.dispatcher.tick()
  expect(reduceBuild(await h.events(SLUG)).outcome).toBe('merged')
}, 60_000)
