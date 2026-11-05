import { describe, expect, test } from 'bun:test'
import type { RepositoryEvent } from '../events/repository'
import { ForgeRequestDeferred } from '../ports/forge-request-context'
import {
  KERNEL_GIT_DETAIL_LIMIT,
  KernelGitUnavailable,
  kernelGitHealthReducer,
  kernelGitUnavailableDetail,
} from './kernel-git'

describe('kernelGitUnavailableDetail', () => {
  test('recognizes Bun spawn failures for a missing or unrunnable git', () => {
    expect(
      kernelGitUnavailableDetail({ error: new Error('Executable not found in $PATH: "git"') }),
    ).toBe('Executable not found in $PATH: "git"')
    expect(
      kernelGitUnavailableDetail({
        error: new Error("ENOENT: no such file or directory, posix_spawn '/tmp/abg/bin/git'"),
      }),
    ).toContain('posix_spawn')
    expect(
      kernelGitUnavailableDetail({
        error: new Error("EACCES: permission denied, posix_spawn 'git'"),
      }),
    ).toContain('EACCES')
  })

  test('recognizes shell-style exit statuses and loader failures', () => {
    expect(kernelGitUnavailableDetail({ result: { exitCode: 127, stderr: '' } })).toBe(
      'git exited with status 127',
    )
    expect(kernelGitUnavailableDetail({ result: { exitCode: 126, stderr: 'denied\n' } })).toBe(
      'denied',
    )
    expect(
      kernelGitUnavailableDetail({
        result: {
          exitCode: 1,
          stderr:
            'git: error while loading shared libraries: libpcre2-8.so.0: cannot open shared object file',
        },
      }),
    ).toContain('libpcre2-8.so.0')
    expect(
      kernelGitUnavailableDetail({
        result: { exitCode: 1, stderr: "git: /lib64/libc.so.6: version `GLIBC_2.38' not found" },
      }),
    ).toContain('GLIBC_2.38')
  })

  test('leaves ordinary Git failures and successes alone', () => {
    expect(
      kernelGitUnavailableDetail({
        result: { exitCode: 128, stderr: "fatal: couldn't find remote ref main" },
      }),
    ).toBeUndefined()
    expect(
      kernelGitUnavailableDetail({ result: { exitCode: 0, stderr: 'warning' } }),
    ).toBeUndefined()
    expect(
      kernelGitUnavailableDetail({ error: new Error('unable to access: Could not resolve host') }),
    ).toBeUndefined()
  })

  test('bounds the detail it reports', () => {
    const detail = kernelGitUnavailableDetail({
      result: { exitCode: 127, stderr: 'x'.repeat(5_000) },
    })
    expect(detail!.length).toBe(KERNEL_GIT_DETAIL_LIMIT)
  })

  test('the condition defers like any forge request deferral', () => {
    const error = new KernelGitUnavailable('git', 'missing')
    expect(error).toBeInstanceOf(ForgeRequestDeferred)
    expect(error.message).toBe('kernel Git unavailable (git): missing')
  })
})

function event(seq: number, type: RepositoryEvent['type'], payload: unknown): RepositoryEvent {
  return {
    repo: 'repo',
    seq,
    ts: `2026-11-05T00:00:0${seq}.000Z`,
    actor: { kind: 'dispatcher' },
    type,
    payload,
  } as RepositoryEvent
}

describe('kernelGitHealthReducer', () => {
  test('opens on unavailable, stamps the outage start, and clears on recovery', () => {
    const down = event(1, 'dispatcher.kernel-git-unavailable', {
      executable: 'git',
      detail: 'missing',
    })
    expect(kernelGitHealthReducer.reduce([])).toBeUndefined()
    expect(kernelGitHealthReducer.reduce([down])).toEqual({
      executable: 'git',
      detail: 'missing',
      since: '2026-11-05T00:00:01.000Z',
    })
    const up = event(2, 'dispatcher.kernel-git-recovered', { executable: 'git' })
    expect(kernelGitHealthReducer.reduce([down, up])).toBeUndefined()
    const again = event(3, 'dispatcher.kernel-git-unavailable', {
      executable: 'git',
      detail: 'loader',
    })
    expect(kernelGitHealthReducer.reduce([down, up, again])?.since).toBe('2026-11-05T00:00:03.000Z')
  })

  test('incremental advance matches a full reduction', () => {
    const events = [
      event(1, 'dispatcher.kernel-git-unavailable', { executable: 'git', detail: 'missing' }),
      event(2, 'dispatcher.kernel-git-recovered', { executable: 'git' }),
      event(3, 'dispatcher.kernel-git-unavailable', { executable: 'git', detail: 'again' }),
    ]
    let acc = kernelGitHealthReducer.initial()
    for (const one of events) acc = kernelGitHealthReducer.advance(acc, [one])
    expect(kernelGitHealthReducer.finish(acc)).toEqual(kernelGitHealthReducer.reduce(events))
  })
})
