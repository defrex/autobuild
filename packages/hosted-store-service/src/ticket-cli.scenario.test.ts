import { temporaryDirectories as ownTempDirectories } from '@defrex/autobuild/testing'
import { ticketProject } from './testing/ticket-project'
import { afterEach, expect, test } from 'bun:test'
import { rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { abTicket } from '@defrex/autobuild/testing'
import { MemoryBuildStore, FakeTicketSource } from '@defrex/autobuild/plugin-sdk'
import type { TicketSourceFactory } from '@defrex/autobuild/testing'
import { createHostedStoreService } from './service'

const mkdtemp = ownTempDirectories(afterEach)

interface ScenarioResult {
  output: unknown[]
  finalBody: string | undefined
  requests: string[]
}

async function runScenario(mode: 'direct' | 'hosted'): Promise<ScenarioResult> {
  const repo = await mkdtemp(join(tmpdir(), `ab-ticket-${mode}-`))
  const backend = new FakeTicketSource([
    {
      revision: 'fixture',
      ref: { source: 'fake', id: 'B', title: 'Dependency' },
      title: 'Dependency',
      body: 'dependency body',
      state: 'Triage',
      resolved: false,
      labels: [],
    },
  ])
  const requests: string[] = []
  let server: ReturnType<typeof Bun.serve> | undefined
  try {
    const source = mode === 'hosted' ? 'hosted' : 'fake'
    await writeFile(
      join(repo, 'autobuild.toml'),
      `[tickets]\nsource = "${source}"\n${
        mode === 'hosted' ? 'teamKey = "ENG"\n' : ''
      }readyState = "Ready"\nreadyLabels = []\n`,
    )
    const bodyPath = join(repo, 'body.md')
    const updatedBodyPath = join(repo, 'updated.md')
    await writeFile(bodyPath, '# Original\r\n\r\nbody  \r\n')
    const exactBody = '# Updated\r\n\r\nUnicode ☃\r\ntrailing\t '
    await writeFile(updatedBodyPath, exactBody)

    const env: Record<string, string | undefined> = {}
    let sourceFactory: TicketSourceFactory | undefined
    if (mode === 'direct') {
      sourceFactory = () => backend
    } else {
      const secret = 'cli-parity-secret'
      const project = await ticketProject(repo, secret)
      const service = createHostedStoreService({
        ...project,
        env: {
          AB_STORE_SECRET: secret,
          AB_POSTGRES_URL: 'postgres://unused/injected',
          AB_BLOB_BACKEND: 's3',
          AB_S3_BUCKET: 'unused',
          AB_S3_REGION: 'unused',
          AB_S3_ACCESS_KEY_ID: 'unused',
          AB_S3_SECRET_ACCESS_KEY: 'unused',
        },
        sourceFor: () => backend,
        // `show` lists the ticket's assets through the store.
        openStore: project.openStore,
      })
      server = Bun.serve({
        hostname: '127.0.0.1',
        port: 0,
        fetch: (request) => {
          // Repo and ticket ids are path segments; normalize the asset routes.
          requests.push(
            new URL(request.url).pathname
              .replace(/^\/repos\/[^/]+\/tickets\/[^/]+\/assets/, '/ticket-assets')
              .replace(/^\/repos\/[^/]+\/builds$/, '/repo-builds'),
          )
          return service.fetch(request)
        },
      })
      env.AB_STORE = `http://127.0.0.1:${server.port}`
      env.AB_TOKEN = project.token
    }

    const originalGet = backend.get.bind(backend)
    const commentBody = '  ☃\r\n\r\nAttached asset: evidence/test.png\n'
    backend.get = async (id) => {
      const ticket = await originalGet(id)
      return ticket
        ? {
            ...ticket,
            comments: backend.comments
              .filter((c) => c.id === id)
              .map((c) => ({
                body: c.body,
                createdAt: '2026-01-01T00:00:00.000Z',
              })),
          }
        : null
    }
    const output: unknown[] = []
    const invoke = async (argv: string[]) => {
      let text = ''
      await abTicket(argv, {
        targetRepo: repo,
        env,
        stdout: (line) => {
          text += line
        },
        stderr: () => {},
        ...(sourceFactory !== undefined ? { sourceFactory } : {}),
      })
      output.push(
        JSON.parse(text, (key, value: unknown) => (key === 'source' ? '<source>' : value)),
      )
    }

    await invoke(['create', 'Parity ticket', '--body', bodyPath, '--state', 'Ready', '--json'])
    await invoke([
      'update',
      'fake-1',
      '--title',
      'Updated parity ticket',
      '--body',
      updatedBodyPath,
      '--labels',
      'autobuild,ready',
      '--json',
    ])
    await invoke(['create', 'Node', '--body', bodyPath, '--kind', 'node', '--json'])
    await invoke(['update', 'fake-1', '--target', 'fake-2', '--json'])
    await invoke(['tree', '--json'])
    await invoke(['block', 'fake-1', 'B', '--json'])
    await invoke(['list', '--json'])
    await backend.comment('fake-1', commentBody)
    await invoke(['show', 'fake-1', '--json'])
    expect((output.at(-1) as { comments: unknown }).comments).toEqual([
      { body: commentBody, createdAt: '2026-01-01T00:00:00.000Z' },
    ])
    await invoke(['unblock', 'fake-1', 'B', '--json'])
    await invoke(['move', 'fake-1', 'Done', '--json'])

    return { output, finalBody: (await backend.get('fake-1'))?.body, requests }
  } finally {
    if (server !== undefined) await server.stop(true)
    await rm(repo, { recursive: true, force: true })
  }
}

test('all ab ticket subcommands have hosted/direct parity through normal config wiring', async () => {
  const direct = await runScenario('direct')
  const hosted = await runScenario('hosted')
  expect(hosted.output).toEqual(direct.output)
  expect(hosted.finalBody).toBe(direct.finalBody)
  expect(hosted.finalBody).toBe('# Updated\r\n\r\nUnicode ☃\r\ntrailing\t ')
  expect(new Set(hosted.requests)).toEqual(
    new Set([
      // Target writes consult claims before mutating provider metadata.
      '/repo-builds',
      '/tickets/policy',
      '/tickets/create',
      '/tickets/update',
      '/tickets/get',
      '/tickets/dependency-states',
      '/tickets/add-blocker',
      '/tickets/list-ready',
      '/tickets/remove-blocker',
      '/tickets/transition',
      // `show` also lists the ticket's assets from the store.
      '/ticket-assets/list',
    ]),
  )
}, 10_000)

test('ticket assets attach, list, download and remove over the hosted store and ticket source', async () => {
  const repo = await mkdtemp(join(tmpdir(), 'ab-ticket-assets-hosted-'))
  const backend = new FakeTicketSource([
    {
      revision: 'fixture',
      ref: { source: 'fake', id: 'fake-1' },
      title: 'Asset ticket',
      body: 'body',
      state: 'Ready',
      resolved: false,
      labels: [],
    },
  ])
  const secret = 'cli-assets-secret'
  const project = await ticketProject(repo, secret)
  const service = createHostedStoreService({
    ...project,
    env: {
      AB_STORE_SECRET: secret,
      AB_POSTGRES_URL: 'postgres://unused/injected',
      AB_BLOB_BACKEND: 's3',
      AB_S3_BUCKET: 'unused',
      AB_S3_REGION: 'unused',
      AB_S3_ACCESS_KEY_ID: 'unused',
      AB_S3_SECRET_ACCESS_KEY: 'unused',
    },
    sourceFor: () => backend,
    openStore: project.openStore,
  })
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: (r) => service.fetch(r) })
  try {
    await writeFile(
      join(repo, 'autobuild.toml'),
      `[tickets]\nsource = "hosted"\nurl = "${server.url.href}"\nteamKey = "ENG"\nreadyState = "Ready"\nreadyLabels = []\n`,
    )
    const locals = [new MemoryBuildStore(), new MemoryBuildStore()]
    let client = 0
    const env = {
      AB_STORE: join(repo, 'local-build-store'),
      AB_TICKET_URL: server.url.href,
      AB_TICKET_TOKEN: project.token,
    }
    const run = async (argv: string[]): Promise<string> => {
      const lines: string[] = []
      await abTicket(argv, {
        targetRepo: repo,
        env: { ...env, AB_STORE: join(repo, `local-build-store-${client}`) },
        openStore: () => locals[client]!,
        stdout: (line) => lines.push(line),
        stderr: () => {},
      })
      return lines.join('\n')
    }
    const file = join(repo, 'mock.png')
    await writeFile(file, Uint8Array.from([0, 1, 2, 250]))
    await run(['attach', 'fake-1', 'design', file])
    // The hosted ticket source's comment() carried the note to the backend.
    expect(backend.comments).toHaveLength(1)
    expect(backend.comments[0]?.id).toBe('fake-1')
    expect(backend.comments[0]?.body).toContain('`design/mock.png`')
    expect(backend.comments[0]?.body).toContain('ab ticket asset get fake-1 design mock.png <dest>')

    client = 1
    const shown = JSON.parse(await run(['show', 'fake-1', '--json'])) as {
      assets: { kind: string; name: string; revision: number; size: number }[]
    }
    expect(shown.assets).toEqual([
      expect.objectContaining({ kind: 'design', name: 'mock.png', revision: 0, size: 4 }),
    ])
    const dest = join(repo, 'out.png')
    await run(['asset', 'get', 'fake-1', 'design', 'mock.png', dest])
    expect(new Uint8Array(await Bun.file(dest).arrayBuffer())).toEqual(
      Uint8Array.from([0, 1, 2, 250]),
    )
    await writeFile(file, Uint8Array.from([9]))
    await run(['attach', 'fake-1', 'design', file])
    expect(JSON.parse(await run(['show', 'fake-1', '--json'])).assets[0].revision).toBe(1)
    await run(['asset', 'get', 'fake-1', 'design', 'mock.png', dest, '--rev', '0'])
    expect(new Uint8Array(await Bun.file(dest).arrayBuffer())).toEqual(
      Uint8Array.from([0, 1, 2, 250]),
    )
    for (const store of locals) expect(await store.listTicketAssets(repo, 'fake-1')).toEqual([])
    await run(['asset', 'rm', 'fake-1', 'design', 'mock.png'])
    expect(backend.comments).toHaveLength(3)
    expect(backend.comments[2]?.body).toContain('Ticket asset removed')
    expect(JSON.parse(await run(['show', 'fake-1', '--json'])).assets).toEqual([])
    // Existing service rows remain current attachments without copying or migration.
    await project.store.putTicketAsset(repo, 'fake-1', {
      kind: 'reference',
      name: 'legacy',
      layout: 'file',
      entries: [{ type: 'file', path: 'legacy', content: new Uint8Array([7]) }],
    })
    expect(JSON.parse(await run(['show', 'fake-1', '--json'])).assets).toEqual([
      expect.objectContaining({ kind: 'reference', name: 'legacy', revision: 0 }),
    ])
    await run(['asset', 'get', 'fake-1', 'reference', 'legacy', dest])
    expect(new Uint8Array(await Bun.file(dest).arrayBuffer())).toEqual(new Uint8Array([7]))
  } finally {
    await server.stop(true)
    await rm(repo, { recursive: true, force: true })
  }
}, 10_000)

test('CLI lists and creates hosted states with purpose and duplicate refusal', async () => {
  const repo = await mkdtemp(join(tmpdir(), 'ab-hosted-states-cli-'))
  const states: { name: string; tickets: number; about?: string }[] = [
    { name: 'triage', tickets: 0 },
  ]
  const backend = Object.assign(new FakeTicketSource(), {
    listStates: async () => states,
    addState: async (name: string, opts: { about?: string } = {}) => {
      if (states.some((s) => s.name.toLowerCase() === name.toLowerCase()))
        throw new Error(`database ticket source: state "${name}" already exists`)
      const state = { name, tickets: 0, ...opts }
      states.push(state)
      return { state, created: true }
    },
  })
  const project = await ticketProject(repo, 'states-secret')
  const service = createHostedStoreService({
    ...project,
    env: {
      AB_STORE_SECRET: 'states-secret',
      AB_POSTGRES_URL: 'postgres://unused/injected',
      AB_BLOB_BACKEND: 's3',
      AB_S3_BUCKET: 'unused',
      AB_S3_REGION: 'unused',
      AB_S3_ACCESS_KEY_ID: 'unused',
      AB_S3_SECRET_ACCESS_KEY: 'unused',
    },
    sourceFor: () => backend,
  })
  const server = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: service.fetch })
  try {
    await writeFile(
      join(repo, 'autobuild.toml'),
      '[tickets]\nsource = "hosted"\nteamKey = "ENG"\nreadyState = "Ready"\n',
    )
    const invoke = async (args: string[]) => {
      let text = ''
      await abTicket(args, {
        targetRepo: repo,
        env: { AB_STORE: server.url.href, AB_TOKEN: project.token },
        stdout: (line) => {
          text += line
        },
        stderr: () => {},
      })
      return JSON.parse(text)
    }
    const created = await invoke(['state', 'create', 'icebox', '--about', 'Deferred', '--json'])
    expect(created).toMatchObject({
      name: 'icebox',
      tickets: 0,
      about: 'Deferred',
      created: true,
    })
    expect(await invoke(['states', '--json'])).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'icebox', about: 'Deferred', tickets: 0 }),
      ]),
    )
    await expect(invoke(['state', 'create', 'icebox', '--json'])).rejects.toThrow('already exists')
  } finally {
    server.stop(true)
    await rm(repo, { recursive: true, force: true })
  }
})

test('file export imports Linear-style ids and states through hosted HTTP with comments, assets and blockers', async () => {
  const { mkdir, readFile } = await import('node:fs/promises')
  const root = await mkdtemp(join(tmpdir(), 'ticket-migration-http-'))
  const backend = new FakeTicketSource()
  const states = ['triage', 'ready', 'doing', 'done']
  // This HTTP test uses the existing fake create semantics; live PostgreSQL tests
  // separately assert the actual project counter transaction.
  const target = Object.assign(backend, {
    listStates: async () => states.map((name) => ({ name, tickets: 0 })),
    addState: async (name: string) => {
      if (states.includes(name)) throw new Error('duplicate state')
      states.push(name)
      return { state: { name, tickets: 0 }, created: true }
    },
  })
  const get = target.get.bind(target)
  target.get = async (id) => {
    const ticket = await get(id)
    return ticket
      ? {
          ...ticket,
          comments: target.comments
            .filter((c) => c.id === id)
            .map((c) => ({ body: c.body, createdAt: '2026-01-01T00:00:00Z' })),
        }
      : null
  }
  const secret = 'migration-http-secret'
  const project = await ticketProject(root, secret)
  const service = createHostedStoreService({
    ...project,
    env: {
      AB_STORE_SECRET: secret,
      AB_POSTGRES_URL: 'postgres://unused/injected',
      AB_BLOB_BACKEND: 's3',
      AB_S3_BUCKET: 'unused',
      AB_S3_REGION: 'unused',
      AB_S3_ACCESS_KEY_ID: 'unused',
      AB_S3_SECRET_ACCESS_KEY: 'unused',
    },
    sourceFor: () => target,
    openStore: project.openStore,
  })
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: (request) => service.fetch(request),
  })
  const localStore = new MemoryBuildStore()
  const lines: string[] = []
  const run = (args: string[]) =>
    abTicket(args, {
      targetRepo: root,
      env: { AB_TICKET_URL: server.url.href, AB_TICKET_TOKEN: project.token },
      openStore: () => localStore,
      exec: async (cmd) =>
        cmd.includes('remote')
          ? { stdout: '', stderr: '', exitCode: 1 }
          : {
              stdout: `${join(root, '.git')}\n${join(root, '.git')}\n${root}\n`,
              stderr: '',
              exitCode: 0,
            },
      stdout: (line) => lines.push(line),
      stderr: () => {},
    })
  try {
    await mkdir(join(root, 'tickets', 'In Progress'), { recursive: true })
    await mkdir(join(root, 'tickets', 'Done'), { recursive: true })
    await writeFile(
      join(root, 'tickets', 'In Progress', 'AUT-706.md'),
      '+++\nid = "AUT-706"\ntitle = "Preserved"\ntarget = "foreign"\nblockedBy = ["foreign"]\ncomments = [{ body = "exact ☃", createdAt = "2026-01-01T00:00:00Z" }]\nattachments = [{ kind = "design", name = "image", layout = "file", entries = [{ type = "file", path = "image.png", base64 = "AP8=" }] }]\n+++\nexact body\n',
    )
    await writeFile(
      join(root, 'tickets', 'Done', 'foreign.md'),
      '+++\nid = "foreign"\ntitle = "Foreign"\nkind = "node"\n+++\ndependency\n',
    )
    await writeFile(
      join(root, 'autobuild.toml'),
      '[tickets]\nsource = "file"\ndir = "tickets"\nreadyState = "ready"\n',
    )
    const dir = join(root, 'export')
    await run(['export', dir])
    await writeFile(
      join(root, 'autobuild.toml'),
      `[tickets]\nsource = "hosted"\nurl = "${server.url.href}"\nteamKey = "AUT"\nreadyState = "ready"\n`,
    )
    await run(['import', dir])
    await run(['import', dir])
    expect((await target.get('AUT-706'))?.state).toBe('in-progress')
    expect((await target.get('AUT-706'))?.blockedBy).toEqual(['AUT-707'])
    expect((await target.get('AUT-707'))?.state).toBe('done')
    expect((await target.get('AUT-707'))?.kind).toBe('node')
    expect((await target.get('AUT-706'))?.target).toBe('AUT-707')
    expect(target.comments.filter((c) => c.id === 'AUT-706')).toEqual([
      { id: 'AUT-706', body: 'exact ☃' },
    ])
    expect(JSON.parse(await readFile(join(dir, '.ab-import-map.json'), 'utf8')).tickets).toEqual({
      'AUT-706': 'AUT-706',
      foreign: 'AUT-707',
    })
    expect(lines.some((line) => line === `mapping: ${join(dir, '.ab-import-map.json')}`)).toBe(true)
    // Export the hosted tracker again: the restored bytes travel through its asset seam.
    const roundTrip = join(root, 'hosted-export')
    await run(['export', roundTrip])
    expect(await readFile(join(roundTrip, 'in-progress', 'AUT-706.md'), 'utf8')).toContain(
      'base64 = "AP8="',
    )
  } finally {
    await server.stop(true)
    await rm(root, { recursive: true, force: true })
  }
})
