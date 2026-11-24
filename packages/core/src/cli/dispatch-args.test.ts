import { expect, test } from 'bun:test'
import { parseDispatchArgs, pinWebPort } from './dispatch-args'

test('--web takes --port, --host and --json; they require it, and --once is refused', () => {
  expect(parseDispatchArgs([], {}).web).toBeUndefined()
  expect(parseDispatchArgs(['--web'], {}).web).toEqual({ port: 0, json: false })
  expect(
    parseDispatchArgs(['--viewer', '--web', '--port', '4100', '--host', '::1', '--json'], {}).web,
  ).toEqual({ port: 4100, host: '::1', json: true })
  for (const flags of [['--port', '1'], ['--host', 'localhost'], ['--json']])
    expect(() => parseDispatchArgs(flags, {})).toThrow('--port, --host and --json require --web')
  expect(() => parseDispatchArgs(['--web', '--once'], {})).toThrow(
    '--web serves until stopped and cannot be combined with --once',
  )
  expect(() => parseDispatchArgs(['--web', '--port', '70000'], {})).toThrow(
    '--port requires an integer from 0 to 65535',
  )
})

test('pinWebPort replaces a given --port and appends one when absent', () => {
  expect(pinWebPort(['--web', '--port', '0', '--plain'], 4100)).toEqual([
    '--web',
    '--plain',
    '--port',
    '4100',
  ])
  expect(pinWebPort(['--web'], 4100)).toEqual(['--web', '--port', '4100'])
})
