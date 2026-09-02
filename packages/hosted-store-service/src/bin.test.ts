import { describe, expect, test } from 'bun:test'
import { verifyToken } from 'autobuild/remote-store'
import { mintTokenFromArgs, runTokenCli } from './bin'

const now = new Date('2026-09-02T00:00:00.000Z')

describe('offline token command', () => {
  test('mints admin and build/session scopes without a service', () => {
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
})
