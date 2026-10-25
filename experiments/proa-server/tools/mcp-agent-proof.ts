/** Explicit, paid, one-shot external operator proof. Never invoked by verify.ts. */
import { strict as assert } from 'node:assert'
import { createHash, randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { chmod, mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { PostgresTicketPolicyStore } from '../../../packages/postgres-store/src/ticket-policy'
import { validateEventWrite } from '../../../packages/core/src/events/catalog'
import { parseConfig } from '../../../packages/core/src/config/load'
import { reduceBuild } from '../../../packages/core/src/kernel/reducer'
import { replayControlScenario, controlScenarios } from './control-fixtures'
import { withMcpServer, oauthFlow } from './mcp-integration'
import { mcpRepo, mcpCorpusPath } from './mcp-fixtures'

export function proofEnvironment(source: NodeJS.ProcessEnv) {
  const safe = new Set([
    'PATH',
    'HOME',
    'USER',
    'LOGNAME',
    'SHELL',
    'LANG',
    'LC_ALL',
    'LC_CTYPE',
    'TZ',
    'TMPDIR',
    'XDG_CONFIG_HOME',
    'XDG_CACHE_HOME',
    'XDG_DATA_HOME',
    'XDG_RUNTIME_DIR',
    'DBUS_SESSION_BUS_ADDRESS',
    'HTTP_PROXY',
    'HTTPS_PROXY',
    'ALL_PROXY',
    'NO_PROXY',
    'http_proxy',
    'https_proxy',
    'all_proxy',
    'no_proxy',
    'CLAUDE_CONFIG_DIR',
    'CLAUDE_CODE_OAUTH_TOKEN',
    'CLAUDECODE',
  ])
  return Object.fromEntries(
    Object.entries(source).filter(([key]) => safe.has(key) || key.startsWith('ANTHROPIC_')),
  )
}
export function proofArguments(config: string) {
  return [
    'claude',
    '-p',
    '--verbose',
    '--output-format',
    'stream-json',
    '--no-session-persistence',
    '--strict-mcp-config',
    '--mcp-config',
    config,
    '--tools',
    '',
    '--allowedTools',
    'mcp__proa__*',
    '--permission-mode',
    'dontAsk',
    '--setting-sources',
    '',
  ]
}
export function redact(value: unknown, secrets: readonly string[] = []): unknown {
  if (typeof value === 'string') {
    let text = value.replace(/Bearer\s+[^\s"\\]+/gi, 'Bearer [REDACTED]')
    for (const secret of secrets) if (secret) text = text.replaceAll(secret, '[REDACTED]')
    return text
  }
  if (Array.isArray(value)) return value.map((v) => redact(v, secrets))
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        /^(authorization|cookie|set-cookie|access_token|refresh_token|id_token|code_verifier|consent_code|client_secret)$/i.test(
          key,
        )
          ? '[REDACTED]'
          : redact(item, secrets),
      ]),
    )
  return value
}
type Event = {
  type?: string
  subtype?: string
  tools?: string[]
  message?: {
    content?: {
      type: string
      id?: string
      name?: string
      input?: unknown
      tool_use_id?: string
      is_error?: boolean
      content?: unknown
    }[]
  }
  is_error?: boolean
  result?: string
  permission_denials?: unknown[]
}
export function transcriptCalls(events: Event[]) {
  const inventory = events.find((e) => e.type === 'system' && e.subtype === 'init')?.tools ?? []
  assert.ok(inventory.length, 'missing effective tool inventory')
  assert.ok(
    inventory.every((t) => t.startsWith('mcp__proa__')),
    'unexpected child tools',
  )
  const advertised = (
    JSON.parse(readFileSync(mcpCorpusPath, 'utf8')) as { tools: { name: string }[] }
  ).tools.map((t) => t.name)
  assert.ok(
    inventory.every((tool) =>
      advertised.some(
        (name) =>
          tool === `mcp__proa__${name}` || tool === `mcp__proa__${name.replaceAll('.', '_')}`,
      ),
    ),
    'unexpected Proa integration',
  )
  assert.ok(
    events.every((event) => !event.permission_denials?.length),
    'agent encountered a permission denial',
  )
  const calls = events.flatMap((e) => e.message?.content ?? []).filter((c) => c.type === 'tool_use')
  const results = events
    .flatMap((e) => e.message?.content ?? [])
    .filter((c) => c.type === 'tool_result')
  const mapping: Record<string, string> = {}
  for (const name of ['builds.list', 'builds.get', 'builds.answer', 'tickets.create']) {
    const advertised = inventory.find(
      (t) => t === `mcp__proa__${name}` || t === `mcp__proa__${name.replaceAll('.', '_')}`,
    )
    assert.ok(advertised, `missing ${name}`)
    mapping[name] = advertised
    const call = calls.find(
      (c) =>
        c.name === advertised &&
        results.some(
          (r) =>
            r.tool_use_id === c.id &&
            !r.is_error &&
            !JSON.stringify(r.content).includes('"isError":true'),
        ),
    )
    assert.ok(call, `missing successful real ${name} call`)
  }
  assert.ok(
    events.some((e) => e.type === 'result' && e.subtype === 'success' && !e.is_error),
    'agent did not complete',
  )
  return { inventory, mapping, calls, results }
}
export async function runBoundedAgent(
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
  prompt: string,
  timeoutMs = 300000,
) {
  const child = Bun.spawn(args, { cwd, env, stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' })
  let timedOut = false
  let force: ReturnType<typeof setTimeout> | undefined
  const timer = setTimeout(() => {
    timedOut = true
    child.kill('SIGTERM')
    force = setTimeout(() => child.kill('SIGKILL'), 1000)
  }, timeoutMs)
  try {
    child.stdin.write(prompt)
    await child.stdin.end()
    const [stdout, stderr, exit] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ])
    return { stdout, stderr, exit, timedOut }
  } finally {
    clearTimeout(timer)
    clearTimeout(force)
    if (child.exitCode === null) {
      child.kill('SIGKILL')
      await child.exited
    }
  }
}
export async function agentProof() {
  const output = resolve('.ab/implement/mcp-agent-proof')
  await mkdir(output, { recursive: true })
  const started = Date.now()
  const report: Record<string, unknown> = {
    passed: false,
    started: new Date(started).toISOString(),
  }
  const secrets: string[] = []
  try {
    await withMcpServer(async (server) => {
      const seed = await replayControlScenario(
        controlScenarios().find((s) => s.id === 'answer-guidance-blocked')!,
      )
      const slug = 'agent-proof-blocked'
      const rename = (v: unknown): unknown =>
        typeof v === 'string'
          ? v.replaceAll('acme/widgets', mcpRepo).replaceAll('control-build', slug)
          : Array.isArray(v)
            ? v.map(rename)
            : v && typeof v === 'object'
              ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, rename(x)]))
              : v
      const events = rename(seed.seed.events) as typeof seed.seed.events
      await server.store.createBuild({
        slug,
        repo: mcpRepo,
        created: validateEventWrite(events[0]!) as never,
      })
      for (const event of events.slice(1))
        await server.store.append(slug, validateEventWrite(event))
      const { verify, finalize, ...root } = parseConfig(
        '[tickets]\nsource = "hosted"\nteamKey = "PROOF"\nreadyState = "Ready"\n[verify]\nsteps = []\n[finalize]\nsteps = []',
      )
      await server.store.ensureRepo(mcpRepo)
      await server.store.appendRepoWithArtifacts(
        mcpRepo,
        [
          {
            kind: 'dispatcher-effective-config',
            content: JSON.stringify({
              ...root,
              verify: { steps: verify.steps },
              finalize: { steps: finalize.steps },
            }),
          },
        ],
        ([artifact]) => ({
          actor: { kind: 'dispatcher' },
          type: 'dispatcher.run-started',
          payload: {
            run: 'agent-proof',
            pid: process.pid,
            roleWarnings: [],
            effectiveConfig: { kind: artifact!.kind, rev: artifact!.revision },
          },
        }),
      )
      await new PostgresTicketPolicyStore(server.sql).put(
        mcpRepo,
        {
          version: 1,
          tickets: {
            source: 'hosted',
            teamKey: 'PROOF',
            triageState: 'Triage',
            readyState: 'Ready',
            claimedState: 'Doing',
            doneState: 'Done',
            createState: 'Triage',
            proposalState: 'Triage',
          },
        },
        'proof-driver',
      )
      const cookie = await server.session()
      secrets.push(cookie)
      const flow = await oauthFlow(server.origin, cookie, 'proa-agent-proof')
      assert.ok(!flow.denied)
      secrets.push(
        flow.tokens.access_token,
        flow.tokens.refresh_token ?? '',
        flow.tokens.id_token ?? '',
        flow.code,
        flow.codeVerifier,
      )
      const directory = await mkdtemp(join(tmpdir(), 'proa-agent-private-'))
      await chmod(directory, 0o700)
      const config = join(directory, 'mcp.json')
      const nonce = randomBytes(12).toString('hex')
      const skill = await Bun.file(resolve('.agents/skills/ab-operate/SKILL.md')).text()
      const reference = await Bun.file(
        resolve('.agents/skills/ab-guide/references/operator-api.md'),
      ).text()
      const prompt = `You are an external MCP-only Autobuild operator in an isolated verification deployment. Follow the installed skill below. This test's raw MCP tools take an explicit repo, obtained from repositories.list. No shell or file tools are available. Discover repositories, list builds, read ${slug}, answer its open escalation esc-control with guidance exactly ${nonce}, and file exactly one work ticket titled "Agent proof ${nonce}" with body "MCP agent proof ${nonce}". Read back the answer and ticket, then stop. Do not dispatch, monitor indefinitely, or land work.\n\n${skill}\n\n${reference}`
      const args = proofArguments(config)
      report.cliVersion = Bun.spawnSync(['claude', '--version']).stdout.toString().trim()
      report.arguments = proofArguments('<private-config-path>')
      report.config = {
        mcpServers: {
          proa: {
            type: 'http',
            url: `${server.origin}/mcp`,
            headers: { Authorization: 'Bearer [REDACTED]' },
          },
        },
      }
      report.skillSha256 = createHash('sha256').update(skill).digest('hex')
      report.prompt = prompt
      try {
        await Bun.write(
          config,
          JSON.stringify({
            mcpServers: {
              proa: {
                type: 'http',
                url: `${server.origin}/mcp`,
                headers: {
                  Authorization: `Bearer ${flow.tokens.access_token}`,
                },
              },
            },
          }),
        )
        await chmod(config, 0o600)
        const { stdout, stderr, exit, timedOut } = await runBoundedAgent(
          args,
          directory,
          proofEnvironment(process.env),
          prompt,
        )
        report.timedOut = timedOut
        assert.ok(!timedOut, 'Claude child timed out')
        const transcript = stdout
          .split('\n')
          .filter(Boolean)
          .map((line) => {
            try {
              return JSON.parse(line) as Event
            } catch {
              return { type: 'unparsed', result: line }
            }
          })
        await Bun.write(
          join(output, 'transcript.json'),
          JSON.stringify(redact(transcript, secrets), null, 2),
        )
        report.exitStatus = exit
        report.stderr = redact(stderr, secrets)
        assert.equal(exit, 0, 'Claude process failed')
        const calls = transcriptCalls(transcript)
        Object.assign(report, calls)
        const after = await server.store.getEvents(slug)
        after.forEach(validateEventWrite)
        reduceBuild(after)
        const answered = after.filter((e) => e.type === 'escalation.answered')
        assert.equal(answered.length, 1)
        assert.ok(JSON.stringify(answered[0]!.payload).includes(nonce))
        assert.deepEqual(answered[0]!.actor, {
          kind: 'human',
          user: 'operator@example.com',
          via: { kind: 'mcp', client: 'proa-agent-proof' },
        })
        const tickets = await server.sql`SELECT * FROM ab_tickets WHERE repo=${mcpRepo}`
        assert.equal(
          tickets.filter((t: { title: string }) => t.title === `Agent proof ${nonce}`).length,
          1,
        )
        report.readback = {
          answer: answered[0],
          ticket: tickets.find((t: { title: string }) => t.title === `Agent proof ${nonce}`),
        }
        report.passed = true
      } finally {
        await rm(directory, { recursive: true, force: true })
      }
    })
  } catch (error) {
    report.error = error instanceof Error ? error.message : String(error)
  } finally {
    report.durationMs = Date.now() - started
    await Bun.write(join(output, 'report.json'), JSON.stringify(redact(report, secrets), null, 2))
  }
  assert.equal(
    report.passed,
    true,
    `External agent proof failed; see ${join(output, 'report.json')}`,
  )
  return report
}
if (import.meta.main) {
  await agentProof()
  console.log('External agent proof passed; sanitized evidence: .ab/implement/mcp-agent-proof')
}
