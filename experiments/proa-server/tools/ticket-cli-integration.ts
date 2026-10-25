/** Unchanged ticket CLI parser/handlers using real hosted HTTP sources and assets. */
import { SQL } from 'bun'
import { strict as assert } from 'node:assert'
import { randomBytes } from 'node:crypto'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { abTicket } from '../../../packages/core/src/cli/ticket'
import { spawnExec } from '../../../packages/core/src/ports/workspace/git-worktree'
import { PostgresProjectRegistry } from '../../../packages/postgres-store/src/projects'
import { PostgresCredentialStore } from '../../../packages/postgres-store/src/credentials'
import { PostgresTicketPolicyStore } from '../../../packages/postgres-store/src/ticket-policy'
import { PostgresTicketSource } from '../../../packages/postgres-store/src/tickets'
import { openPostgresBuildStoreFromEnv } from '../../../packages/postgres-store/src/config'
import { createTicketServer } from '../../../packages/hosted-store-service/src/ticket-server'
import { createStoreServer } from '../../../packages/hosted-store-service/src/remote-store-server'
import {
  createMachineAuth,
  MachineAuthError,
} from '../../../packages/hosted-store-service/src/machine-auth'
import { withDataServices } from './data-services'
import { withProtocolDatabase } from './protocol-harness'
import { buildConnectServer } from './connect-integration'

const policy = {
  version: 1,
  tickets: {
    source: 'hosted',
    teamKey: 'ENG',
    readyState: 'ready',
    triageState: 'triage',
    claimedState: 'doing',
    doneState: 'done',
    createState: 'triage',
    proposalState: 'triage',
  },
} as const
const lifecycle = { triage: 'triage', ready: 'ready', doing: 'doing', done: 'done' }

/** Only transport-derived identities/timestamps/absolute output paths differ. */
export function normalizeTicketCliOutput(
  value: unknown,
  replacements: [string, string][] = [],
): unknown {
  if (typeof value === 'string')
    return replacements.reduce((text, [from, to]) => text.replaceAll(from, to), value)
  if (Array.isArray(value)) return value.map((item) => normalizeTicketCliOutput(item, replacements))
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        key === 'createdAt' ? '<timestamp>' : normalizeTicketCliOutput(item, replacements),
      ]),
    )
  return value
}

export async function ticketCliIntegration(
  admin: string,
  environment: Record<string, string | undefined>,
) {
  const executable = await buildConnectServer(environment)
  return withProtocolDatabase(admin, environment, async (env) => {
    const runtime = await mkdtemp(join(tmpdir(), 'proa-ticket-cli-'))
    const sql = new SQL(env.AB_POSTGRES_URL!, { max: 4 })
    const backing = await openPostgresBuildStoreFromEnv(env)
    const projects = new PostgresProjectRegistry(sql)
    const credentials = new PostgresCredentialStore(sql, projects)
    const policies = new PostgresTicketPolicyStore(sql)
    const secret = randomBytes(32).toString('hex')
    const repos = [
      'https://github.com/proa/ticket-cli-native',
      'https://github.com/proa/ticket-cli-typescript',
    ]
    const auth = createMachineAuth({ secret, credentials, projects, store: backing })
    const oracle = createTicketServer({
      secret,
      auth,
      policy: {
        get: (repo) => policies.get(repo),
        put: (repo, value, writer) => policies.put(repo, value, writer),
      },
      sourceFor: async (context, principal) => {
        const repo = context.repo ?? ('repo' in principal ? principal.repo : undefined)
        if (!repo || !(await projects.has(repo)))
          throw new MachineAuthError(403, 'project not registered')
        return new PostgresTicketSource(sql, { repo, teamKey: 'ENG', lifecycle }, lifecycle)
      },
    })
    const storeOracle = createStoreServer({ store: backing, secret, auth })
    const typescript = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch: (request) =>
        new URL(request.url).pathname.startsWith('/tickets/')
          ? oracle.fetch(request)
          : storeOracle.fetch(request),
    })
    const reservation = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response() })
    const nativeUrl = `http://127.0.0.1:${reservation.port!}`
    const port = reservation.port!
    reservation.stop(true)
    const actor = 'operator@example.com'
    let native: ReturnType<typeof Bun.spawn> | undefined
    let assertions = 0
    try {
      for (const repo of repos) {
        await projects.add(repo, actor)
        await backing.ensureRepo(repo)
      }
      native = Bun.spawn([executable], {
        cwd: runtime,
        env: {
          ...env,
          PROA_HOST: '127.0.0.1',
          PORT: String(port),
          PROA_AUTH_URL: nativeUrl,
          // This machine-only fixture configures GitHub auth, not development issuance.
          // Keep its unused OAuth resource HTTPS while the isolated HTTP listener is loopback.
          AB_WEB_MCP_RESOURCE: 'https://ticket-cli.example.test/mcp',
          GITHUB_CLIENT_ID: 'ticket-cli-proof',
          GITHUB_CLIENT_SECRET: randomBytes(32).toString('hex'),
          PROA_SESSION_SECRET: randomBytes(32).toString('hex'),
          AB_WEB_ALLOWED_EMAILS: actor,
          AB_STORE_SECRET: secret,
        },
        stdout: Bun.file(join(runtime, 'native.log')),
        stderr: Bun.file(join(runtime, 'native-errors.log')),
      })
      let ready = false
      for (let attempt = 0; attempt < 200; attempt++) {
        try {
          if ((await fetch(`${nativeUrl}/health`)).ok) {
            ready = true
            break
          }
        } catch {}
        if (native.exitCode !== null)
          throw Error(
            `Native ticket CLI server exited: ${await Bun.file(join(runtime, 'native-errors.log')).text()}`,
          )
        await Bun.sleep(25)
      }
      assert.ok(ready, 'normal native ticket server did not become ready')
      const sides: {
        checkout: string
        repo: string
        endpoint: string
        token: string
        cliEnv: Record<string, string | undefined>
      }[] = []
      for (let index = 0; index < 2; index++) {
        const checkout = join(runtime, index === 0 ? 'native' : 'typescript')
        const repo = repos[index]!
        const endpoint = index === 0 ? nativeUrl : typescript.url.origin
        const { token } = await credentials.issue(repo, actor)
        await mkdir(checkout)
        for (const args of [
          ['git', 'init'],
          ['git', 'remote', 'add', 'origin', repo],
        ]) {
          const result = await spawnExec(args, { cwd: checkout, env })
          assert.equal(result.exitCode, 0)
        }
        await writeFile(
          join(checkout, 'autobuild.toml'),
          `[tickets]\nsource = "hosted"\nteamKey = "ENG"\nurl = "${endpoint}"\nreadyState = "ready"\ntriageState = "triage"\nclaimedState = "doing"\ndoneState = "done"\ncreateState = "triage"\n`,
        )
        await writeFile(join(checkout, 'body.md'), '\nExact body bytes  \n')
        const asset = Buffer.from([0, 255, 10, 13, 128, 65])
        await writeFile(join(checkout, 'asset.bin'), asset)
        const cliEnv: Record<string, string | undefined> = Object.fromEntries(
          Object.entries(process.env).filter(([key]) => !key.startsWith('AB_')),
        )
        Object.assign(cliEnv, {
          AB_STORE: endpoint,
          AB_TOKEN: token,
          XDG_CONFIG_HOME: join(runtime, 'user-config'),
        })
        sides.push({ checkout, repo, endpoint, token, cliEnv })
      }
      async function run(index: number, args: string[]) {
        const side = sides[index]!
        const stdout: string[] = [],
          stderr: string[] = []
        let error: string | undefined
        try {
          await abTicket(
            args.map((arg) => arg.replaceAll('$DIR', side.checkout)),
            {
              targetRepo: side.checkout,
              env: side.cliEnv,
              exec: spawnExec,
              stdout: (line) => stdout.push(line),
              stderr: (line) => stderr.push(line),
            },
          )
        } catch (failure) {
          error = failure instanceof Error ? failure.message : String(failure)
        }
        const decode = (line: string) => {
          try {
            return JSON.parse(line) as unknown
          } catch {
            return line
          }
        }
        return normalizeTicketCliOutput(
          { stdout: stdout.map(decode), stderr, ...(error === undefined ? {} : { error }) },
          [
            [side.checkout, '<checkout>'],
            [side.repo, '<repo>'],
            [side.endpoint, '<service>'],
          ],
        ) as { stdout: unknown[]; stderr: string[]; error?: string }
      }
      async function compare(args: string[], shouldFail = false) {
        const nativeResult = await run(0, args),
          expected = await run(1, args)
        assert.deepEqual(nativeResult, expected, `ticket CLI parity: ${args.join(' ')}`)
        if (shouldFail) assert.ok(nativeResult.error, `expected refusal: ${args.join(' ')}`)
        else
          assert.equal(nativeResult.error, undefined, `unexpected CLI refusal: ${args.join(' ')}`)
        assertions++
        return nativeResult
      }
      await compare(['create', 'First', '--body', '$DIR/body.md', '--labels', 'one,two', '--json'])
      for (const repo of repos)
        assert.deepEqual(await policies.get(repo), policy, 'CLI published complete hosted policy')
      assertions += 2
      await compare(['create', 'Blocker', '--body', '$DIR/body.md', '--json'])
      await compare(['show', 'ENG-1', '--json'])
      await compare(['list', '--state', 'triage', '--json'])
      await compare(['states', '--json'])
      await compare(['move', 'ENG-1', 'ready', '--json'])
      await compare(['block', 'ENG-1', 'ENG-2', '--json'])
      await compare(['show', 'eng-1', '--json'])
      await compare(['unblock', 'ENG-1', 'ENG-2', '--json'])
      const shown = await compare(['show', 'ENG-1', '--json'])
      const revision = (shown.stdout[0] as { revision: string }).revision
      await compare([
        'update',
        'ENG-1',
        '--title',
        'Guarded',
        '--expected-revision',
        revision,
        '--json',
      ])
      await compare(
        ['update', 'ENG-1', '--title', 'Stale', '--expected-revision', revision, '--json'],
        true,
      )
      await compare(['state', 'create', 'review', '--about', 'Review before landing', '--json'])
      await compare(['attach', 'ENG-1', 'reference', '$DIR/asset.bin', '--name', 'bytes', '--json'])
      await compare(['show', 'ENG-1', '--json'])
      await compare([
        'asset',
        'get',
        'ENG-1',
        'reference',
        'bytes',
        '$DIR/downloaded.bin',
        '--json',
      ])
      for (const side of sides)
        assert.deepEqual(
          await readFile(join(side.checkout, 'downloaded.bin')),
          Buffer.from([0, 255, 10, 13, 128, 65]),
        )
      assertions += 2
      await compare(['asset', 'rm', 'ENG-1', 'reference', 'bytes', '--json'])
      await compare(['show', 'ENG-1', '--json'])
      return {
        assertions,
        cliHandlers: true,
        normalRustServer: true,
        assetByteEquality: true,
        policyPublication: true,
        checks: [
          'real CLI parser/handlers with hosted HTTP source and isolated git/config',
          'creation/show/list/states/moves/blockers/guarded success and stale refusal/state creation',
          'asset upload/list through show/download/remove with exact binary bytes',
          'equivalent independent TypeScript project; only origin/path/timestamp normalization',
        ],
      }
    } finally {
      native?.kill()
      if (native) await native.exited
      typescript.stop(true)
      await backing.close()
      await sql.close()
      await rm(runtime, { recursive: true, force: true })
    }
  })
}
if (import.meta.main) console.log(JSON.stringify(await withDataServices(ticketCliIntegration)))
