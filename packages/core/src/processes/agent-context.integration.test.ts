/** Cross-mode equality: a checkout dispatcher (local-git) and an origin-mode
 * dispatcher (GitHub Git Data API over a fake transport answering from the
 * same repository) record byte-identical agent context for one commit. */
import { afterEach, expect, test } from 'bun:test'
import { mkdir, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { gitDataTransport } from '../ports/forge/github-fixtures.test'
import { LocalGitForge } from '../ports/forge/local-git'
import type { Forge } from '../ports/types'
import { readAgentContext } from '../store/agent-context'
import { MemoryBuildStore } from '../store/memory'
import { temporaryDirectories } from '../testing/temp-directories'
import { AgentContextCapture } from './agent-context'

const directory = temporaryDirectories(afterEach)

function git(cwd: string, ...args: string[]): Uint8Array {
  const result = Bun.spawnSync(['git', ...args], { cwd, stdout: 'pipe', stderr: 'pipe' })
  if (result.exitCode !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr}`)
  return result.stdout
}

async function capture(forge: Forge) {
  const store = new MemoryBuildStore()
  await store.ensureRepo('repo')
  expect(
    await new AgentContextCapture({ store, repo: 'repo', forge }).run({ baseBranch: 'main' }),
  ).toEqual([])
  return (await store.getRepoArtifact('repo', 'agent-context'))!
}

test('checkout and origin-mode capture of one commit are byte-identical', async () => {
  const root = await directory(join(tmpdir(), 'ab-agent-context-'))
  const BOM = new Uint8Array([0xef, 0xbb, 0xbf, ...new TextEncoder().encode('# bom\n')])
  const LATIN1 = new Uint8Array([0x63, 0x61, 0x66, 0xe9, 0x0a])
  const files: Record<string, string | Uint8Array> = {
    '.agents/skills/ab-guide/SKILL.md': '# guide\n',
    '.agents/skills/ab-guide/references/bom.md': BOM,
    '.agents/skills/ab-guide/references/latin1.txt': LATIN1,
    '.agents/skills/release/SKILL.md': '# release\n',
    '.claude/skills/release/SKILL.md': '# release\n',
    'AGENTS.md': 'Rules: @docs/rules.md\n',
    'docs/rules.md': 'See @more.md\n',
    'docs/more.md': 'more\n',
    'packages/web/AGENTS.md': 'web\n',
  }
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(root, path)), { recursive: true })
    await writeFile(join(root, path), content)
  }
  await mkdir(join(root, '.claude/skills'), { recursive: true })
  await symlink('../../.agents/skills/ab-guide', join(root, '.claude/skills/ab-guide'))
  await symlink('AGENTS.md', join(root, 'CLAUDE.md'))
  git(root, 'init', '-q', '-b', 'main')
  git(root, 'add', '-A')
  git(
    root,
    '-c',
    'user.name=t',
    '-c',
    'user.email=t@example.test',
    '-c',
    'commit.gpgsign=false',
    'commit',
    '-qm',
    'context',
  )
  const head = new TextDecoder().decode(git(root, 'rev-parse', 'HEAD')).trim()

  const local = new LocalGitForge({ repoRoot: root })
  // The `od` fallback returns exact bytes for content text decoding would alter.
  const entries = await local.readTree(head)
  const oidOf = (path: string) => entries.find((entry) => entry.path === path)!.oid
  for (const [path, bytes] of [
    ['.agents/skills/ab-guide/references/bom.md', BOM],
    ['.agents/skills/ab-guide/references/latin1.txt', LATIN1],
  ] as const)
    expect(await local.readBlob(oidOf(path))).toEqual(bytes)

  const blobs = new Map<string, Uint8Array>()
  for (const entry of entries)
    if (entry.type === 'blob') blobs.set(entry.oid, git(root, 'cat-file', 'blob', entry.oid))
  const { forge: github } = gitDataTransport({ commit: head, entries, blobs })
  github.remoteBranchSha = async () => head

  const checkout = await capture(local)
  const origin = await capture(github)
  expect(origin.content).toEqual(checkout.content)
  expect(origin.meta.metadata).toEqual(checkout.meta.metadata)
  const record = (await readAgentContext({ getRepoArtifact: async () => checkout }, 'repo'))!.record
  expect(record.skills.map((skill) => skill.paths)).toEqual([
    ['.agents/skills/ab-guide', '.claude/skills/ab-guide'],
    ['.agents/skills/release', '.claude/skills/release'],
  ])
  expect(record.instructions.map((entry) => entry.paths)).toEqual([
    ['AGENTS.md', 'CLAUDE.md'],
    ['packages/web/AGENTS.md'],
  ])
  expect(record.imports.map((entry) => entry.path)).toEqual(['docs/more.md', 'docs/rules.md'])
  const references = record.skills[0]!.files
  expect(references.find((file) => file.path === 'references/bom.md')?.text).toBe(
    `${String.fromCharCode(0xfeff)}# bom\n`,
  )
  expect(references.find((file) => file.path === 'references/latin1.txt')?.base64).toBe(
    Buffer.from(LATIN1).toString('base64'),
  )
})
