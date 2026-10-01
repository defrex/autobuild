import { expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { abTicket } from '@defrex/autobuild/testing'
import { FakeTicketSource, MemoryBuildStore } from '@defrex/autobuild/plugin-sdk'
import type { TicketSourceFactory } from '@defrex/autobuild/testing'
import { mintToken } from '@defrex/autobuild/remote-store'
import { createHostedStoreService } from './service'

interface ScenarioResult {
  output: unknown[]
  finalBody: string | undefined
  requests: string[]
}

async function runScenario(mode: 'direct' | 'hosted'): Promise<ScenarioResult> {
  const repo = await mkdtemp(join(tmpdir(), `ab-ticket-${mode}-`))
  const backend = new FakeTicketSource([
    {
      ref: { source: 'fake', id: 'B', title: 'Dependency' },
      title: 'Dependency',
      body: 'dependency body',
      state: 'Triage',
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
      const service = createHostedStoreService({
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
        openStore: async () => new MemoryBuildStore(),
      })
      server = Bun.serve({
        hostname: '127.0.0.1',
        port: 0,
        fetch: (request) => {
          // Repo and ticket ids are path segments; normalize the asset routes.
          requests.push(
            new URL(request.url).pathname.replace(
              /^\/repos\/[^/]+\/tickets\/[^/]+\/assets/,
              '/ticket-assets',
            ),
          )
          return service.fetch(request)
        },
      })
      env.AB_STORE = `http://127.0.0.1:${server.port}`
      env.AB_TOKEN = mintToken(secret, {
        operator: true,
        session: '*',
        exp: Date.now() + 60_000,
      })
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
    await invoke(['block', 'fake-1', 'B', '--json'])
    await invoke(['list', '--json'])
    await invoke(['show', 'fake-1', '--json'])
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
      ref: { source: 'fake', id: 'fake-1' },
      title: 'Asset ticket',
      body: 'body',
      state: 'Ready',
      labels: [],
    },
  ])
  const secret = 'cli-assets-secret'
  const service = createHostedStoreService({
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
    openStore: async () => new MemoryBuildStore(),
  })
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: (r) => service.fetch(r) })
  try {
    await writeFile(
      join(repo, 'autobuild.toml'),
      '[tickets]\nsource = "hosted"\nteamKey = "ENG"\nreadyState = "Ready"\nreadyLabels = []\n',
    )
    const env = {
      AB_STORE: `http://127.0.0.1:${server.port}`,
      AB_TOKEN: mintToken(secret, { operator: true, session: '*', exp: Date.now() + 60_000 }),
    }
    const run = async (argv: string[]): Promise<string> => {
      const lines: string[] = []
      await abTicket(argv, {
        targetRepo: repo,
        env,
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
    await run(['asset', 'rm', 'fake-1', 'design', 'mock.png'])
    expect(backend.comments).toHaveLength(2)
    expect(backend.comments[1]?.body).toContain('Ticket asset removed')
    expect(JSON.parse(await run(['show', 'fake-1', '--json'])).assets).toEqual([])
  } finally {
    await server.stop(true)
    await rm(repo, { recursive: true, force: true })
  }
}, 10_000)
