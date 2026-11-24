import { expect, test } from 'bun:test'
import { JsonlDecoder } from './pi-rpc'
test('splits only LF records and accepts fragmented UTF-8 plus CRLF', () => {
  const decoder = new JsonlDecoder()
  expect(decoder.push('{"a":"x\u2028y"}\r')).toEqual([])
  expect(decoder.push('\n{"b":')).toEqual(['{"a":"x\u2028y"}'])
  expect(decoder.push('2}\n')).toEqual(['{"b":2}'])
  expect(decoder.end()).toEqual([])
})
