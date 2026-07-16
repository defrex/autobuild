import { describe, expect, test } from 'bun:test'
import type { Exec, ExecResult, TempFileWriter } from './github'
import { GitHubForge } from './github'

interface ExecCall {
  cmd: string[]
  cwd: string
}

/** Scripted exec: journals every call, replies from a queue (default ok). */
function makeExec(responses: Partial<ExecResult>[] = []) {
  const calls: ExecCall[] = []
  const queue = [...responses]
  const exec: Exec = async (cmd, opts) => {
    calls.push({ cmd, cwd: opts.cwd })
    const next = queue.shift() ?? {}
    return { stdout: '', stderr: '', exitCode: 0, ...next }
  }
  return { exec, calls }
}

/** Deterministic temp-file seam: fixed paths, journals delivered bodies. */
function makeTempWriter() {
  const bodies: string[] = []
  const writer: TempFileWriter = async (content) => {
    bodies.push(content)
    return `/fake/tmp/body-${bodies.length}.md`
  }
  return { writer, bodies }
}

function makeForge(responses: Partial<ExecResult>[] = []) {
  const { exec, calls } = makeExec(responses)
  const { writer, bodies } = makeTempWriter()
  return { forge: new GitHubForge({ exec, writeTempFile: writer }), calls, bodies }
}

const PR_VIEW_JSON = JSON.stringify({
  number: 123,
  url: 'https://github.com/acme/app/pull/123',
  headRefOid: 'abc123def',
})

describe('GitHubForge.pushBranch', () => {
  test('runs exactly `git push -u origin <branch>` in the workspace (never force, D1)', async () => {
    const { forge, calls } = makeForge()
    await forge.pushBranch('/ws/build-1', 'ab/fix-login')
    expect(calls).toEqual([
      {
        cmd: ['git', 'push', '-u', 'origin', 'ab/fix-login'],
        cwd: '/ws/build-1',
      },
    ])
  })

  test('nonzero exit throws with the command and stderr', async () => {
    const { forge } = makeForge([
      { exitCode: 128, stderr: 'remote: permission denied' },
    ])
    const error = await forge
      .pushBranch('/ws/build-1', 'ab/fix-login')
      .then(() => null)
      .catch((e: unknown) => e as Error)
    expect(error?.message).toContain('git push -u origin ab/fix-login')
    expect(error?.message).toContain('remote: permission denied')
    expect(error?.message).toContain('exit 128')
  })
})

describe('GitHubForge.openPr', () => {
  const opts = {
    workspacePath: '/ws/build-1',
    head: 'ab/fix-login',
    base: 'main',
    title: 'Fix login',
    body: 'Line one\n\n"quoted" `backticks` $VARS\n',
  }

  /** First response: the idempotency probe finds no open PR for the head. */
  const NO_EXISTING = { stdout: '[]' }

  test('probes for an existing PR, creates via --body-file, then views by head branch — exact argv', async () => {
    const { forge, calls } = makeForge([NO_EXISTING, {}, { stdout: PR_VIEW_JSON }])
    await forge.openPr(opts)
    expect(calls).toEqual([
      {
        cmd: [
          'gh',
          'pr',
          'list',
          '--head',
          'ab/fix-login',
          '--state',
          'open',
          '--json',
          'number,url,headRefOid',
        ],
        cwd: '/ws/build-1',
      },
      {
        cmd: [
          'gh',
          'pr',
          'create',
          '--head',
          'ab/fix-login',
          '--base',
          'main',
          '--title',
          'Fix login',
          '--body-file',
          '/fake/tmp/body-1.md',
        ],
        cwd: '/ws/build-1',
      },
      {
        cmd: ['gh', 'pr', 'view', 'ab/fix-login', '--json', 'number,url,headRefOid'],
        cwd: '/ws/build-1',
      },
    ])
  })

  test('adopts an existing open PR for the head branch instead of creating (§8.7 crash path)', async () => {
    // A prior finalize attempt opened the PR but crashed before its
    // finalize.completed landed — the retry must adopt, not error on
    // `gh pr create`'s "a pull request already exists".
    const { forge, calls } = makeForge([{ stdout: `[${PR_VIEW_JSON}]` }])
    expect(await forge.openPr(opts)).toEqual({
      number: 123,
      url: 'https://github.com/acme/app/pull/123',
      headSha: 'abc123def',
    })
    expect(calls).toHaveLength(1)
    expect(calls[0]!.cmd).toEqual([
      'gh',
      'pr',
      'list',
      '--head',
      'ab/fix-login',
      '--state',
      'open',
      '--json',
      'number,url,headRefOid',
    ])
  })

  test('delivers the body verbatim through the temp-file seam', async () => {
    const { forge, bodies } = makeForge([NO_EXISTING, {}, { stdout: PR_VIEW_JSON }])
    await forge.openPr(opts)
    expect(bodies).toEqual(['Line one\n\n"quoted" `backticks` $VARS\n'])
  })

  test('returns the PrRef parsed from gh pr view', async () => {
    const { forge } = makeForge([NO_EXISTING, {}, { stdout: PR_VIEW_JSON }])
    expect(await forge.openPr(opts)).toEqual({
      number: 123,
      url: 'https://github.com/acme/app/pull/123',
      headSha: 'abc123def',
    })
  })

  test('create failure propagates stderr and skips the view call', async () => {
    const { forge, calls } = makeForge([
      NO_EXISTING,
      { exitCode: 1, stderr: 'a pull request already exists' },
    ])
    const error = await forge
      .openPr(opts)
      .then(() => null)
      .catch((e: unknown) => e as Error)
    expect(error?.message).toContain('gh pr create')
    expect(error?.message).toContain('a pull request already exists')
    expect(calls).toHaveLength(2)
  })

  test('malformed view JSON throws with the command in the message', async () => {
    const { forge } = makeForge([NO_EXISTING, {}, { stdout: 'not json' }])
    await expect(forge.openPr(opts)).rejects.toThrow(
      'gh pr view ab/fix-login --json number,url,headRefOid',
    )
  })

  test('a malformed probe result throws rather than blindly creating', async () => {
    const { forge } = makeForge([{ stdout: 'not json' }])
    await expect(forge.openPr(opts)).rejects.toThrow(
      'gh pr list --head ab/fix-login --state open --json number,url,headRefOid',
    )
  })
})

describe('GitHubForge.getPrState', () => {
  const stateJson = (
    state: string,
    mergeable = 'UNKNOWN',
    mergeCommit: { oid: string } | null = null,
  ) => JSON.stringify({ state, mergeable, mergeCommit })

  test('polls with exact argv', async () => {
    const { forge, calls } = makeForge([{ stdout: stateJson('CLOSED') }])
    await forge.getPrState('/ws/build-1', 42)
    expect(calls).toEqual([
      {
        cmd: ['gh', 'pr', 'view', '42', '--json', 'state,mergeable,mergeCommit'],
        cwd: '/ws/build-1',
      },
    ])
  })

  test('OPEN + MERGEABLE → open with mergeable true', async () => {
    const { forge } = makeForge([{ stdout: stateJson('OPEN', 'MERGEABLE') }])
    expect(await forge.getPrState('/ws/build-1', 42)).toEqual({
      state: 'open',
      mergeable: true,
    })
  })

  test('OPEN + CONFLICTING → open with mergeable false (janitor emits pr.conflicted, §15.7)', async () => {
    const { forge } = makeForge([{ stdout: stateJson('OPEN', 'CONFLICTING') }])
    expect(await forge.getPrState('/ws/build-1', 42)).toEqual({
      state: 'open',
      mergeable: false,
    })
  })

  test('OPEN + UNKNOWN → open with mergeable null', async () => {
    const { forge } = makeForge([{ stdout: stateJson('OPEN', 'UNKNOWN') }])
    expect(await forge.getPrState('/ws/build-1', 42)).toEqual({
      state: 'open',
      mergeable: null,
    })
  })

  test('MERGED → merged with the merge-commit sha', async () => {
    const { forge } = makeForge([
      { stdout: stateJson('MERGED', 'UNKNOWN', { oid: 'squash-sha-99' }) },
    ])
    expect(await forge.getPrState('/ws/build-1', 42)).toEqual({
      state: 'merged',
      sha: 'squash-sha-99',
    })
  })

  test('MERGED without a mergeCommit throws', async () => {
    const { forge } = makeForge([{ stdout: stateJson('MERGED') }])
    await expect(forge.getPrState('/ws/build-1', 42)).rejects.toThrow(
      'merged with no mergeCommit',
    )
  })

  test('CLOSED → closed', async () => {
    const { forge } = makeForge([{ stdout: stateJson('CLOSED') }])
    expect(await forge.getPrState('/ws/build-1', 42)).toEqual({
      state: 'closed',
    })
  })

  test('nonzero exit throws with the command and stderr', async () => {
    const { forge } = makeForge([
      { exitCode: 1, stderr: 'no pull requests found' },
    ])
    const error = await forge
      .getPrState('/ws/build-1', 42)
      .then(() => null)
      .catch((e: unknown) => e as Error)
    expect(error?.message).toContain('gh pr view 42')
    expect(error?.message).toContain('no pull requests found')
  })

  test('an unexpected state value throws rather than misreporting', async () => {
    const { forge } = makeForge([{ stdout: stateJson('DRAFT') }])
    await expect(forge.getPrState('/ws/build-1', 42)).rejects.toThrow(
      'unexpected output',
    )
  })
})

describe('GitHubForge.commentOnPr', () => {
  test('comments via --body-file with exact argv and delivers the body', async () => {
    const { forge, calls, bodies } = makeForge()
    await forge.commentOnPr('/ws/build-1', 42, '## Summary\n\nverdicts…\n')
    expect(calls).toEqual([
      {
        cmd: ['gh', 'pr', 'comment', '42', '--body-file', '/fake/tmp/body-1.md'],
        cwd: '/ws/build-1',
      },
    ])
    expect(bodies).toEqual(['## Summary\n\nverdicts…\n'])
  })

  test('nonzero exit throws with the command and stderr', async () => {
    const { forge } = makeForge([{ exitCode: 1, stderr: 'not found' }])
    const error = await forge
      .commentOnPr('/ws/build-1', 42, 'body')
      .then(() => null)
      .catch((e: unknown) => e as Error)
    expect(error?.message).toContain('gh pr comment 42')
    expect(error?.message).toContain('not found')
  })
})
