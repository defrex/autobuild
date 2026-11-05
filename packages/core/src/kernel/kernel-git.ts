import type { RepositoryEvent, RepositoryEventPayload } from '../events/repository'
import { ForgeRequestDeferred } from '../ports/forge-request-context'
import { defineReducer } from './incremental'

/** Longest detail a `dispatcher.kernel-git-unavailable` event carries. */
export const KERNEL_GIT_DETAIL_LIMIT = 1_000

/** The dispatcher could not run Git for kernel-side node work (snapshot,
 * restack, presence, landing). It is a repository condition, not a node
 * failure: callers that already treat `ForgeRequestDeferred` as "retry next
 * tick" defer the node without recording a failed janitor attempt. */
export class KernelGitUnavailable extends ForgeRequestDeferred {
  constructor(
    readonly executable: string,
    readonly detail: string,
  ) {
    super(`kernel Git unavailable (${executable}): ${detail}`)
    this.name = 'KernelGitUnavailable'
  }
}

/** Why Git itself could not run, or `undefined` for an ordinary Git failure
 * (a bad ref, a network error, a non-zero exit from a working Git). Both Bun's
 * spawn errors and loader failures of a shipped Git are recognized; the forge's
 * credentialed exec re-wraps errors, so only the message is inspected. */
export function kernelGitUnavailableDetail(input: {
  error?: unknown
  result?: { exitCode: number; stderr: string }
}): string | undefined {
  if (input.error !== undefined) {
    const message = input.error instanceof Error ? input.error.message : String(input.error)
    if (
      /Executable not found in \$PATH/.test(message) ||
      (/\b(?:ENOENT|EACCES)\b/.test(message) && /posix_spawn|spawn/.test(message)) ||
      loaderFailure(message)
    )
      return bounded(message)
    return undefined
  }
  const result = input.result
  if (result === undefined || result.exitCode === 0) return undefined
  if (result.exitCode === 126 || result.exitCode === 127 || loaderFailure(result.stderr))
    return bounded(result.stderr.trim() || `git exited with status ${result.exitCode}`)
  return undefined
}

function loaderFailure(text: string): boolean {
  return (
    text.includes('error while loading shared libraries') ||
    /version [`']GLIBC_[^'`]*['`] not found/.test(text)
  )
}

function bounded(text: string): string {
  const trimmed = text.trim() || 'git could not be executed'
  return trimmed.length > KERNEL_GIT_DETAIL_LIMIT
    ? `${trimmed.slice(0, KERNEL_GIT_DETAIL_LIMIT - 1)}…`
    : trimmed
}

export type KernelGitCondition = RepositoryEventPayload<'dispatcher.kernel-git-unavailable'> & {
  since: string
}

/** The active "kernel Git unavailable" repository condition. One durable
 * event opens it and one closes it, so a fresh dispatcher process (a hosted
 * invocation) sees the outage without re-reporting it. */
export const kernelGitHealthReducer = defineReducer<
  { active?: KernelGitCondition },
  RepositoryEvent,
  KernelGitCondition | undefined
>({
  version: 1,
  initial: () => ({}),
  fold(acc, events) {
    for (const event of events) {
      if (event.type === 'dispatcher.kernel-git-unavailable')
        acc.active = { ...event.payload, since: event.ts }
      if (
        event.type === 'dispatcher.kernel-git-recovered' &&
        acc.active?.executable === event.payload.executable
      )
        delete acc.active
    }
  },
  finish: (acc) => (acc.active === undefined ? undefined : { ...acc.active }),
})
