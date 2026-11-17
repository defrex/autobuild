import { z } from 'zod'

/**
 * Autobuild's deterministic derivation of a GitHub squash headline and body
 * from the PR and the repository's configured squash settings
 * (`squash_merge_commit_title`, `squash_merge_commit_message` on the REST
 * repository resource). The landing path composes the build trailer and
 * issue-link handling on top of this; it never reads GitHub's own default
 * through GraphQL. This is not a byte-for-byte reproduction of GitHub's web
 * UI default (co-author trailer hoisting, for example, is not modelled).
 */

export const GitHubSquashTitleSetting = z.enum(['PR_TITLE', 'COMMIT_OR_PR_TITLE'])
export type GitHubSquashTitleSetting = z.infer<typeof GitHubSquashTitleSetting>

export const GitHubSquashMessageSetting = z.enum(['PR_BODY', 'COMMIT_MESSAGES', 'BLANK'])
export type GitHubSquashMessageSetting = z.infer<typeof GitHubSquashMessageSetting>

const lf = (text: string): string => text.replace(/\r\n/g, '\n')

function setting<T extends string>(schema: z.ZodType<T>, value: string, field: string): T {
  const parsed = schema.safeParse(value)
  if (!parsed.success) throw new Error(`unknown GitHub ${field} value ${JSON.stringify(value)}`)
  return parsed.data
}

/** Whether the derivation needs the PR's commit messages for these settings. */
export function needsCommitMessages(
  titleSetting: GitHubSquashTitleSetting,
  messageSetting: GitHubSquashMessageSetting,
  commitCount: number,
): boolean {
  return (
    messageSetting === 'COMMIT_MESSAGES' ||
    (titleSetting === 'COMMIT_OR_PR_TITLE' && commitCount === 1)
  )
}

/** The squash defaults for the settings. `commits` holds the PR's commit
 * messages in GitHub's chronological order; it may be empty when
 * `needsCommitMessages` is false. Unknown setting values throw. */
export function githubSquashDefaults(input: {
  titleSetting: string
  messageSetting: string
  number: number
  title: string
  body: string | null
  commits: readonly string[]
}): { headline: string; body: string } {
  const titleSetting = setting(GitHubSquashTitleSetting, input.titleSetting, 'squash title setting')
  const messageSetting = setting(
    GitHubSquashMessageSetting,
    input.messageSetting,
    'squash message setting',
  )
  const commits = input.commits.map(lf)
  const single = titleSetting === 'COMMIT_OR_PR_TITLE' && commits.length === 1
  const [subject = '', ...rest] = single ? commits[0]!.split('\n') : []
  const headline = `${single ? subject : lf(input.title)} (#${input.number})`
  let body: string
  switch (messageSetting) {
    case 'BLANK':
      body = ''
      break
    case 'PR_BODY':
      body = lf(input.body ?? '')
      break
    case 'COMMIT_MESSAGES':
      body = single
        ? rest.join('\n').replace(/^(?:[ \t]*\n)+/, '')
        : commits.map((message) => `* ${message.trim()}`).join('\n\n')
  }
  return { headline, body }
}

/** Whether an armed request's title and message match the expected landing
 * composition. Both sides normalize line endings; the headline compares
 * trimmed and the body without trailing whitespace, so provider trimming
 * cannot cause a repair on every poll. Unset overrides never match. */
export function sameArmedMessage(
  armed: { title: string | null; message: string | null },
  expected: { headline: string; body: string },
): boolean {
  if (armed.title === null || armed.message === null) return false
  return (
    lf(armed.title).trim() === lf(expected.headline).trim() &&
    lf(armed.message).trimEnd() === lf(expected.body).trimEnd()
  )
}
