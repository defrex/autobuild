import { describe, expect, test } from 'bun:test'
import { delimiter } from 'node:path'
import { AGENT_BIN_DIR, namesPath, sessionEnv } from './session-env'

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

describe('judge launch', () => {
  const launch = { hide: ['/repo', '/repo/.git', '/store'], binDir: '/tmp/autobuild-judge-bin-1' }
  const scoped = { AB_JUDGE: 'b:p:1', AB_SESSION: 's_1', AB_CONTEXT_DIR: '.ab/judge' }

  test('namesPath matches a path, not a sibling or a suffix', () => {
    expect(namesPath('/repo', '/repo')).toBe(true)
    expect(namesPath('/repo/package.json', '/repo')).toBe(true)
    expect(namesPath(`/bin${delimiter}/repo/node_modules/.bin`, '/repo')).toBe(true)
    expect(namesPath('{"cwd":"/repo"}', '/repo')).toBe(true)
    expect(namesPath('--prefix=/repo', '/repo')).toBe(true)
    expect(namesPath('/repo-other', '/repo')).toBe(false)
    expect(namesPath('/repo2/x', '/repo')).toBe(false)
    expect(namesPath('/repo.bak', '/repo')).toBe(false)
    expect(namesPath('/x/repo', '/repo')).toBe(false)
    expect(namesPath('anything', '/')).toBe(false)
  })

  test('drops every ambient value naming a hidden location', () => {
    const env = sessionEnv(
      scoped,
      {
        INIT_CWD: '/repo',
        npm_package_json: '/repo/package.json',
        npm_config_local_prefix: '/repo',
        BUN_INSTALL_CACHE_DIR: '/repo/.git/cache',
        STORE_HINT: 'file:/store/db',
        SIBLING: '/repo-other/tools',
        HOME: '/home/me',
        ANTHROPIC_API_KEY: 'secret',
      },
      launch,
    )
    for (const key of [
      'INIT_CWD',
      'npm_package_json',
      'npm_config_local_prefix',
      'BUN_INSTALL_CACHE_DIR',
      'STORE_HINT',
    ])
      expect(key in env).toBe(false)
    expect(env).toMatchObject({
      SIBLING: '/repo-other/tools',
      HOME: '/home/me',
      ANTHROPIC_API_KEY: 'secret',
      ...scoped,
    })
  })

  test('the launcher directory replaces the distribution one and hidden PATH entries go', () => {
    const env = sessionEnv(
      scoped,
      {
        PATH: [
          '/usr/bin',
          '/repo/node_modules/.bin',
          AGENT_BIN_DIR,
          '/repo-other/bin',
          '',
          '/store/bin',
          '/opt/bun/bin',
        ].join(delimiter),
      },
      launch,
    )
    expect(env.PATH).toBe(
      [launch.binDir, '/usr/bin', '/repo-other/bin', '/opt/bun/bin'].join(delimiter),
    )
  })

  test('without a judge launch, or outside a judge session, output is unchanged', () => {
    const ambient = { PATH: `/repo/node_modules/.bin${delimiter}/usr/bin`, INIT_CWD: '/repo' }
    expect(sessionEnv(scoped, ambient)).toEqual(sessionEnv(scoped, ambient, undefined))
    expect(sessionEnv(scoped, ambient).INIT_CWD).toBe('/repo')
    expect(sessionEnv({ AB_BUILD: 'b' }, ambient, launch)).toEqual(
      sessionEnv({ AB_BUILD: 'b' }, ambient),
    )
  })
})
