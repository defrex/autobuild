import { expect, test } from 'bun:test'

// The unit IO guard fails this file if importing these modules runs Git or
// reads the filesystem: in-memory consumers of dispatch and the build runner
// must not capture runtime identity at import. Calling `runtimeIdentity()`
// captures it, so this file never does.
test('importing dispatch and build-runner modules captures no runtime identity', async () => {
  const identity = await import('./runtime-identity')
  const dispatch = await import('./cli/dispatch')
  const runner = await import('./processes/build-runner')
  expect(typeof identity.runtimeIdentity).toBe('function')
  expect(typeof identity.formatDispatcherError).toBe('function')
  expect(Object.keys(dispatch).length).toBeGreaterThan(0)
  expect(typeof runner.BuildRunner).toBe('function')
})
