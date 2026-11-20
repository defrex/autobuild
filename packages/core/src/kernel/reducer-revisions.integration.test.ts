import { afterEach, describe, expect, test } from 'bun:test'
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { temporaryDirectories } from '../testing/temp-directories'
import {
  appendRevision,
  checkIdentityRecords,
  deriveReducerVersion,
  parseRecordFile,
  renderRecordFile,
  type CurrentIdentity,
} from './reducer-identity'

const temporary = temporaryDirectories(afterEach)
const sha256 = (text: string) => new Bun.CryptoHasher('sha256').update(text).digest('hex')
const ROOT = new URL('../../../../', import.meta.url).pathname
const LEDGER = 'packages/core/src/kernel/reducer-revisions.ts'
const RECORDS = 'packages/core/src/kernel/__snapshots__/reducer-identity-records'
const ARCHIVE = 'packages/core/src/kernel/__snapshots__/reducer-identity-corpora'

function git(cwd: string, ...args: string[]): { code: number; stdout: string } {
  const result = Bun.spawnSync(
    [
      'git',
      '-c',
      'user.name=test',
      '-c',
      'user.email=test@example.com',
      '-c',
      'commit.gpgsign=false',
      ...args,
    ],
    { cwd, stdout: 'pipe', stderr: 'pipe', env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1' } },
  )
  return { code: result.exitCode, stdout: result.stdout.toString().trim() }
}
function ok(cwd: string, ...args: string[]): string {
  const result = git(cwd, ...args)
  if (result.code !== 0) throw new Error(`git ${args.join(' ')} exited ${result.code}`)
  return result.stdout
}
async function put(repo: string, path: string, content: string | Uint8Array): Promise<void> {
  await mkdir(dirname(join(repo, path)), { recursive: true })
  await writeFile(join(repo, path), content)
}
/** The ledger object a source declares: one `'key': 'value',` line per entry. */
function ledgerOf(source: string): Record<string, string> {
  return Object.fromEntries(
    [...source.matchAll(/^ {2}'?([^':]+)'?: '([^']*)',$/gm)].map((m) => [m[1]!, m[2]!]),
  )
}
/** Sixty corpora with one shared digest: records that differ in a single
 * entry are near-identical files, the case git's rename detection pairs up. */
const MANY = Object.fromEntries(
  Array.from({ length: 60 }, (_, index) => [`c${String(index).padStart(2, '0')}`, 'd']),
)
async function writeRecord(
  repo: string,
  revisions: string[],
  entries: Record<string, string>,
): Promise<string> {
  const rendered = renderRecordFile(
    [{ name: 'build', identity: 'build', revisions, entries }],
    sha256,
  )
  await put(repo, `${RECORDS}/${rendered.file}`, rendered.content)
  return rendered.file
}
async function readRecords(repo: string) {
  const files = await readdir(join(repo, RECORDS))
  return (
    await Promise.all(
      files.map(async (file) =>
        parseRecordFile(file, await readFile(join(repo, RECORDS, file), 'utf8'), sha256),
      ),
    )
  ).flat()
}

/** A repository with this checkout's attributes and ledger and one base record. */
async function baseRepository() {
  const repo = await temporary(join(tmpdir(), 'reducer-revisions-'))
  ok(repo, 'init', '-q', '-b', 'main')
  await put(repo, '.gitattributes', await readFile(join(ROOT, '.gitattributes'), 'utf8'))
  const ledger = await readFile(join(ROOT, LEDGER), 'utf8')
  await put(repo, LEDGER, ledger)
  await writeRecord(repo, [], MANY)
  await put(repo, `${ARCHIVE}/c00.json.gz`, Bun.gzipSync('[]'))
  ok(repo, 'add', '-A')
  ok(repo, 'commit', '-q', '-m', 'base')
  return { repo, ledger, base: ok(repo, 'rev-parse', 'HEAD') }
}
/** Branch `name` from `base`, apply `change`, commit, and return the commit. */
async function branch(
  repo: string,
  base: string,
  name: string,
  change: () => Promise<void>,
): Promise<string> {
  ok(repo, 'checkout', '-q', '-b', name, base)
  await change()
  ok(repo, 'add', '-A')
  ok(repo, 'commit', '-q', '-m', name)
  return ok(repo, 'rev-parse', 'HEAD')
}
/** Replay `commit` onto `onto` as the kernel's restacks do, and merge both sides
 * without a worktree as head-path recording does; both must be clean. */
function combineCleanly(repo: string, base: string, onto: string, commit: string): void {
  ok(repo, 'checkout', '-q', '--detach', onto)
  expect(git(repo, 'cherry-pick', commit).code).toBe(0)
  expect(ok(repo, 'diff', '--name-only', '--diff-filter=U')).toBe('')
  expect(git(repo, 'merge-tree', '--write-tree', `--merge-base=${base}`, onto, commit).code).toBe(0)
}

describe('reducer revisions across real git combinations', () => {
  test('two branches revising the same reducer combine without conflicts into N+2', async () => {
    const { repo, ledger, base } = await baseRepository()
    const revise = (key: string, id: string, digest: string) => async () => {
      await put(
        repo,
        LEDGER,
        appendRevision(ledger, { identity: 'build', kind: 'shape', reason: `AUT-0 ${id}`, id }),
      )
      await writeRecord(repo, [key], { ...MANY, c00: digest })
    }
    const a = 'build/shape/aaaaaaaaaa'
    const b = 'build/shape/bbbbbbbbbb'
    const commitA = await branch(repo, base, 'a', revise(a, 'aaaaaaaaaa', 'dA'))
    const commitB = await branch(repo, base, 'b', revise(b, 'bbbbbbbbbb', 'dB'))
    combineCleanly(repo, base, commitA, commitB)
    const merged = ledgerOf(await readFile(join(repo, LEDGER), 'utf8'))
    expect(Object.keys(merged)).toEqual(expect.arrayContaining([a, b]))
    const original = deriveReducerVersion({ identity: 'build', ledger: ledgerOf(ledger) })
    expect(deriveReducerVersion({ identity: 'build', ledger: merged })).toBe(original + 2)
    const current: CurrentIdentity = {
      name: 'build',
      identity: 'build',
      revisions: [a, b],
      digests: { ...MANY, c00: 'dAB' },
    }
    const result = checkIdentityRecords({
      current: [current],
      currentCids: Object.keys(MANY),
      records: await readRecords(repo),
      hash: sha256,
    })
    expect(result.violations).toEqual([])
    expect(result.unregeneratedCombinations.map((entry) => entry.name)).toEqual(['build'])
  })

  test('two branches adding corpora under an unchanged identity combine cleanly', async () => {
    const { repo, base } = await baseRepository()
    const addCorpus = (cid: string, digest: string) => async () => {
      await writeRecord(repo, [], { [cid]: digest })
      await put(repo, `${ARCHIVE}/${cid}.json.gz`, Bun.gzipSync(`[${JSON.stringify(cid)}]`))
    }
    const commitC = await branch(repo, base, 'c', addCorpus('n1', 'd1'))
    const commitD = await branch(repo, base, 'd', addCorpus('n2', 'd2'))
    combineCleanly(repo, base, commitC, commitD)
    const result = checkIdentityRecords({
      current: [
        {
          name: 'build',
          identity: 'build',
          revisions: [],
          digests: { ...MANY, n1: 'd1', n2: 'd2' },
        },
      ],
      currentCids: [...Object.keys(MANY), 'n1', 'n2'],
      records: await readRecords(repo),
      hash: sha256,
    })
    expect(result).toEqual({ violations: [], unregeneratedCombinations: [] })
  })

  test('the registry test pins no numeric reducer versions', async () => {
    const source = await readFile(
      join(ROOT, 'packages/core/src/kernel/reducer-registry.integration.test.ts'),
      'utf8',
    )
    expect(source).not.toContain("test('published versions'")
    expect(source).not.toMatch(/"buildReadFacts": \d+/)
  })
})
