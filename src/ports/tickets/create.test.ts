/** TicketSource selection and construction tests. */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { PluginFactoryContext } from '../../plugins/manifest'
import { PluginRegistry } from '../../plugins/registry'
import { describeTicketSourceContract } from './contract'
import { createTicketSource } from './create'
import { FakeTicketSource } from './fake'
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
  test('constructs a LinearTicketSource from config and env', async () => {
    const source = await createTicketSource(
      { ...LINEAR_CONFIG, claimedState: 'Doing' },
      ENV,
      REPO,
    )
    expect(source).toBeInstanceOf(LinearTicketSource)
    expect(source.name).toBe('linear')
  })

  test('missing or empty LINEAR_API_KEY errors naming the variable', async () => {
    await expect(createTicketSource(LINEAR_CONFIG, {}, REPO)).rejects.toThrow(
      /LINEAR_API_KEY is not set/,
    )
    await expect(
      createTicketSource(LINEAR_CONFIG, { LINEAR_API_KEY: '' }, REPO),
    ).rejects.toThrow(/LINEAR_API_KEY is not set/)
  })

  test('the error names the expected value and the config that requires it', async () => {
    await expect(createTicketSource(LINEAR_CONFIG, {}, REPO)).rejects.toThrow(
      /Linear personal API key.*\[tickets\]\.source = "linear"/,
    )
  })

  test('missing teamKey errors even with a key set', async () => {
    await expect(
      createTicketSource({ source: 'linear', readyState: 'Todo' }, ENV, REPO),
    ).rejects.toThrow(/requires teamKey/)
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

  test('constructs a FileTicketSource, no LINEAR_API_KEY needed', async () => {
    const source = await createTicketSource(
      { ...FILE_CONFIG, dir: 'tickets' },
      {},
      repo,
    )
    expect(source).toBeInstanceOf(FileTicketSource)
    expect(source.name).toBe('file')
  })

  test('no dir defaults beneath repo state and gitignores itself', async () => {
    const source = await createTicketSource(FILE_CONFIG, {}, repo)
    await source.create({ title: 'T', body: 'b' })
    expect(await readdir(join(repo, '.autobuild', 'tickets', 'triage'))).toEqual([
      'file-1.md',
    ])
    expect(await readdir(join(repo, '.autobuild', 'tickets'))).toContain('.gitignore')
  })

  test('a selected local state root relocates a default tracker', async () => {
    const stateRoot = join(repo, 'alternate-state')
    const source = await createTicketSource(FILE_CONFIG, {}, repo, stateRoot)
    await source.create({ title: 'T', body: 'b' })
    expect(await readdir(join(stateRoot, 'tickets', 'triage'))).toEqual(['file-1.md'])
  })

  test('an explicit relative dir resolves against the repo and is not gitignored', async () => {
    const source = await createTicketSource(
      { ...FILE_CONFIG, dir: 'tickets' },
      {},
      repo,
    )
    await source.create({ title: 'T', body: 'b' })
    expect(await readdir(join(repo, 'tickets', 'triage'))).toEqual(['file-1.md'])
    expect(await readdir(join(repo, 'tickets'))).not.toContain('.gitignore')
  })

  test('an absolute dir is used as given', async () => {
    const dir = join(repo, 'elsewhere')
    const source = await createTicketSource({ ...FILE_CONFIG, dir }, {}, repo)
    await source.create({ title: 'T', body: 'b' })
    expect(await readdir(join(dir, 'triage'))).toEqual(['file-1.md'])
  })

  test('createState flows through to created tickets', async () => {
    const source = await createTicketSource(
      { ...FILE_CONFIG, dir: 'tickets', createState: 'Ready' },
      {},
      repo,
    )
    expect((await source.create({ title: 'T', body: 'b' })).state).toBe('Ready')
  })
})

function pluginRegistry(
  factory: (
    context: PluginFactoryContext,
  ) => FakeTicketSource | Promise<FakeTicketSource>,
  requiredEnv?: string[],
): PluginRegistry {
  const registry = new PluginRegistry()
  registry.register({
    name: 'acme-tracker',
    apiVersion: '^1.0.0',
    ticketSources: {
      jira: requiredEnv === undefined ? factory : { factory, requiredEnv },
    },
  })
  return registry
}

describe('createTicketSource — plugin', () => {
  test('passes full context to an async registered factory', async () => {
    const contexts: unknown[] = []
    const expected = new FakeTicketSource()
    const registry = pluginRegistry(async (context) => {
      contexts.push(context)
      return expected
    })
    const config = {
      source: 'jira',
      readyState: 'Open',
      claimedState: 'Doing',
      createState: 'Triage',
      teamKey: 'APP',
      dir: 'adapter-option',
    }
    const env = { JIRA_TOKEN: 'secret' }
    const source = await createTicketSource(config, env, './repo', undefined, registry)

    expect(source).toBe(expected)
    expect(contexts).toEqual([
      { config, env, repoRoot: resolve('./repo') },
    ])
  })

  test('rejects every missing or empty declared credential before invocation', async () => {
    let invoked = false
    const registry = pluginRegistry(() => {
      invoked = true
      return new FakeTicketSource()
    }, ['JIRA_TOKEN', 'JIRA_SITE'])

    await expect(
      createTicketSource(
        { source: 'jira', readyState: 'Open' },
        { JIRA_TOKEN: '', JIRA_SITE: undefined },
        REPO,
        undefined,
        registry,
      ),
    ).rejects.toThrow(/jira.*acme-tracker.*JIRA_TOKEN.*JIRA_SITE/)
    expect(invoked).toBe(false)
  })

  test('unknown names list builtins and loaded plugin sources', async () => {
    const registry = pluginRegistry(() => new FakeTicketSource())
    await expect(
      createTicketSource(
        { source: 'missing', readyState: 'Open' },
        {},
        REPO,
        undefined,
        registry,
      ),
    ).rejects.toThrow(/unknown ticket source "missing".*file, jira, linear/)
  })

  test('factory failures retain cause and identify source ownership', async () => {
    const cause = new Error('transport setup exploded')
    const registry = pluginRegistry(() => Promise.reject(cause))
    try {
      await createTicketSource(
        { source: 'jira', readyState: 'Open' },
        {},
        REPO,
        undefined,
        registry,
      )
      throw new Error('expected construction to fail')
    } catch (error) {
      expect((error as Error).message).toMatch(/jira.*acme-tracker.*transport setup exploded/)
      expect((error as Error).cause).toBe(cause)
    }
  })
})

describeTicketSourceContract('plugin-selected FakeTicketSource', async () => {
  const registry = pluginRegistry(
    () => new FakeTicketSource([], { createState: 'Triage', doneState: 'Done' }),
  )
  return {
    source: await createTicketSource(
      { source: 'jira', readyState: 'Ready' },
      {},
      REPO,
      undefined,
      registry,
    ),
    states: { ready: 'Ready', claimed: 'Doing', completed: 'Done' },
    editableLabel: 'contract-editable',
  }
})
