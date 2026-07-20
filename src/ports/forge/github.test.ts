import { describe, expect, test } from 'bun:test'
import type { Exec, ExecResult, TempFileWriter } from './github'
import { GitHubForge, rulesetsHaveMergeGate } from './github'

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
  test('publishes HEAD to an explicit destination ref with no rewrite bypass (D1)', async () => {
    const { forge, calls } = makeForge()
    await forge.pushBranch('/ws/build-1', 'ab/fix-login')
    expect(calls).toEqual([
      {
        cmd: [
          'git',
          'push',
          '-u',
          'origin',
          'HEAD:refs/heads/ab/fix-login',
        ],
        cwd: '/ws/build-1',
      },
    ])
    const argv = calls[0]!.cmd
    for (const forbidden of ['--force', '--force-with-lease', '--rebase']) {
      expect(argv).not.toContain(forbidden)
    }
    expect(argv.at(-1)?.startsWith('+')).toBe(false)
  })

  test('a non-fast-forward exit surfaces the exact command and diagnostic', async () => {
    const { forge } = makeForge([
      {
        exitCode: 1,
        stderr: '! [rejected] HEAD -> ab/fix-login (non-fast-forward)',
      },
    ])
    const error = await forge
      .pushBranch('/ws/build-1', 'ab/fix-login')
      .then(() => null)
      .catch((e: unknown) => e as Error)
    expect(error?.message).toContain(
      'git push -u origin HEAD:refs/heads/ab/fix-login',
    )
    expect(error?.message).toContain('non-fast-forward')
    expect(error?.message).toContain('exit 1')
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

describe('rulesetsHaveMergeGate', () => {
  const pullRequestParameters = {
    required_approving_review_count: 0,
    dismiss_stale_reviews_on_push: false,
    require_code_owner_review: false,
    require_last_push_approval: false,
    required_review_thread_resolution: false,
  }

  test('known structural rules and a zero-requirement pull-request rule are not gates', () => {
    expect(
      rulesetsHaveMergeGate([
        { type: 'required_linear_history' },
        { type: 'non_fast_forward' },
        { type: 'pull_request', parameters: pullRequestParameters },
      ]),
    ).toBe(false)
  })

  test('every supported waiting-rule family is recognized as a gate', () => {
    const rules = [
      { type: 'merge_queue', parameters: {} },
      { type: 'required_signatures' },
      {
        type: 'required_status_checks',
        parameters: { required_status_checks: [{ context: 'ci' }] },
      },
      {
        type: 'required_deployments',
        parameters: { required_deployment_environments: ['production'] },
      },
      { type: 'workflows', parameters: { workflows: [{ path: 'ci.yml' }] } },
      {
        type: 'code_scanning',
        parameters: { code_scanning_tools: [{ tool: 'CodeQL' }] },
      },
      {
        type: 'pull_request',
        parameters: {
          ...pullRequestParameters,
          required_review_thread_resolution: true,
        },
      },
    ]
    expect(rulesetsHaveMergeGate(rules)).toBe(true)
  })
})

describe('GitHubForge.setAutoMerge', () => {
  const view = (
    mergeStateStatus = 'CLEAN',
    autoMergeRequest: Record<string, unknown> | null = null,
  ) => ({
    stdout: JSON.stringify({
      autoMergeRequest,
      mergeStateStatus,
      headRefOid: 'head-42',
      baseRefName: 'main',
    }),
  })
  const repo = { stdout: JSON.stringify({ nameWithOwner: 'acme/app' }) }
  const classic = (rule: Record<string, unknown> | null = null) => ({
    stdout: JSON.stringify({
      data: { repository: { ref: { branchProtectionRule: rule } } },
    }),
  })
  const classicRule = (over: Record<string, unknown> = {}) => ({
    requiresStatusChecks: false,
    requiresApprovingReviews: false,
    requiredApprovingReviewCount: 0,
    requiresCodeOwnerReviews: false,
    requireLastPushApproval: false,
    requiresConversationResolution: false,
    requiresDeployments: false,
    requiresCommitSignatures: false,
    ...over,
  })
  const noGate = [repo, classic(), { stdout: '[]' }]
  const nativeState = (enabled: boolean) => ({
    stdout: JSON.stringify({
      autoMergeRequest: enabled ? { mergeMethod: 'SQUASH' } : null,
    }),
  })

  test('CLEAN plus a real gate uses native squash auto-merge even though requirements are satisfied', async () => {
    const { forge, calls } = makeForge([
      view('CLEAN'),
      repo,
      classic(classicRule({ requiresStatusChecks: true })),
      { stdout: '[]' },
      {},
      nativeState(true),
    ])
    expect(await forge.setAutoMerge('/ws/build-1', 42, true)).toEqual({
      kind: 'applied',
    })
    expect(calls[0]).toEqual({
      cmd: [
        'gh',
        'pr',
        'view',
        '42',
        '--json',
        'autoMergeRequest,mergeStateStatus,headRefOid,baseRefName',
      ],
      cwd: '/ws/build-1',
    })
    expect(calls[1]).toEqual({
      cmd: ['gh', 'repo', 'view', '--json', 'nameWithOwner'],
      cwd: '/ws/build-1',
    })
    expect(calls[2]!.cmd.slice(0, 4)).toEqual(['gh', 'api', 'graphql', '-f'])
    expect(calls[2]!.cmd).toContain('qualifiedRef=refs/heads/main')
    expect(calls[3]).toEqual({
      cmd: ['gh', 'api', 'repos/acme/app/rules/branches/main'],
      cwd: '/ws/build-1',
    })
    expect(calls.at(-2)).toEqual({
      cmd: ['gh', 'pr', 'merge', '42', '--auto', '--squash'],
      cwd: '/ws/build-1',
    })
    expect(calls.at(-1)).toEqual({
      cmd: ['gh', 'pr', 'view', '42', '--json', 'autoMergeRequest'],
      cwd: '/ws/build-1',
    })
    expect(calls.flatMap((call) => call.cmd)).not.toContain('--admin')
  })

  test('an active inherited ruleset gate also retains native ownership', async () => {
    const rules = [
      {
        type: 'required_status_checks',
        ruleset_source_type: 'Organization',
        parameters: { required_status_checks: [{ context: 'ci' }] },
      },
    ]
    const { forge, calls } = makeForge([
      view(),
      repo,
      classic(),
      { stdout: JSON.stringify(rules) },
      {},
      nativeState(true),
    ])
    expect(await forge.setAutoMerge('/ws/build-1', 42, true)).toEqual({
      kind: 'applied',
    })
    expect(calls.at(-2)!.cmd).toEqual([
      'gh',
      'pr',
      'merge',
      '42',
      '--auto',
      '--squash',
    ])
    expect(calls.at(-1)!.cmd).toEqual([
      'gh',
      'pr',
      'view',
      '42',
      '--json',
      'autoMergeRequest',
    ])
  })

  test('CLEAN or UNSTABLE with two successful negative probes returns a guarded direct candidate', async () => {
    for (const state of ['CLEAN', 'UNSTABLE'] as const) {
      const { forge, calls } = makeForge([view(state), ...noGate])
      expect(await forge.setAutoMerge('/ws/build-1', 42, true)).toEqual({
        kind: 'ungated',
        headSha: 'head-42',
      })
      expect(calls.some((call) => call.cmd.includes('merge'))).toBe(false)
    }
  })

  test('ungated transient/conflict states defer, while an unexplained blocker fails', async () => {
    for (const state of ['UNKNOWN', 'DIRTY'] as const) {
      const { forge } = makeForge([view(state), ...noGate])
      expect(await forge.setAutoMerge('/ws/build-1', 42, true)).toEqual({
        kind: 'deferred',
      })
    }
    const blocked = makeForge([view('BLOCKED'), ...noGate])
    await expect(
      blocked.forge.setAutoMerge('/ws/build-1', 42, true),
    ).rejects.toThrow('BLOCKED')
  })

  test('HAS_HOOKS is never treated as ungated and delegates to native auto-merge', async () => {
    const { forge, calls } = makeForge([
      view('HAS_HOOKS'),
      ...noGate,
      {},
      nativeState(true),
    ])
    expect(await forge.setAutoMerge('/ws/build-1', 42, true)).toEqual({
      kind: 'applied',
    })
    expect(calls.at(-2)!.cmd).toEqual([
      'gh',
      'pr',
      'merge',
      '42',
      '--auto',
      '--squash',
    ])
    expect(calls.at(-1)!.cmd).toEqual([
      'gh',
      'pr',
      'view',
      '42',
      '--json',
      'autoMergeRequest',
    ])
  })

  test('disabling inspects only native state, so future merge-state enums cannot block cancellation', async () => {
    const { forge, calls } = makeForge([
      {
        stdout: JSON.stringify({
          autoMergeRequest: { mergeMethod: 'SQUASH' },
        }),
      },
      {},
      nativeState(false),
    ])
    expect(await forge.setAutoMerge('/ws/build-1', 42, false)).toEqual({
      kind: 'applied',
    })
    expect(calls[0]).toEqual({
      cmd: ['gh', 'pr', 'view', '42', '--json', 'autoMergeRequest'],
      cwd: '/ws/build-1',
    })
    expect(calls.at(-2)).toEqual({
      cmd: ['gh', 'pr', 'merge', '42', '--disable-auto'],
      cwd: '/ws/build-1',
    })
    expect(calls.at(-1)).toEqual({
      cmd: ['gh', 'pr', 'view', '42', '--json', 'autoMergeRequest'],
      cwd: '/ws/build-1',
    })
    expect(calls).toHaveLength(3)
  })

  test('a successful command without matching native projection stays deferred', async () => {
    const enable = makeForge([
      view(),
      repo,
      classic(classicRule({ requiresStatusChecks: true })),
      { stdout: '[]' },
      {},
      nativeState(false),
    ])
    expect(
      await enable.forge.setAutoMerge('/ws/build-1', 42, true),
    ).toEqual({ kind: 'deferred' })

    const disable = makeForge([nativeState(true), {}, nativeState(true)])
    expect(
      await disable.forge.setAutoMerge('/ws/build-1', 42, false),
    ).toEqual({ kind: 'deferred' })
  })

  test('idempotent desired state only inspects the PR', async () => {
    for (const [enabled, response] of [
      [true, view('UNKNOWN', { mergeMethod: 'SQUASH' })],
      [false, nativeState(false)],
    ] as const) {
      const { forge, calls } = makeForge([response])
      expect(await forge.setAutoMerge('/ws/build-1', 42, enabled)).toEqual({
        kind: 'applied',
      })
      expect(calls).toHaveLength(1)
    }
  })

  test('a repeated enable is acknowledged without repeating the mutation', async () => {
    const { forge, calls } = makeForge([
      view(),
      repo,
      classic(classicRule({ requiresStatusChecks: true })),
      { stdout: '[]' },
      {},
      nativeState(true),
      view('UNKNOWN', { mergeMethod: 'SQUASH' }),
    ])

    expect(await forge.setAutoMerge('/ws/build-1', 42, true)).toEqual({
      kind: 'applied',
    })
    expect(await forge.setAutoMerge('/ws/build-1', 42, true)).toEqual({
      kind: 'applied',
    })
    expect(
      calls.filter(
        (call) =>
          call.cmd.join(' ') === 'gh pr merge 42 --auto --squash',
      ),
    ).toHaveLength(1)
  })

  test('probe, inspection, and native mutation failures propagate and never return direct eligibility', async () => {
    const inspect = makeForge([{ exitCode: 1, stderr: 'not found' }])
    await expect(inspect.forge.setAutoMerge('/ws/build-1', 42, true)).rejects.toThrow(
      'gh pr view 42 --json autoMergeRequest,mergeStateStatus,headRefOid,baseRefName',
    )

    const probe = makeForge([
      view(),
      repo,
      { exitCode: 1, stderr: 'resource not accessible' },
    ])
    await expect(probe.forge.setAutoMerge('/ws/build-1', 42, true)).rejects.toThrow(
      'gh api graphql',
    )

    const mutate = makeForge([
      view(),
      repo,
      classic(classicRule({ requiresStatusChecks: true })),
      { stdout: '[]' },
      { exitCode: 1, stderr: 'permission denied' },
    ])
    await expect(mutate.forge.setAutoMerge('/ws/build-1', 42, true)).rejects.toThrow(
      'gh pr merge 42 --auto --squash',
    )
  })

  test('unknown or malformed active rules fail closed', async () => {
    const unknown = makeForge([
      view(),
      repo,
      classic(),
      { stdout: JSON.stringify([{ type: 'future_required_ai_review' }]) },
    ])
    await expect(
      unknown.forge.setAutoMerge('/ws/build-1', 42, true),
    ).rejects.toThrow('unknown active GitHub ruleset rule type')

    const malformed = makeForge([
      view(),
      repo,
      classic(),
      { stdout: JSON.stringify([{ type: 'pull_request', parameters: {} }]) },
    ])
    await expect(
      malformed.forge.setAutoMerge('/ws/build-1', 42, true),
    ).rejects.toThrow('unexpected parameters')
  })

  test('malformed or future PR state is rejected rather than guessed', async () => {
    const malformed = makeForge([{ stdout: '{}' }])
    await expect(
      malformed.forge.setAutoMerge('/ws/build-1', 42, true),
    ).rejects.toThrow('unexpected output')

    const future = makeForge([view('FUTURE_STATE')])
    await expect(future.forge.setAutoMerge('/ws/build-1', 42, true)).rejects.toThrow(
      'unexpected output',
    )
  })
})

describe('GitHubForge.squashMerge', () => {
  test('uses a head-guarded normal squash with no bypass or alternate merge mode', async () => {
    const { forge, calls } = makeForge()
    await forge.squashMerge('/ws/build-1', 42, 'head-42')
    expect(calls).toEqual([
      {
        cmd: [
          'gh',
          'pr',
          'merge',
          '42',
          '--squash',
          '--match-head-commit',
          'head-42',
        ],
        cwd: '/ws/build-1',
      },
    ])
    const argv = calls[0]!.cmd
    for (const forbidden of ['--admin', '--force', '--rebase', '--auto']) {
      expect(argv).not.toContain(forbidden)
    }
  })

  test('command failures remain visible', async () => {
    const { forge } = makeForge([{ exitCode: 1, stderr: 'head sha mismatch' }])
    await expect(
      forge.squashMerge('/ws/build-1', 42, 'stale-head'),
    ).rejects.toThrow('head sha mismatch')
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
