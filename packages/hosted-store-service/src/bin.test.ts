import { testCredentials } from './testing/credentials'
import { testProjects } from './testing/projects'
import { describe, expect, test } from 'bun:test'
import { verifyToken } from '@defrex/autobuild/remote-store'
import { mintTokenFromArgs, runTokenCli, runHostedCli } from './bin'

const now = new Date('2026-09-02T00:00:00.000Z')

describe('offline token command', () => {
  test('mints explicit owner admin and retires client resource issuance', () => {
    const admin = mintTokenFromArgs(
      ['mint', 'admin', '--ttl-seconds', '60'],
      { AB_STORE_SECRET: 's' },
      now,
    )
    expect(verifyToken('s', admin, now)).toEqual({
      version: 1,
      ownerAdmin: { user: 'owner:break-glass' },
      exp: now.getTime() + 60000,
    })
    for (const kind of ['operator', 'build'])
      expect(() =>
        mintTokenFromArgs(['mint', kind, '--ttl-seconds', '60'], { AB_STORE_SECRET: 's' }, now),
      ).toThrow('credentials issue')
  })

  test('prints only a token on success and actionable usage on failure', () => {
    const output: string[] = []
    expect(
      runTokenCli(
        ['mint', 'admin', '--ttl-seconds', '1'],
        { AB_STORE_SECRET: 's' },
        output.push.bind(output),
      ),
    ).toBe(0)
    expect(output).toHaveLength(1)
    expect(output[0]).not.toContain('Usage')

    const errors: string[] = []
    expect(
      runTokenCli(['mint', 'build'], { AB_STORE_SECRET: 's' }, () => {}, errors.push.bind(errors)),
    ).toBe(2)
    expect(errors[0]).toContain('Usage:')
  })

  test('no longer offers pack-distribution: the dispatcher package owns it', () => {
    const errors: string[] = []
    expect(
      runTokenCli(
        ['pack-distribution'],
        { AB_STORE_SECRET: 's' },
        () => {},
        errors.push.bind(errors),
      ),
    ).toBe(2)
    expect(errors[0]).toContain('Usage:')
    expect(errors[0]).not.toContain('pack-distribution')
  })
})

// Registry administration uses deployment database authority, independently of tokens.
describe('project owner command', () => {
  test('lists, adds idempotently, removes, and always closes the pool', async () => {
    const registry = testProjects([])
    let closed = 0
    registry.close = async () => {
      closed++
    }
    const output: string[] = []
    const run = (args: string[]) =>
      runHostedCli(
        ['projects', ...args],
        {},
        (line) => output.push(line),
        () => {},
        async () => registry,
      )
    expect(await run(['add', 'https://github.com/acme/app', '--user', 'Ada'])).toBe(0)
    expect(await run(['add', 'https://github.com/acme/app', '--user', 'Grace'])).toBe(0)
    expect(JSON.parse(output[1]!).addedBy).toBe('Ada')
    expect(await run(['list'])).toBe(0)
    expect(JSON.parse(output[2]!)).toHaveLength(1)
    expect(await run(['remove', 'https://github.com/acme/app', '--user', 'Ada'])).toBe(0)
    expect(await run(['remove', 'https://github.com/acme/app', '--user', 'Ada'])).toBe(0)
    expect(await registry.list()).toEqual([])
    expect(closed).toBe(5)
  })

  test.each([
    { args: ['list', '--user', 'Ada'] },
    { args: ['add', 'https://github.com/acme/app'] },
    { args: ['add', '/tmp/repo', '--user', 'Ada'] },
    { args: ['remove', 'https://github.com/acme/app', '--user', ' '] },
    { args: ['add', 'https://github.com/acme/app', '--bad', 'Ada'] },
    { args: ['add', 'https://github.com/acme/app', '--user', 'Ada', '--user', 'Grace'] },
  ])('rejects malformed arguments before opening persistence: %j', async ({ args }) => {
    let opened = false
    const code = await runHostedCli(
      ['projects', ...args],
      {},
      () => {},
      () => {},
      async () => {
        opened = true
        return testProjects([])
      },
    )
    expect(code).toBe(2)
    expect(opened).toBe(false)
  })

  test('database errors fail with a nonzero status and close opened pools', async () => {
    const registry = testProjects([])
    let closed = false
    registry.list = async () => {
      throw new Error('database unavailable')
    }
    registry.close = async () => {
      closed = true
    }
    const errors: string[] = []
    expect(
      await runHostedCli(
        ['projects', 'list'],
        {},
        () => {},
        (line) => errors.push(line),
        async () => registry,
      ),
    ).toBe(2)
    expect(errors[0]).toContain('database unavailable')
    expect(closed).toBe(true)
  })
})

test('credential owner commands issue once, list redacted metadata, revoke idempotently and close pools', async () => {
  const repo = 'https://github.com/acme/owner-cli'
  const { store } = testCredentials(testProjects([repo]))
  let closes = 0
  store.close = async () => {
    closes++
  }
  const output: string[] = []
  const run = (args: string[]) =>
    runHostedCli(
      ['credentials', ...args],
      {},
      (text) => output.push(text),
      (text) => {
        throw new Error(text)
      },
      undefined,
      async () => store,
    )
  expect(await run(['issue', repo, '--user', 'owner'])).toBe(0)
  const issued = JSON.parse(output.pop()!)
  expect(issued.token).toMatch(/^abp_1_/)
  expect(await run(['list', repo])).toBe(0)
  expect(output.pop()).not.toContain(issued.token)
  expect(await run(['revoke', repo, '--id', issued.credential.id, '--user', 'owner'])).toBe(0)
  expect(await run(['revoke', repo, '--id', issued.credential.id, '--user', 'owner'])).toBe(0)
  expect(await store.authenticate(issued.token, new Date())).toBeNull()
  expect(closes).toBe(4)
})

test('ticket team assignment validates arguments before opening its independent recovery store', async () => {
  const calls: string[][] = []
  let opens = 0,
    closes = 0
  const errors: string[] = []
  const run = (args: string[]) =>
    runHostedCli(
      args,
      {},
      () => {},
      (text) => errors.push(text),
      undefined,
      undefined,
      async () => {
        opens++
        return {
          assign: async (...input) => {
            calls.push(input)
          },
          close: async () => {
            closes++
          },
        }
      },
    )
  for (const args of [
    ['tickets', 'assign-team'],
    ['tickets', 'assign-team', ' ', 'https://github.com/acme/app', '--user', 'owner'],
    ['tickets', 'assign-team', 'ENG', '/tmp/repo', '--user', 'owner'],
    ['tickets', 'assign-team', 'ENG', 'https://github.com/acme/app', '--user', ' '],
    ['tickets', 'assign-team', 'ENG', 'https://github.com/acme/app', '--user', 'owner', '--extra'],
  ])
    expect(await run(args)).toBe(2)
  expect(opens).toBe(0)
  expect(
    await run(['tickets', 'assign-team', 'ENG', 'git@github.com:acme/app.git', '--user', 'owner']),
  ).toBe(0)
  expect(calls).toEqual([['ENG', 'https://github.com/acme/app', 'owner']])
  expect(opens).toBe(1)
  expect(closes).toBe(1)
})

test('admin removal help explicitly retains data and points to permanent web deletion', async () => {
  const lines: string[] = []
  await runHostedCli(
    ['projects'],
    {},
    (line) => {
      lines.push(line)
    },
    (line) => {
      lines.push(line)
    },
  )
  const help = lines.join('\n')
  expect(help).toContain('unregisters access only; all project data is retained')
  expect(help).toContain('web Projects page')
})
