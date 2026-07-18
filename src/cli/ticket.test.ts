/**
 * `ab ticket create` (SPEC §8.8): files the body through the configured
 * TicketSource — config selects the adapter, secrets come from the process
 * env, and errors are agent feedback (D6) naming what would be accepted.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { TicketsConfig } from '../config/schema'
import type { Ticket, TicketDraft, TicketSource } from '../ports/types'
import { runCli } from './main'
import { abTicketCreate } from './ticket'

let tmp: string

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'ab-ticket-'))
})

afterEach(async () => {
  await rm(tmp, { recursive: true, force: true })
})

const FILE_TICKETS_TOML = ['[tickets]', 'source = "file"', 'dir = "tickets"', ''].join('\n')

/**
 * `[tickets].readyState` is required, and every normal fixture here goes
 * through `parseConfig`. Inject it into an existing tickets table or prepend a
 * minimal file-source table when the fixture is about another config section.
 */
function withReadyState(toml: string): string {
  if (/(^|\n)\s*readyState\s*=/.test(toml)) return toml
  if (/(^|\n)\[tickets\]/.test(toml)) {
    return toml.replace(/(^|\n)(\[tickets\][^\n]*\n)/, `$1$2readyState = "ready"\n`)
  }
  return `[tickets]\nsource = "file"\nreadyState = "ready"\n${toml}`
}

async function writeRepo(configToml: string): Promise<void> {
  await writeFile(join(tmp, 'autobuild.toml'), withReadyState(configToml))
}

/**
 * A capturing fake: records the draft and config it was constructed from.
 * `known` is the set of ids `dependencyStates` reports as existing — how the
 * blocker-validation tests distinguish a real blocker from a typo.
 */
function fakeFactory(
  created: {
    config?: TicketsConfig
    env?: Record<string, string | undefined>
    targetRepo?: string
    draft?: TicketDraft
  },
  known: string[] = [],
) {
  return (
    config: TicketsConfig,
    env: Record<string, string | undefined>,
    targetRepo: string,
  ): TicketSource => {
    created.config = config
    created.env = env
    created.targetRepo = targetRepo
    return {
      name: 'fake',
      listReady: () => Promise.resolve([]),
      get: () => Promise.resolve(null),
      claim: () => Promise.resolve(false),
      comment: () => Promise.resolve(),
      transition: () => Promise.resolve(),
      dependencyStates: (ids: string[]) =>
        Promise.resolve(
          ids.map((id) => ({
            id,
            exists: known.includes(id),
            resolved: false,
            blockedBy: [],
          })),
        ),
      create: (draft: TicketDraft): Promise<Ticket> => {
        created.draft = draft
        return Promise.resolve({
          ref: { source: 'fake', id: 'fake-1', url: 'https://example.test/fake-1' },
          title: draft.title,
          body: draft.body,
          state: 'Triage',
          labels: draft.labels ?? [],
          ...(draft.blockedBy !== undefined ? { blockedBy: draft.blockedBy } : {}),
        })
      },
    }
  }
}

describe('abTicketCreate', () => {
  test('files the body file through the configured source and prints the ref', async () => {
    await writeRepo(FILE_TICKETS_TOML)
    const bodyFile = join(tmp, 'spec.md')
    await writeFile(bodyFile, '## What and why\n\nBecause.\n')
    const created: Parameters<typeof fakeFactory>[0] = {}
    const out: string[] = []

    await abTicketCreate({
      targetRepo: tmp,
      title: 'Add rate limiting',
      bodyFile,
      labels: ['autobuild'],
      env: { LINEAR_API_KEY: 'k' },
      stdout: (line) => out.push(line),
      sourceFactory: fakeFactory(created),
    })

    // The CLI hands the factory the config verbatim plus the repo: resolving a
    // relative dir (and deciding it was defaulted) is the factory's job now.
    expect(created.config).toEqual({
      source: 'file',
      readyState: 'ready',
      dir: 'tickets',
    })
    expect(created.targetRepo).toBe(tmp)
    expect(created.env).toEqual({ LINEAR_API_KEY: 'k' })
    expect(created.draft).toEqual({
      title: 'Add rate limiting',
      body: '## What and why\n\nBecause.\n',
      labels: ['autobuild'],
    })
    expect(out).toEqual([
      'ticket created: fake:fake-1 (Triage) — https://example.test/fake-1',
    ])
  })

  test('with source = "file" and no factory override, writes a real ticket file', async () => {
    await writeRepo(FILE_TICKETS_TOML)
    const bodyFile = join(tmp, 'spec.md')
    await writeFile(bodyFile, 'the spec body\n')
    const out: string[] = []

    await abTicketCreate({
      targetRepo: tmp,
      title: 'Real file ticket',
      bodyFile,
      env: {},
      stdout: (line) => out.push(line),
    })

    expect(out).toEqual(['ticket created: file:file-1 (Triage)'])
    // Triage is the directory, not a frontmatter field — new tickets land in
    // <dir>/triage/ (the printed state above is read back off that directory).
    const written = await readFile(join(tmp, 'tickets', 'triage', 'file-1.md'), 'utf8')
    expect(written).toContain('title = "Real file ticket"')
    expect(written).toContain('the spec body')
    expect(written).not.toContain('state =')
  })

  test('a missing autobuild.toml is an error naming the path', async () => {
    const bodyFile = join(tmp, 'spec.md')
    await writeFile(bodyFile, 'body\n')
    expect(
      abTicketCreate({
        targetRepo: tmp,
        title: 't',
        bodyFile,
        env: {},
        stdout: () => {},
      }),
    ).rejects.toThrow(/autobuild\.toml: not found/)
  })

  test('a config without [tickets] fails at the mandatory ready-state path', async () => {
    await writeFile(
      join(tmp, 'autobuild.toml'),
      '[project]\nbaseBranch = "main"\n',
    )
    const bodyFile = join(tmp, 'spec.md')
    await writeFile(bodyFile, '## What and why\n\nBecause.\n')

    await expect(
      abTicketCreate({
        targetRepo: tmp,
        title: 'Rate-limit auth',
        bodyFile,
        env: {},
        stdout: () => {},
      }),
    ).rejects.toThrow('tickets.readyState')
  })

  test('an explicit file source with no dir uses .autobuild/tickets', async () => {
    await writeRepo('[tickets]\nsource = "file"\n')
    const bodyFile = join(tmp, 'spec.md')
    await writeFile(bodyFile, '## What and why\n\nBecause.\n')
    const lines: string[] = []

    await abTicketCreate({
      targetRepo: tmp,
      title: 'Rate-limit auth',
      bodyFile,
      env: {},
      stdout: (line) => lines.push(line),
    })

    const path = join(tmp, '.autobuild', 'tickets', 'triage', 'file-1.md')
    expect(await readFile(path, 'utf8')).toContain('title = "Rate-limit auth"')
    expect(lines).toEqual(['ticket created: file:file-1 (Triage)'])
  })

  test('--blocked-by reaches the draft and the success line names the blockers', async () => {
    await writeRepo(FILE_TICKETS_TOML)
    const bodyFile = join(tmp, 'spec.md')
    await writeFile(bodyFile, 'body\n')
    const created: Parameters<typeof fakeFactory>[0] = {}
    const out: string[] = []

    await abTicketCreate({
      targetRepo: tmp,
      title: 'Dependent work',
      bodyFile,
      blockedBy: ['AUT-8', 'AUT-9'],
      env: {},
      stdout: (line) => out.push(line),
      sourceFactory: fakeFactory(created, ['AUT-8', 'AUT-9']),
    })

    expect(created.draft?.blockedBy).toEqual(['AUT-8', 'AUT-9'])
    expect(out).toEqual([
      'ticket created: fake:fake-1 (Triage) — blocked by AUT-8, AUT-9 — https://example.test/fake-1',
    ])
  })

  test('an unknown blocker is an actionable error and NO ticket is created', async () => {
    await writeRepo(FILE_TICKETS_TOML)
    const bodyFile = join(tmp, 'spec.md')
    await writeFile(bodyFile, 'body\n')
    const created: Parameters<typeof fakeFactory>[0] = {}

    await expect(
      abTicketCreate({
        targetRepo: tmp,
        title: 'Dependent work',
        bodyFile,
        blockedBy: ['AUT-8', 'AUT-99'],
        env: {},
        stdout: () => {},
        sourceFactory: fakeFactory(created, ['AUT-8']),
      }),
    ).rejects.toThrow(/--blocked-by: no ticket "AUT-99" in the configured fake/)
    // Validation precedes creation: nothing was filed.
    expect(created.draft).toBeUndefined()
  })

  test('duplicate blocker ids are deduped rather than rejected', async () => {
    await writeRepo(FILE_TICKETS_TOML)
    const bodyFile = join(tmp, 'spec.md')
    await writeFile(bodyFile, 'body\n')
    const created: Parameters<typeof fakeFactory>[0] = {}

    await abTicketCreate({
      targetRepo: tmp,
      title: 'Dependent work',
      bodyFile,
      blockedBy: ['AUT-8', 'AUT-8'],
      env: {},
      stdout: () => {},
      sourceFactory: fakeFactory(created, ['AUT-8']),
    })

    expect(created.draft?.blockedBy).toEqual(['AUT-8'])
  })

  test('with source = "file", --blocked-by records the blocker in TOML frontmatter', async () => {
    await writeRepo(FILE_TICKETS_TOML)
    const bodyFile = join(tmp, 'spec.md')
    await writeFile(bodyFile, 'blocker body\n')
    await abTicketCreate({
      targetRepo: tmp,
      title: 'Blocker',
      bodyFile,
      env: {},
      stdout: () => {},
    })

    const out: string[] = []
    await abTicketCreate({
      targetRepo: tmp,
      title: 'Dependent',
      bodyFile,
      blockedBy: ['file-1'],
      env: {},
      stdout: (line) => out.push(line),
    })

    expect(out).toEqual(['ticket created: file:file-2 (Triage) — blocked by file-1'])
    const written = await readFile(join(tmp, 'tickets', 'triage', 'file-2.md'), 'utf8')
    expect(written).toContain('blockedBy = [ "file-1" ]')
  })

  test('a missing body file is an error naming the path', async () => {
    await writeRepo(FILE_TICKETS_TOML)
    expect(
      abTicketCreate({
        targetRepo: tmp,
        title: 't',
        bodyFile: join(tmp, 'nope.md'),
        env: {},
        stdout: () => {},
      }),
    ).rejects.toThrow(/--body .*nope\.md: file not found/)
  })
})

describe('runCli — ticket routing', () => {
  function sessionlessDeps() {
    const out: string[] = []
    const err: string[] = []
    return {
      deps: {
        workspacePath: tmp,
        stdout: (line: string) => out.push(line),
        stderr: (line: string) => err.push(line),
      },
      out,
      err,
    }
  }

  test('ab ticket without create prints usage and exits 1', async () => {
    const { deps, err } = sessionlessDeps()
    expect(await runCli(['ticket'], deps)).toBe(1)
    expect(err.join('\n')).toContain('usage: ab ticket create')
  })

  test('ab ticket create without --body prints usage and exits 1', async () => {
    const { deps, err } = sessionlessDeps()
    expect(await runCli(['ticket', 'create', 'a', 'title'], deps)).toBe(1)
    expect(err.join('\n')).toContain('usage: ab ticket create')
  })

  test('ab ticket create runs sessionless — no AB_* deps required', async () => {
    await writeRepo(FILE_TICKETS_TOML)
    const bodyFile = join(tmp, 'spec.md')
    await writeFile(bodyFile, 'body\n')
    const { deps, out } = sessionlessDeps()
    expect(await runCli(['ticket', 'create', 'A', 'title', '--body', bodyFile], deps)).toBe(0)
    expect(out.join('\n')).toContain('ticket created: file:file-1')
  })

  test('--blocked-by parses comma-separated ids and reaches the source', async () => {
    await writeRepo(FILE_TICKETS_TOML)
    const bodyFile = join(tmp, 'spec.md')
    await writeFile(bodyFile, 'body\n')
    const { deps, out } = sessionlessDeps()
    expect(await runCli(['ticket', 'create', 'Blocker', '--body', bodyFile], deps)).toBe(0)
    expect(
      await runCli(
        ['ticket', 'create', 'Dependent', '--body', bodyFile, '--blocked-by', 'file-1'],
        deps,
      ),
    ).toBe(0)
    expect(out.join('\n')).toContain('ticket created: file:file-2 (Triage) — blocked by file-1')
  })

  test('an unknown --blocked-by id exits nonzero with the actionable error', async () => {
    await writeRepo(FILE_TICKETS_TOML)
    const bodyFile = join(tmp, 'spec.md')
    await writeFile(bodyFile, 'body\n')
    const { deps, err } = sessionlessDeps()
    expect(
      await runCli(
        ['ticket', 'create', 'Dependent', '--body', bodyFile, '--blocked-by', 'file-404'],
        deps,
      ),
    ).toBe(1)
    expect(err.join('\n')).toContain('--blocked-by: no ticket "file-404"')
  })
})
