import { describe, expect, test } from 'bun:test'
import { ForgeFailure, ForgeRejection, isForgeFailure, isForgeRejection } from './forge-failure'
import { NoCommitsBetweenBranchesError } from './types'

describe('ForgeRejection', () => {
  const details = { forge: 'GitHub', status: 422, forgeMessage: 'Validation Failed' }

  test('recognizes instances and structurally branded copies', () => {
    const rejection = new ForgeRejection('Validation Failed', details)
    expect(isForgeRejection(rejection)).toBe(true)
    expect(
      isForgeRejection({
        forgeRejection: 'autobuild.forge-rejection.v1',
        message: 'Validation Failed',
        ...details,
      }),
    ).toBe(true)
  })

  test('rejects statuses outside 4xx, empty messages, and forge failures', () => {
    const branded = { forgeRejection: 'autobuild.forge-rejection.v1', message: 'm', ...details }
    expect(isForgeRejection({ ...branded, status: 500 })).toBe(false)
    expect(isForgeRejection({ ...branded, status: 399 })).toBe(false)
    expect(isForgeRejection({ ...branded, forgeMessage: '' })).toBe(false)
    expect(isForgeRejection({ ...branded, forge: '' })).toBe(false)
    expect(() => new ForgeRejection('m', { ...details, status: 503 })).toThrow(TypeError)
    expect(
      isForgeRejection(new ForgeFailure('down', { kind: 'transient', retry: 'retryable' })),
    ).toBe(false)
    expect(isForgeFailure(new ForgeRejection('m', details))).toBe(false)
  })

  test('the no-commits error is a GitHub 422 rejection by default', () => {
    const error = new NoCommitsBetweenBranchesError('No commits between main and ab/x')
    expect(error).toBeInstanceOf(ForgeRejection)
    expect(error).toMatchObject({
      name: 'NoCommitsBetweenBranchesError',
      message: 'No commits between main and ab/x',
      forge: 'GitHub',
      status: 422,
      forgeMessage: 'No commits between main and ab/x',
    })
  })
})
