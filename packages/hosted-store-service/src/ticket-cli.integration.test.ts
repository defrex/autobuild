import { expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { abTicket } from '../../core/src/cli/ticket'
import { FakeTicketSource } from '../../core/src/ports/tickets/fake'
import type { TicketSourceFactory } from '../../core/src/cli/ticket'
import { mintToken } from 'autobuild/remote-store'
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
      })
      server = Bun.serve({
        hostname: '127.0.0.1',
        port: 0,
        fetch: (request) => {
          requests.push(new URL(request.url).pathname)
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
    ]),
  )
}, 10_000)
