import { describe, expect, test } from 'bun:test'
import {
  githubSquashDefaults,
  needsCommitMessages,
  sameArmedMessage,
} from './github-squash-message'

const pr: { number: number; title: string; body: string | null } = {
  number: 42,
  title: 'PR title',
  body: 'PR body\n',
}
const one = ['Only subject\n\nOnly body line\n']
const two = ['First subject\n\nFirst body', 'Second subject\n']
const derive = (
  titleSetting: string,
  messageSetting: string,
  commits: readonly string[],
  overrides: Partial<typeof pr> = {},
) => githubSquashDefaults({ ...pr, ...overrides, titleSetting, messageSetting, commits })

describe('githubSquashDefaults', () => {
  test.each([
    ['PR_TITLE', 'PR_BODY', one, 'PR title (#42)', 'PR body\n'],
    ['PR_TITLE', 'PR_BODY', two, 'PR title (#42)', 'PR body\n'],
    ['PR_TITLE', 'COMMIT_MESSAGES', one, 'PR title (#42)', '* Only subject\n\nOnly body line'],
    [
      'PR_TITLE',
      'COMMIT_MESSAGES',
      two,
      'PR title (#42)',
      '* First subject\n\nFirst body\n\n* Second subject',
    ],
    ['PR_TITLE', 'BLANK', one, 'PR title (#42)', ''],
    ['PR_TITLE', 'BLANK', two, 'PR title (#42)', ''],
    ['COMMIT_OR_PR_TITLE', 'PR_BODY', one, 'Only subject (#42)', 'PR body\n'],
    ['COMMIT_OR_PR_TITLE', 'PR_BODY', two, 'PR title (#42)', 'PR body\n'],
    ['COMMIT_OR_PR_TITLE', 'COMMIT_MESSAGES', one, 'Only subject (#42)', 'Only body line\n'],
    [
      'COMMIT_OR_PR_TITLE',
      'COMMIT_MESSAGES',
      two,
      'PR title (#42)',
      '* First subject\n\nFirst body\n\n* Second subject',
    ],
    ['COMMIT_OR_PR_TITLE', 'BLANK', one, 'Only subject (#42)', ''],
    ['COMMIT_OR_PR_TITLE', 'BLANK', two, 'PR title (#42)', ''],
  ])('%s / %s with %j', (title, message, commits, headline, body) => {
    expect(derive(title, message, commits)).toEqual({ headline, body })
  })

  test('a null PR body is empty', () => {
    expect(derive('PR_TITLE', 'PR_BODY', [], { body: null }).body).toBe('')
  })

  test('CRLF inputs normalize to LF', () => {
    expect(
      derive('COMMIT_OR_PR_TITLE', 'COMMIT_MESSAGES', ['Subject\r\n\r\nBody\r\nmore\r\n'], {
        body: 'a\r\nb',
      }),
    ).toEqual({ headline: 'Subject (#42)', body: 'Body\nmore\n' })
    expect(derive('PR_TITLE', 'PR_BODY', [], { body: 'a\r\nb' }).body).toBe('a\nb')
    expect(derive('PR_TITLE', 'COMMIT_MESSAGES', ['A\r\n\r\nx\r\n', 'B']).body).toBe(
      '* A\n\nx\n\n* B',
    )
  })

  test('a single subject-only commit has an empty body', () => {
    expect(derive('COMMIT_OR_PR_TITLE', 'COMMIT_MESSAGES', ['Just a subject'])).toEqual({
      headline: 'Just a subject (#42)',
      body: '',
    })
  })

  test('unknown setting values throw', () => {
    expect(() => derive('MERGE_MESSAGE', 'PR_BODY', [])).toThrow('squash title setting')
    expect(() => derive('PR_TITLE', 'PR_TITLE', [])).toThrow('squash message setting')
  })
})

test('needsCommitMessages truth table', () => {
  for (const title of ['PR_TITLE', 'COMMIT_OR_PR_TITLE'] as const)
    for (const message of ['PR_BODY', 'COMMIT_MESSAGES', 'BLANK'] as const)
      for (const count of [1, 2])
        expect(needsCommitMessages(title, message, count)).toBe(
          message === 'COMMIT_MESSAGES' || (title === 'COMMIT_OR_PR_TITLE' && count === 1),
        )
})

describe('sameArmedMessage', () => {
  const expected = { headline: 'Title (#42)', body: 'Body\n\nAutobuild-Build: b\n' }
  test('provider trimming and CRLF still match', () => {
    expect(
      sameArmedMessage({ title: 'Title (#42)', message: 'Body\n\nAutobuild-Build: b' }, expected),
    ).toBe(true)
    expect(
      sameArmedMessage(
        { title: ' Title (#42)\r\n', message: 'Body\r\n\r\nAutobuild-Build: b\r\n' },
        expected,
      ),
    ).toBe(true)
  })
  test('a different headline or body, or unset overrides, do not match', () => {
    expect(sameArmedMessage({ title: 'Other (#42)', message: expected.body }, expected)).toBe(false)
    expect(sameArmedMessage({ title: expected.headline, message: 'Old body\n' }, expected)).toBe(
      false,
    )
    expect(sameArmedMessage({ title: null, message: expected.body }, expected)).toBe(false)
    expect(sameArmedMessage({ title: expected.headline, message: null }, expected)).toBe(false)
  })
})
