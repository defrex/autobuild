import { afterEach, describe, expect, test } from 'bun:test'
import { lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { PLUGIN_PORTS } from '../plugins/registry'

const DIST_ROOT = resolve(import.meta.dir, '..', '..')
const GUIDE = join(DIST_ROOT, 'skills', 'guide', 'SKILL.md')
const REFERENCE = join(DIST_ROOT, 'skills', 'guide', 'references', 'plugin-authoring.md')
const roots: string[] = []

function fencedBlock(source: string, marker: string, language: string): string {
  const start = `<!-- ${marker}:start -->\n\`\`\`${language}\n`
  const end = `\n\`\`\`\n<!-- ${marker}:end -->`
  const from = source.indexOf(start)
  const to = source.indexOf(end, from + start.length)
  expect(from, `missing ${marker} start marker`).toBeGreaterThanOrEqual(0)
  expect(to, `missing ${marker} end marker`).toBeGreaterThan(from)
  return source.slice(from + start.length, to)
}

async function run(root: string, ...args: string[]): Promise<{
  status: number
  stdout: string
  stderr: string
}> {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && !key.startsWith('AB_')) env[key] = value
  }
  const child = Bun.spawn(['bun', join(DIST_ROOT, 'bin', 'ab.ts'), ...args], {
    cwd: root,
    env,
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [stdout, stderr, status] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  return { status, stdout, stderr }
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('plugin authoring guide', () => {
  test('the main guide links a complete reference grounded in the shipped surface', async () => {
    const [guide, reference] = await Promise.all([
      readFile(GUIDE, 'utf8'),
      readFile(REFERENCE, 'utf8'),
    ])
    expect(guide).toContain('[`references/plugin-authoring.md`](references/plugin-authoring.md)')
    expect((await lstat(REFERENCE)).isFile()).toBe(true)

    const maps = ['ticketSources', 'agentRuntimes', 'workspaceProviders', 'forges']
    for (const token of [...PLUGIN_PORTS, ...maps]) expect(reference).toContain(`\`${token}\``)
    for (const field of ['config', 'env', 'repoRoot']) expect(reference).toContain(`\`${field}\``)
    for (const command of ['ab plugin list', 'ab plugin doctor', 'ab plugin test']) {
      expect(reference).toContain(command)
    }
    for (const contract of [
      'autobuild/plugin-sdk',
      'contract: { factory, live: true }',
      'AB_RUN_LIVE_PORT_CONTRACTS=1',
      'BuildStore is **not** an in-process manifest map',
      'TelemetrySource',
      '`requiredEnv`',
      'environment variables',
      'not a runtime `dependencies` entry',
      'npm pack --dry-run',
      'npm publish --access public',
      'the unchanged shared contract suite for its port passes',
    ]) {
      expect(reference).toContain(contract)
    }
    for (const selector of [
      '`[tickets].source`',
      '`[workspace].provider`',
      '`[roles.*].runtime`',
      'root `forge` key',
    ]) {
      expect(reference).toContain(selector)
    }
    expect(reference).toContain('All four manifest maps have production selectors')
  })

  test('the exact zero-network walkthrough initializes, loads, lists, and passes its contract', async () => {
    const reference = await readFile(REFERENCE, 'utf8')
    const module = fencedBlock(
      reference,
      'plugin-authoring-walkthrough-module',
      'ts',
    )
    const config = fencedBlock(
      reference,
      'plugin-authoring-walkthrough-config',
      'toml',
    )
    const root = await mkdtemp(join(tmpdir(), 'ab-plugin-guide-'))
    roots.push(root)
    await writeFile(join(root, 'autobuild-plugin.ts'), module)
    await writeFile(join(root, 'autobuild.toml'), config)
    await mkdir(join(root, 'node_modules'), { recursive: true })
    await symlink(DIST_ROOT, join(root, 'node_modules', 'autobuild'), 'dir')

    const git = Bun.spawnSync(['git', 'init', '-q'], { cwd: root })
    expect(git.exitCode).toBe(0)

    const initialized = await run(root, 'init')
    expect(initialized.status, initialized.stderr).toBe(0)
    expect(
      await readFile(
        join(root, '.agents', 'skills', 'ab-guide', 'references', 'plugin-authoring.md'),
        'utf8',
      ),
    ).toBe(reference)

    const doctor = await run(root, 'plugin', 'doctor')
    expect(doctor.status, doctor.stderr).toBe(0)
    expect(doctor.stdout).toContain('OK ./autobuild-plugin.ts')

    const list = await run(root, 'plugin', 'list')
    expect(list.status, list.stderr).toBe(0)
    expect(list.stdout).toContain('walkthrough owner=plugin:walkthrough')
    expect(list.stdout).toContain('contract=available')

    const contract = await run(root, 'plugin', 'test', 'ticket-source', 'walkthrough')
    expect(contract.status, `${contract.stdout}\n${contract.stderr}`).toBe(0)
    expect(`${contract.stdout}\n${contract.stderr}`).toContain(
      'create/get round-trips common fields',
    )
  }, 30_000)
})
