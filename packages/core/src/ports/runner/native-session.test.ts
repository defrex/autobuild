import { expect, test } from 'bun:test'
test('native lookup classification preserves provider availability and credential failures', async () => {
  const { nativeStateUnavailable } = await import('./native-session')
  expect(
    nativeStateUnavailable({ message: 'No rollout found for thread id abc', permanent: false }),
  ).toBe(true)
  expect(
    nativeStateUnavailable({
      message: 'No conversation found with session ID abc',
      permanent: false,
    }),
  ).toBe(true)
  expect(
    nativeStateUnavailable({
      message: 'Service unavailable while processing thread abc',
      permanent: false,
      cause: 'availability',
    }),
  ).toBe(false)
  expect(
    nativeStateUnavailable({
      message: 'Session not found in credential provider',
      permanent: true,
      cause: 'credentials',
    }),
  ).toBe(false)
})
