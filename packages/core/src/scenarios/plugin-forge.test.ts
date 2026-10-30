import { ForgeFailure, type ForgeRequestObserver, type Forge } from '../plugin-sdk'
import { readForgeHealth } from '../store/reduced-reads'
import { expect, test } from 'bun:test'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { reduceBuild } from '../kernel/reducer'
import { emptyTickReport } from '../processes/dispatcher'
import {
  CONFIG_TOML,
  GIT_ID,
  git,
  happyHandlers,
  makeHarness,
  ofType,
  readyTicket,
  writeFileIn,
  type E2eHarness,
  type SkillHandlers,
} from './harness'

const PLUGIN_CONFIG = CONFIG_TOML.replace(
  'baseBranch = "main"',
  'baseBranch = "main"\nforge = "plugin-fake"',
)

async function openPluginBuild(
  opts: {
    handlers?: SkillHandlers
    configToml?: string
    prAttachments?: boolean
    ticket?: string
    apiVersion?: string
  } = {},
): Promise<{ h: E2eHarness; slug: string }> {
  const h = await makeHarness({
    handlers: opts.handlers ?? happyHandlers(),
    tickets: [readyTicket(opts.ticket ?? 'PF-1')],
    configToml: opts.configToml ?? PLUGIN_CONFIG,
    pluginForge: {
      ...(opts.apiVersion ? { apiVersion: opts.apiVersion } : {}),
      ...(opts.prAttachments === true ? { prAttachments: true } : {}),
    },
  })
  expect(await h.dispatcher.tick()).toEqual({ ...emptyTickReport(), dispatched: 1 })
  const state = await h.runLatest()
  expect(state.prState).toBe('open')
  const slug = h.launched[0]!.slug
  expect(h.cliErrors).toEqual([])
  expect(h.forge.pushes).toHaveLength(1)
  expect(h.forge.opened).toHaveLength(1)
  expect(h.forge.comments).toHaveLength(1)
  return { h, slug }
}

test('a plugin-selected forge drives publication, PR plumbing, and merged completion', async () => {
  const { h, slug } = await openPluginBuild()
  try {
    h.forge.setPrState(1, { state: 'merged', sha: 'plugin-squash' })
    expect(await h.dispatcher.tick()).toEqual({ ...emptyTickReport(), merged: 1 })
    const events = await h.events(slug)
    expect(reduceBuild(events).outcome).toBe('merged')
    expect(ofType(events, 'pr.merged')[0]!.payload.sha).toBe('plugin-squash')
    expect(h.tickets.transitions).toEqual([{ id: 'PF-1', state: 'Done' }])
  } finally {
    await h.cleanup()
  }
}, 30_000)

test('a plugin-selected forge drives closed-unmerged completion', async () => {
  const { h, slug } = await openPluginBuild({ ticket: 'PF-closed' })
  try {
    h.forge.setPrState(1, { state: 'closed' })
    expect(await h.dispatcher.tick()).toEqual({ ...emptyTickReport(), closed: 1 })
    const events = await h.events(slug)
    expect(reduceBuild(events).outcome).toBe('closed-unmerged')
    expect(ofType(events, 'pr.closed')).toHaveLength(1)
    expect(h.tickets.transitions).toEqual([{ id: 'PF-closed', state: 'Triage' }])
  } finally {
    await h.cleanup()
  }
}, 30_000)

test('a plugin-selected forge drives conflict detection, reconcile publication, and eventual merge', async () => {
  const handlers = happyHandlers()
  handlers.reconcile = async (cli) => {
    await cli.run(['context'])
    const context = JSON.parse(
      await readFile(join(cli.ws, cli.env.contextDir!, 'context.json'), 'utf8'),
    ) as {
      conflict?: { baseSha: string }
    }
    const baseSha = context.conflict?.baseSha
    if (baseSha === undefined) throw new Error('reconcile context omitted baseSha')
    // The forge conflict must also exist in Git: a clean replay never needs
    // the reconcile agent, regardless of the scripted PR mergeability flag.
    expect(await git(['ls-files', '-u'], cli.ws)).not.toBe('')
    await writeFileIn(
      cli.ws,
      'rate-limit.txt',
      'upstream audit preserved\nfeature throttle after 5 preserved\n',
    )
    await git(['add', 'rate-limit.txt'], cli.ws)
    await git([...GIT_ID, 'cherry-pick', '--continue'], cli.ws)
    const notes = await writeFileIn(
      cli.ws,
      '.ab/reconcile-notes.md',
      'Merged current main through the selected plugin forge.\n',
    )
    await cli.run(['done', '--notes', notes])
  }

  const { h, slug } = await openPluginBuild({ handlers, ticket: 'PF-conflict' })
  try {
    await h.advanceRemote({ 'rate-limit.txt': 'upstream audit\n' }, 'advance main')
    h.clock.advance(3_600_001)
    h.forge.setPrState(1, { state: 'open', mergeable: false })
    expect(await h.dispatcher.tick()).toEqual({
      ...emptyTickReport(),
      conflicted: 1,
    })
    await h.runLatest()
    let events = await h.events(slug)
    expect(ofType(events, 'pr.conflicted')).toHaveLength(1)
    expect(ofType(events, 'reconcile.completed')).toHaveLength(1)
    expect(h.forge.pushes).toHaveLength(1)
    expect(ofType(events, 'reconcile.rewritten')).toHaveLength(1)
    expect(h.cliErrors).toEqual([])
    const workspace = ofType(events, 'workspace.provisioned')[0]!.payload.ref
    expect(await git(['show', 'HEAD:rate-limit.txt'], workspace)).toBe(
      'upstream audit preserved\nfeature throttle after 5 preserved',
    )

    h.forge.setPrState(1, { state: 'merged', sha: 'reconciled-plugin-squash' })
    expect(await h.dispatcher.tick()).toEqual({ ...emptyTickReport(), merged: 1 })
    events = await h.events(slug)
    expect(reduceBuild(events).outcome).toBe('merged')
  } finally {
    await h.cleanup()
  }
}, 30_000)

function attachmentHandlers(): SkillHandlers {
  const handlers = happyHandlers()
  handlers.finalize = async (cli) => {
    await cli.run(['context'])
    const image = join(cli.ws, cli.env.contextDir!, 'plugin-forge.png')
    await writeFile(image, new Uint8Array([137, 80, 78, 71, 1]))
    await cli.run(['artifact', 'put', 'visual:plugin-forge', image, '--attach'])
    const description = await writeFileIn(
      cli.ws,
      '.ab/pr-description.md',
      'Plugin forge attachment\n\nExercises optional hosting capability.\n',
    )
    await cli.run(['artifact', 'put', 'pr-description', description])
    await cli.run(['done'])
  }
  return handlers
}

const HOSTED_CONFIG = `${PLUGIN_CONFIG}\n[pr.imageHost]\nprovider = "github-release"\nrepository = "acme/review-assets"\nreleaseId = 42\n`

test('a text-only plugin forge keeps pinned attachment retrieval and records a hosting follow-up', async () => {
  const { h, slug } = await openPluginBuild({
    handlers: attachmentHandlers(),
    configToml: HOSTED_CONFIG,
    ticket: 'PF-text',
  })
  try {
    const events = await h.events(slug)
    expect(ofType(events, 'pr-attachment.hosted')).toHaveLength(0)
    expect(
      ofType(events, 'observation.recorded').some((event) =>
        event.payload.summary.includes('does not support PR attachment hosting'),
      ),
    ).toBe(true)
    expect(h.forge.comments[0]!.body).toContain('ab artifact download')
    expect(h.forge.comments[0]!.body).not.toContain('<img ')
  } finally {
    await h.cleanup()
  }
}, 30_000)

test('an attachment-capable plugin forge uploads inline images and janitor reclaims them', async () => {
  const { h, slug } = await openPluginBuild({
    handlers: attachmentHandlers(),
    configToml: HOSTED_CONFIG,
    prAttachments: true,
    ticket: 'PF-hosted',
  })
  try {
    let events = await h.events(slug)
    expect(h.forge.prAttachmentUploads).toHaveLength(1)
    expect(ofType(events, 'pr-attachment.hosted')).toHaveLength(1)
    expect(h.forge.comments[0]!.body).toContain('<img ')

    h.forge.setPrState(1, { state: 'merged', sha: 'hosted-plugin-squash' })
    expect(await h.dispatcher.tick()).toEqual({ ...emptyTickReport(), merged: 1 })
    events = await h.events(slug)
    expect(h.forge.prAttachmentReclaims).toHaveLength(1)
    expect(ofType(events, 'pr-attachment.reclaimed')).toHaveLength(1)
  } finally {
    await h.cleanup()
  }
}, 30_000)

test('current-API plugin receives bounded summary calls for hundreds of post-PR designations', async () => {
  let writes = 0
  const handlers = happyHandlers()
  handlers['many-attachments'] = async (cli) => {
    const file = await writeFileIn(cli.ws, '.ab/evidence.txt', 'evidence\n')
    for (let i = 0; i < 300; i++) {
      await cli.run(['artifact', 'put', `evidence:${i}`, file, '--attach'])
      expect(writes).toBe(1) // initial finalize boundary only
    }
  }
  const h = await makeHarness({
    handlers,
    tickets: [readyTicket('PF-many')],
    configToml: `${PLUGIN_CONFIG}\n[finalize]\nsteps = ["evidence"]\n[finalize.evidence]\nkind = "agent"\nskill = "many-attachments"\n`,
    pluginForge: {},
  })
  try {
    // This plugin still exposes only the existing commentOnPr contract.
    const original = h.forge.commentOnPr.bind(h.forge)
    h.forge.commentOnPr = async (...args) => {
      writes++
      return original(...args)
    }
    await h.dispatcher.tick()
    await h.runLatest()
    expect(h.cliErrors).toEqual([])
    expect(writes).toBe(2)
    const events = await h.events(h.launched[0]!.slug)
    expect(ofType(events, 'pr-attachment.designated')).toHaveLength(300)
    expect(ofType(events, 'pr-summary.attempted')).toHaveLength(2)
    expect(h.forge.comments[0]!.body.length).toBeLessThanOrEqual(65_536)
  } finally {
    await h.cleanup()
  }
}, 30_000)

test('an API 1.8 plugin records request attribution and recovers from classified limits', async () => {
  const { h, slug } = await openPluginBuild({ ticket: 'PF-limit', apiVersion: '^1.8.0' })
  try {
    const observers = new Set<ForgeRequestObserver>()
    ;(h.forge as Forge).observeRequests = (observer) => {
      observers.add(observer)
      return () => {
        observers.delete(observer)
      }
    }
    const poll = h.forge.getPrState.bind(h.forge)
    let limited = true
    const resetAt = new Date(h.clock().getTime() + 120_000).toISOString()
    h.forge.getPrState = async (...args) => {
      for (const observer of observers) observer({})
      if (limited) throw new ForgeFailure('plugin rate limit', { kind: 'rate-limited', resetAt })
      return poll(...args)
    }
    const failed = await h.dispatcher.tick({ acceptNewWork: false })
    expect(failed.janitorFailed).toBe(1)
    expect(failed.forgeRequests).toEqual({
      total: 1,
      unattributed: 0,
      builds: [{ build: slug, requests: 1 }],
      complete: true,
    })
    expect((await readForgeHealth(h.store, h.origin))?.resetAt).toBe(resetAt)
    const waiting = await h.dispatcher.tick({ acceptNewWork: false })
    expect(waiting.forgeRequests?.total).toBe(0)
    limited = false
    h.clock.advance(180_000)
    await h.dispatcher.tick({ acceptNewWork: false })
    expect(await readForgeHealth(h.store, h.origin)).toBeUndefined()
    expect(reduceBuild(await h.events(slug)).janitor).toBeUndefined()
  } finally {
    await h.cleanup()
  }
}, 30_000)
