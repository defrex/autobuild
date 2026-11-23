import { describe, expect, test } from 'bun:test'
import { preserveGitCommits, restoreGitCommits } from './commit-preservation'
import { ArchiveConflictError, ForgeFailure } from '../forge-failure'
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

describe('preserveGitCommits store fallback', () => {
  const refused = new Error('push declined: refs/autobuild/archive is not permitted')
  function run(input: {
    archive: (sha: string) => Promise<void>
    retain?: (sha: string, base: string) => Promise<string>
  }) {
    const { exec: scripted } = checkout([BASE, PRESENT])
    const exec: Exec = async (cmd, opts) =>
      cmd.join(' ').includes('HEAD') ? ok(`${PRESENT}\n`) : scripted(cmd, opts)
    const retained: string[] = []
    return {
      retained,
      run: preserveGitCommits({
        exec,
        workspacePath: '/workspace',
        branch: 'ab/build',
        slug: 'build',
        base: BASE,
        candidates: [PRESENT],
        archive: ({ sha }) => input.archive(sha),
        ...(input.retain
          ? {
              retain: ({ sha, base }) => {
                retained.push(sha)
                return input.retain!(sha, base)
              },
            }
          : {}),
      }),
    }
  }

  test('a refused archive records the store copy and its actual base', async () => {
    const saved = '3333333333333333333333333333333333333333'
    const { run: preserved, retained } = run({
      archive: async () => {
        throw refused
      },
      retain: async (_sha, base) => {
        expect(base).toBe(BASE)
        return saved
      },
    })
    expect(await preserved).toEqual([
      { sha: PRESENT, role: 'producer', commits: [PRESENT], storeBase: saved },
    ])
    expect(retained).toEqual([PRESENT])
  })

  test('refusing both the archive and the store copy refuses preservation', async () => {
    const { run: preserved } = run({
      archive: async () => {
        throw refused
      },
      retain: async () => {
        throw new Error('store unavailable')
      },
    })
    await expect(preserved).rejects.toThrow(/archive refused.*BuildStore copy failed/)
  })

  test('integrity and transient failures never fall back', async () => {
    for (const failure of [
      new ArchiveConflictError('archive names another commit'),
      new ForgeFailure('timeout', { kind: 'transient', retry: 'retryable' }),
    ]) {
      const { run: preserved, retained } = run({
        archive: async () => {
          throw failure
        },
        retain: async () => BASE,
      })
      await expect(preserved).rejects.toBe(failure)
      expect(retained).toEqual([])
    }
  })

  test('without a retain callback a refusal stays strict', async () => {
    const { run: preserved } = run({
      archive: async () => {
        throw refused
      },
    })
    await expect(preserved).rejects.toBe(refused)
  })
})

describe('restoreGitCommits store heads', () => {
  const head = {
    sha: PRESENT,
    role: 'producer' as const,
    commits: [PRESENT],
    storeBase: BASE,
  }
  function workspace(objects: string[]) {
    const calls: string[] = []
    const exec: Exec = async (cmd) => {
      const line = cmd.join(' ')
      calls.push(line)
      if (cmd[1] === 'cat-file') {
        const sha = cmd[3]!.replace('^{commit}', '')
        return objects.includes(sha) ? ok() : NOT_AN_OBJECT(sha)
      }
      throw new Error(`unscripted ${line}`)
    }
    return { exec, calls, objects }
  }

  test('restores an absent store head through the callback, without the forge', async () => {
    const w = workspace([])
    const asked: string[] = []
    await restoreGitCommits({
      exec: w.exec,
      workspacePath: '/workspace',
      branch: 'ab/build',
      heads: [head],
      restoreStored: async (sha) => {
        asked.push(sha)
        w.objects.push(sha)
        return true
      },
    })
    expect(asked).toEqual([PRESENT])
    expect(w.calls.some((line) => line.includes('fetch') || line.includes('ls-remote'))).toBe(false)
  })

  test('fails clearly when the copy is unavailable or no callback is given', async () => {
    for (const restoreStored of [async () => false, undefined]) {
      const w = workspace([])
      await expect(
        restoreGitCommits({
          exec: w.exec,
          workspacePath: '/workspace',
          branch: 'ab/build',
          heads: [head],
          ...(restoreStored ? { restoreStored } : {}),
        }),
      ).rejects.toThrow(`workspace restoration store copy for ${PRESENT} is unavailable`)
    }
  })

  test('a present store head needs no callback', async () => {
    const w = workspace([PRESENT])
    await restoreGitCommits({
      exec: w.exec,
      workspacePath: '/workspace',
      branch: 'ab/build',
      heads: [head],
    })
    expect(w.calls).toEqual([
      `git cat-file -e ${PRESENT}^{commit}`,
      `git cat-file -e ${PRESENT}^{commit}`,
      `git cat-file -e ${PRESENT}^{commit}`,
    ])
  })
})
