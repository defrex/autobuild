import { expect, test } from 'bun:test'
import { GIT_CONFIG_ISOLATION_KEYS, inheritedGitConfigIsolation } from './git-config-isolation'

test('each isolation key passes through when defined', () => {
  for (const key of GIT_CONFIG_ISOLATION_KEYS)
    expect(inheritedGitConfigIsolation({ [key]: `${key}-value` })).toEqual({
      [key]: `${key}-value`,
    })
  expect(
    inheritedGitConfigIsolation({
      GIT_CONFIG_GLOBAL: '/scratch/gitconfig',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_SYSTEM: '/dev/null',
    }),
  ).toEqual({
    GIT_CONFIG_GLOBAL: '/scratch/gitconfig',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_SYSTEM: '/dev/null',
  })
})

test('undefined and unrelated keys are omitted', () => {
  expect(
    inheritedGitConfigIsolation({
      GIT_CONFIG_GLOBAL: undefined,
      GIT_CONFIG_NOSYSTEM: '1',
      HOME: '/home/someone',
      PATH: '/usr/bin',
    }),
  ).toEqual({ GIT_CONFIG_NOSYSTEM: '1' })
})

test('an empty env yields nothing', () => {
  expect(inheritedGitConfigIsolation({})).toEqual({})
})
