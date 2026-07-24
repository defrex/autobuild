import { expect, test } from 'bun:test'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { reduceBuild } from '../kernel/reducer'
import { emptyTickReport } from '../processes/dispatcher'
import { spawnExec } from '../ports/workspace/git-worktree'
import {
  CONFIG_TOML,
  GIT_ID,
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
  } = {},
): Promise<{ h: E2eHarness; slug: string }> {
  const h = await makeHarness({
    handlers: opts.handlers ?? happyHandlers(),
    tickets: [readyTicket(opts.ticket ?? 'PF-1')],
    configToml: opts.configToml ?? PLUGIN_CONFIG,
    pluginForge: {
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
    const context = JSON.parse(await readFile(join(cli.ws, '.ab', 'context.json'), 'utf8')) as {
      conflict?: { baseSha: string }
    }
    const baseSha = context.conflict?.baseSha
    if (baseSha === undefined) throw new Error('reconcile context omitted baseSha')
    const merge = await spawnExec(
      ['git', ...GIT_ID, 'merge', '--no-ff', '-m', 'reconcile plugin forge', baseSha],
      { cwd: cli.ws },
    )
    if (merge.exitCode !== 0) throw new Error(merge.stderr)
    const notes = await writeFileIn(
      cli.ws,
      '.ab/reconcile-notes.md',
      'Merged current main through the selected plugin forge.\n',
    )
    await cli.run(['done', '--notes', notes])
  }

  const { h, slug } = await openPluginBuild({ handlers, ticket: 'PF-conflict' })
  try {
    await h.advanceRemote({ 'upstream.txt': 'upstream movement\n' }, 'advance main')
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
    expect(h.forge.pushes).toHaveLength(2)

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
    const image = join(cli.ws, '.ab', 'plugin-forge.png')
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
