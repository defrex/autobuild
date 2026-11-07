import { describe, expect, test } from 'bun:test'
import { preserveGitCommits } from './commit-preservation'
import type { Exec, ExecResult } from './git-worktree'

const BASE = 'b5c44733f256ed549470d28bb41666a31cff19d8'
const MISSING = '1111111111111111111111111111111111111111'
const PRESENT = '2222222222222222222222222222222222222222'
const NOT_AN_OBJECT = (sha: string): ExecResult => ({
  stdout: '',
  stderr: `fatal: Not a valid object name ${sha}^{commit}\n`,
  exitCode: 128,
})
const ok = (stdout = ''): ExecResult => ({ stdout, stderr: '', exitCode: 0 })

/** A scripted checkout: `objects` exist; `HEAD` and the branch are unresolvable. */
function checkout(objects: string[]) {
  const calls: string[] = []
  const exec: Exec = async (cmd) => {
    const line = cmd.join(' ')
    calls.push(line)
    const [, verb, ...rest] = cmd
    if (verb === 'rev-parse' && line.includes('HEAD')) return NOT_AN_OBJECT('HEAD')
    if (verb === 'rev-parse') return { stdout: '', stderr: '', exitCode: 1 }
    if (verb === 'cat-file') {
      const sha = rest[1]!.replace('^{commit}', '')
      return objects.includes(sha) ? ok() : NOT_AN_OBJECT(sha)
    }
    if (verb === 'rev-list') return ok(rest[0] === PRESENT ? `${PRESENT}\n` : '')
    throw new Error(`unscripted ${line}`)
  }
  return { exec, calls }
}

function preserve(exec: Exec, neverExecuted?: boolean) {
  const archived: string[] = []
  const run = preserveGitCommits({
    exec,
    workspacePath: '/workspace',
    branch: 'ab/build',
    slug: 'build',
    base: BASE,
    candidates: [MISSING, PRESENT],
    archive: async ({ sha }) => {
      archived.push(sha)
    },
    neverExecuted,
  })
  return { run, archived }
}

describe('preserveGitCommits', () => {
  test('a never-executed checkout without the base preserves nothing', async () => {
    const { exec, calls } = checkout([])
    const { run, archived } = preserve(exec, true)
    expect(await run).toEqual([])
    expect(archived).toEqual([])
    expect(calls.some((line) => line.includes('rev-list'))).toBe(false)
  })

  test('a never-executed checkout skips missing heads and archives present work', async () => {
    const { exec } = checkout([BASE, PRESENT])
    const { run, archived } = preserve(exec, true)
    expect(await run).toEqual([
      {
        sha: PRESENT,
        remoteRef: `refs/autobuild/archive/build/${PRESENT}`,
        role: 'producer',
        commits: [PRESENT],
      },
    ])
    expect(archived).toEqual([PRESENT])
  })

  test('an executed checkout without the base fails safely', async () => {
    const { exec } = checkout([PRESENT])
    const strict: Exec = async (cmd, opts) =>
      cmd.join(' ').includes('HEAD') ? ok(`${PRESENT}\n`) : exec(cmd, opts)
    const { run, archived } = preserve(strict)
    await expect(run).rejects.toThrow(
      `workspace preservation git cat-file -e ${BASE}^{commit} failed`,
    )
    expect(archived).toEqual([])
  })
})
