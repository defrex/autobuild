/**
 * TicketSource factory tests: the [tickets] table plus environment select and
 * construct the source. The load-bearing rule: a Linear source without
 * LINEAR_API_KEY is a hard error naming the variable (D6 — the thrown error
 * becomes stderr + exit 1 at the CLI boundary).
 */
import { describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createTicketSource } from './create'
import { FileTicketSource } from './file'
import { LinearTicketSource } from './linear'

const LINEAR_CONFIG = { source: 'linear' as const, teamKey: 'ENG' }
const ENV = { LINEAR_API_KEY: 'lin_api_abc' }

describe('createTicketSource — linear', () => {
  test('constructs a LinearTicketSource from config and env', () => {
    const source = createTicketSource(
      { ...LINEAR_CONFIG, claimedState: 'Doing' },
      ENV,
    )
    expect(source).toBeInstanceOf(LinearTicketSource)
    expect(source.name).toBe('linear')
  })

  test('missing LINEAR_API_KEY errors naming the variable', () => {
    expect(() => createTicketSource(LINEAR_CONFIG, {})).toThrow(
      /LINEAR_API_KEY is not set/,
    )
  })

  test('an empty-string LINEAR_API_KEY counts as missing', () => {
    expect(() =>
      createTicketSource(LINEAR_CONFIG, { LINEAR_API_KEY: '' }),
    ).toThrow(/LINEAR_API_KEY is not set/)
  })

  test('the error names the expected value and the config that requires it', () => {
    expect(() => createTicketSource(LINEAR_CONFIG, {})).toThrow(
      /Linear personal API key.*\[tickets\]\.source = "linear"/,
    )
  })

  test('missing teamKey errors even with a key set (defense beyond config validation)', () => {
    expect(() => createTicketSource({ source: 'linear' }, ENV)).toThrow(
      /requires teamKey/,
    )
  })
})

describe('createTicketSource — file', () => {
  test('constructs a FileTicketSource from dir', () => {
    const source = createTicketSource({ source: 'file', dir: 'tickets' }, {})
    expect(source).toBeInstanceOf(FileTicketSource)
    expect(source.name).toBe('file')
  })

  test('needs no LINEAR_API_KEY', () => {
    expect(() =>
      createTicketSource({ source: 'file', dir: 'tickets' }, {}),
    ).not.toThrow()
  })

  test('missing dir errors naming the requirement', () => {
    expect(() => createTicketSource({ source: 'file' }, {})).toThrow(
      /requires dir/,
    )
  })

  test('createState flows through to created tickets', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ab-create-'))
    try {
      const source = createTicketSource(
        { source: 'file', dir, createState: 'Backlog' },
        {},
      )
      const ticket = await source.create({ title: 'T', body: 'b' })
      expect(ticket.state).toBe('Backlog')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
