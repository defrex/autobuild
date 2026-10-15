import { testProjects } from './testing/projects'
import { describe, expect, test } from 'bun:test'
import { verifyToken } from '@defrex/autobuild/remote-store'
import { mintTokenFromArgs, runTokenCli, runHostedCli } from './bin'

const now = new Date('2026-09-02T00:00:00.000Z')

describe('offline token command', () => {
  test('mints deployment, admin, build/session, and attributed operator scopes offline', () => {
    const deployment = mintTokenFromArgs(
      ['mint', 'operator', '--ttl-seconds', '60'],
      { AB_STORE_SECRET: 's' },
      now,
    )
    expect(verifyToken('s', deployment, now)).toEqual({
      operator: true,
      session: '*',
      exp: now.getTime() + 60_000,
    })

    const admin = mintTokenFromArgs(
      ['mint', 'admin', '--ttl-seconds', '60'],
      { AB_STORE_SECRET: 's' },
      now,
    )
    expect(verifyToken('s', admin, now)).toEqual({
      build: '*',
      session: '*',
      exp: now.getTime() + 60_000,
    })

    const build = mintTokenFromArgs(
      [
        'mint',
        'build',
        '--build',
        'demo',
        '--session',
        'implement',
        '--expires-at',
        '2026-09-03T00:00:00Z',
      ],
      { AB_STORE_SECRET: 's' },
      now,
    )
    expect(verifyToken('s', build, now)).toEqual({
      build: 'demo',
      session: 'implement',
      exp: Date.parse('2026-09-03T00:00:00Z'),
    })

    const humanOperator = mintTokenFromArgs(
      ['mint', 'operator', '--user', 'Ada Lovelace', '--ttl-seconds', '60'],
      { AB_STORE_SECRET: 's' },
      now,
    )
    expect(verifyToken('s', humanOperator, now)).toEqual({
      operator: { user: 'Ada Lovelace' },
      exp: now.getTime() + 60_000,
    })
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
