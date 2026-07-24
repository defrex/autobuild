import { afterEach, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Exec } from '../ports/workspace/git-worktree'
import { abPlugin, type PluginContractProcessInput } from './plugin'

const roots: string[] = []
const notGit: Exec = async () => ({ stdout: '', stderr: '', exitCode: 1 })

async function repo(modules: string[], files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'ab-plugin-cli-'))
  roots.push(root)
  await writeFile(
    join(root, 'autobuild.toml'),
    `plugins = ${JSON.stringify(modules)}\n\n[tickets]\nsource = "file"\nreadyState = "ready"\n`,
  )
  for (const [path, content] of Object.entries(files)) {
    const destination = join(root, path)
    await mkdir(join(destination, '..'), { recursive: true })
    await writeFile(destination, content)
  }
  return root
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

function output(root: string, env: Record<string, string | undefined> = {}) {
  const stdout: string[] = []
  const stderr: string[] = []
  return {
    opts: {
      targetRepo: root,
      env,
      exec: notGit,
      stdout: (line: string) => stdout.push(line),
      stderr: (line: string) => stderr.push(line),
    },
    stdout,
    stderr,
  }
}

const basic = `
const adapter = () => ({})
export default {
  name: 'acme', apiVersion: '^1.0.0',
  ticketSources: { jira: adapter },
  forges: { gitlab: adapter },
}
`

function contractPlugin(live: boolean): string {
  return `
const adapter = () => ({})
const suiteFactory = () => async () => ({})
export default {
  name: 'tested', apiVersion: '^1.1.0',
  ticketSources: {
    jira: { factory: adapter, contract: { factory: suiteFactory, live: ${live} } },
  },
}
`
}

describe('ab plugin', () => {
  test('list projects builtin and configured adapters with provenance and API status', async () => {
    const root = await repo(['./plugin.ts'], { 'plugin.ts': basic })
    const io = output(root)
    expect(await abPlugin(['list'], io.opts)).toBe(0)
    const text = io.stdout.join('\n')
    expect(text).toContain('ticket-source:')
    expect(text).toContain('file owner=builtin')
    expect(text).toContain('jira owner=plugin:acme module=./plugin.ts')
    expect(text).toContain('resolution=repo-path')
    expect(text).toContain('api=^1.0.0 host=1.1.0 compatible')
    expect(text).toContain('contract=missing')
  })

  test('doctor continues after multiple failures and retains a later success', async () => {
    const root = await repo(['./missing.ts', './throws.ts', './good.ts'], {
      'throws.ts': `throw new Error('boom')`,
      'good.ts': basic,
    })
    const io = output(root)
    expect(await abPlugin(['doctor'], io.opts)).toBe(1)
    expect(io.stderr.join('\n')).toContain('FAIL ./missing.ts')
    expect(io.stderr.join('\n')).toContain('FAIL ./throws.ts')
    expect(io.stdout.join('\n')).toContain('OK ./good.ts')
  })

  test('validates port, adapter, and missing descriptor actionably', async () => {
    const root = await repo(['./plugin.ts'], { 'plugin.ts': basic })
    const invalid = output(root)
    await expect(abPlugin(['test', 'store', 'jira'], invalid.opts)).rejects.toThrow(
      /expected one of: ticket-source, agent-runtime, workspace-provider, forge/,
    )

    const missing = output(root)
    await expect(abPlugin(['test', 'ticket-source', 'jira'], missing.opts)).rejects.toThrow(
      /ticketSources\.jira\.contract\.factory.*\{ factory, contract/,
    )
  })

  test('live contracts require opt-in before launch and child status is authoritative', async () => {
    const root = await repo(['./plugin.ts'], { 'plugin.ts': contractPlugin(true) })
    let launches = 0
    const subprocess = async (_input: PluginContractProcessInput): Promise<number> => {
      launches += 1
      return 7
    }

    const refused = output(root)
    await expect(
      abPlugin(['test', 'ticket-source', 'jira'], {
        ...refused.opts,
        subprocess,
      }),
    ).rejects.toThrow(/AB_RUN_LIVE_PORT_CONTRACTS=1/)
    expect(launches).toBe(0)

    const allowed = output(root, { AB_RUN_LIVE_PORT_CONTRACTS: '1' })
    expect(
      await abPlugin(['test', 'ticket-source', 'jira'], {
        ...allowed.opts,
        subprocess,
      }),
    ).toBe(7)
    expect(launches).toBe(1)
  })

  test('real Bun bridge exposes per-test output and preserves green/red status', async () => {
    const sdk = join(import.meta.dir, '..', 'plugin-sdk', 'index.ts')
    const source = `
import { FakeTicketSource } from ${JSON.stringify(sdk)}
const adapter = () => new FakeTicketSource()
const good = () => async () => ({
  source: new FakeTicketSource([], { createState: 'Triage', doneState: 'Done' }),
  states: { ready: 'Ready', claimed: 'Doing', completed: 'Done' },
  editableLabel: 'contract',
})
const broken = () => async () => { throw new Error('deliberately broken fixture') }
export default {
  name: 'bridge', apiVersion: '^1.1.0',
  ticketSources: {
    green: { factory: adapter, contract: { factory: good } },
    red: { factory: adapter, contract: { factory: broken } },
  },
}
`
    const root = await repo(['./plugin.ts'], { 'plugin.ts': source })
    const green = output(root)
    expect(await abPlugin(['test', 'ticket-source', 'green'], green.opts)).toBe(0)
    expect(green.stdout.concat(green.stderr).join('\n')).toContain(
      'create/get round-trips common fields',
    )

    const red = output(root)
    expect(await abPlugin(['test', 'ticket-source', 'red'], red.opts)).not.toBe(0)
    expect(red.stdout.concat(red.stderr).join('\n')).toContain('deliberately broken fixture')
  })

  test('forwards the exact contract selection and output seams to the child', async () => {
    const root = await repo(['./plugin.ts'], { 'plugin.ts': contractPlugin(false) })
    const io = output(root)
    expect(
      await abPlugin(['test', 'ticket-source', 'jira'], {
        ...io.opts,
        subprocess: async (input) => {
          expect(input.repoRoot).toBe(root)
          expect(input.port).toBe('ticket-source')
          expect(input.adapter).toBe('jira')
          input.stdout('pass: create is idempotent')
          input.stderr('fixture warning')
          return 0
        },
      }),
    ).toBe(0)
    expect(io.stdout).toContain('pass: create is idempotent')
    expect(io.stderr).toContain('fixture warning')
  })
})
