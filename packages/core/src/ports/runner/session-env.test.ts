import { describe, expect, test } from 'bun:test'
import { delimiter } from 'node:path'
import { AGENT_BIN_DIR, sessionEnv } from './session-env'

describe('sessionEnv', () => {
  test('copies defined ambient variables and overlays scoped values', () => {
    const env = sessionEnv(
      { OVERRIDE: 'scoped', SCOPED_ONLY: 'present' },
      {
        AMBIENT_ONLY: 'present',
        OVERRIDE: 'ambient',
        OMIT_UNDEFINED: undefined,
        PATH: `/host/one${delimiter}/host/two`,
      },
    )

    expect(env.AMBIENT_ONLY).toBe('present')
    expect(env.OVERRIDE).toBe('scoped')
    expect(env.SCOPED_ONLY).toBe('present')
    expect('OMIT_UNDEFINED' in env).toBe(false)
  })

  test('supplies the managed directory when PATH is absent or scoped empty', () => {
    expect(sessionEnv({}, {}).PATH).toBe(AGENT_BIN_DIR)
    expect(sessionEnv({ PATH: '' }, { PATH: '/ambient/bin' }).PATH).toBe(AGENT_BIN_DIR)
  })

  test('prefixes PATH, preserves inherited search order, and removes duplicate managed entries', () => {
    const inherited = ['/host/conflict', AGENT_BIN_DIR, '/host/tools', AGENT_BIN_DIR].join(
      delimiter,
    )

    expect(sessionEnv({}, { PATH: inherited }).PATH).toBe(
      [AGENT_BIN_DIR, '/host/conflict', '/host/tools'].join(delimiter),
    )
  })

  test('does not mutate scoped, ambient, or global environments', () => {
    const scoped = { PATH: '/scoped/bin', AB_SESSION: 's_1' }
    const ambient: Record<string, string | undefined> = {
      PATH: '/ambient/bin',
      AMBIENT: 'yes',
    }
    const scopedBefore = { ...scoped }
    const ambientBefore = { ...ambient }
    const globalPathBefore = process.env.PATH

    const env = sessionEnv(scoped, ambient)
    env.AB_SESSION = 'changed-result-only'

    expect(scoped).toEqual(scopedBefore)
    expect(ambient).toEqual(ambientBefore)
    expect(process.env.PATH).toBe(globalPathBefore)
  })

  test('a judge session drops ambient Autobuild, Git and working-directory keys', () => {
    const ambient = {
      AB_BUILD: 'b',
      AB_PHASE: 'implement@1',
      AB_STRAY: 'x',
      GIT_DIR: '/ws/.git',
      GIT_CEILING_DIRECTORIES: '/',
      PWD: '/ws',
      OLDPWD: '/ws/sub',
      HOME: '/home/me',
    }
    const env = sessionEnv({ AB_JUDGE: 'b:p:1', AB_SESSION: 's_1', AB_STORE: '/store' }, ambient)
    expect(env).toMatchObject({ AB_JUDGE: 'b:p:1', AB_SESSION: 's_1', AB_STORE: '/store' })
    expect(env.HOME).toBe('/home/me')
    for (const key of ['AB_BUILD', 'AB_PHASE', 'AB_STRAY', 'GIT_DIR', 'GIT_CEILING_DIRECTORIES'])
      expect(key in env).toBe(false)
    expect('PWD' in env).toBe(false)
    expect('OLDPWD' in env).toBe(false)
  })

  test('a phase session keeps inherited keys other than the dropped credentials', () => {
    const env = sessionEnv(
      { AB_BUILD: 'b', AB_SESSION: 's_1' },
      { AB_STRAY: 'x', GIT_DIR: '/ws/.git', PWD: '/ws' },
    )
    expect(env).toMatchObject({ AB_STRAY: 'x', GIT_DIR: '/ws/.git', PWD: '/ws' })
  })
})
