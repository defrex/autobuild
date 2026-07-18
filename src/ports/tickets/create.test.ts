/**
 * TicketSource factory tests: the [tickets] table plus environment select and
 * construct the source. The load-bearing rule: a Linear source without
 * LINEAR_API_KEY is a hard error naming the variable (D6 — the thrown error
 * becomes stderr + exit 1 at the CLI boundary).
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createTicketSource } from './create'
import { FileTicketSource } from './file'
import { LinearTicketSource } from './linear'

const LINEAR_CONFIG = {
  source: 'linear' as const,
  teamKey: 'ENG',
  readyState: 'Todo',
}
const FILE_CONFIG = { source: 'file' as const, readyState: 'ready' }
const ENV = { LINEAR_API_KEY: 'lin_api_abc' }
const REPO = '/repo'

describe('createTicketSource — linear', () => {
  test('constructs a LinearTicketSource from config and env', () => {
    const source = createTicketSource(
      { ...LINEAR_CONFIG, claimedState: 'Doing' },
      ENV,
      REPO,
    )
    expect(source).toBeInstanceOf(LinearTicketSource)
    expect(source.name).toBe('linear')
  })

  test('missing LINEAR_API_KEY errors naming the variable', () => {
    expect(() => createTicketSource(LINEAR_CONFIG, {}, REPO)).toThrow(
      /LINEAR_API_KEY is not set/,
    )
  })

  test('an empty-string LINEAR_API_KEY counts as missing', () => {
    expect(() =>
      createTicketSource(LINEAR_CONFIG, { LINEAR_API_KEY: '' }, REPO),
    ).toThrow(/LINEAR_API_KEY is not set/)
  })

  test('the error names the expected value and the config that requires it', () => {
    expect(() => createTicketSource(LINEAR_CONFIG, {}, REPO)).toThrow(
      /Linear personal API key.*\[tickets\]\.source = "linear"/,
    )
  })

  test('missing teamKey errors even with a key set (defense beyond config validation)', () => {
    expect(() =>
      createTicketSource({ source: 'linear', readyState: 'Todo' }, ENV, REPO),
    ).toThrow(/requires teamKey/)
  })
})

describe('createTicketSource — file', () => {
  let repo: string

  beforeEach(async () => {
    repo = await mkdtemp(join(tmpdir(), 'ab-create-repo-'))
  })

  afterEach(async () => {
    await rm(repo, { recursive: true, force: true })
  })

  test('constructs a FileTicketSource, no LINEAR_API_KEY needed', () => {
    const source = createTicketSource({ ...FILE_CONFIG, dir: 'tickets' }, {}, repo)
    expect(source).toBeInstanceOf(FileTicketSource)
    expect(source.name).toBe('file')
  })

  test('no dir: the tracker defaults to <repo>/.autobuild/tickets and gitignores itself', async () => {
    const source = createTicketSource(FILE_CONFIG, {}, repo)
    await source.create({ title: 'T', body: 'b' })

    expect(await readdir(join(repo, '.autobuild', 'tickets', 'triage'))).toEqual([
      'file-1.md',
    ])
    expect(await readdir(join(repo, '.autobuild', 'tickets'))).toContain('.gitignore')
  })

  test('no dir: a selected local state root relocates the tracker too', async () => {
    const stateRoot = join(repo, 'alternate-state')
    const source = createTicketSource(FILE_CONFIG, {}, repo, stateRoot)
    await source.create({ title: 'T', body: 'b' })

    expect(await readdir(join(stateRoot, 'tickets', 'triage'))).toEqual(['file-1.md'])
  })

  test('an explicit relative dir resolves against the repo, not cwd — and is NOT gitignored', async () => {
    const source = createTicketSource({ ...FILE_CONFIG, dir: 'tickets' }, {}, repo)
    await source.create({ title: 'T', body: 'b' })

    expect(await readdir(join(repo, 'tickets', 'triage'))).toEqual(['file-1.md'])
    // The pair matters: a dir the user named is theirs, and silently dropping it
    // out of `git status` would be a bad, invisible failure.
    expect(await readdir(join(repo, 'tickets'))).not.toContain('.gitignore')
  })

  test('an absolute dir is used as given', async () => {
    const dir = join(repo, 'elsewhere')
    const source = createTicketSource({ ...FILE_CONFIG, dir }, {}, repo)
    await source.create({ title: 'T', body: 'b' })

    expect(await readdir(join(dir, 'triage'))).toEqual(['file-1.md'])
  })

  test('createState flows through to created tickets', async () => {
    const source = createTicketSource(
      { ...FILE_CONFIG, dir: 'tickets', createState: 'Ready' },
      {},
      repo,
    )
    const ticket = await source.create({ title: 'T', body: 'b' })
    expect(ticket.state).toBe('Ready')
  })
})
