/**
 * Source-agnostic `ab ticket` operations (SPEC §8.8): config selects the
 * adapter, secrets come from the process env, and errors are agent feedback
 * (D6) naming what would be accepted.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { TicketsConfig } from '../config/schema'
import { FakeTicketSource } from '../ports/tickets/fake'
import type { Ticket, TicketDraft, TicketSource } from '../ports/types'
import { runCli } from './main'
import {
  abTicketCreate,
  abTicketList,
  abTicketMove,
  abTicketShow,
} from './ticket'

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

  test('AB_STORE relocates the default file tracker with local state', async () => {
    await writeRepo('[tickets]\nsource = "file"\n')
    const bodyFile = join(tmp, 'spec.md')
    await writeFile(bodyFile, 'body\n')

    await abTicketCreate({
      targetRepo: tmp,
      title: 'Alternate tracker',
      bodyFile,
      env: { AB_STORE: 'alternate-state' },
      stdout: () => {},
    })

    expect(
      await readFile(
        join(tmp, 'alternate-state', 'tickets', 'triage', 'file-1.md'),
        'utf8',
      ),
    ).toContain('title = "Alternate tracker"')
  })

  test('normalizes a linked-worktree cwd before resolving default file tickets', async () => {
    await writeRepo('[tickets]\nsource = "file"\n')
    const bodyFile = join(tmp, 'spec.md')
    await writeFile(bodyFile, 'body\n')

    await abTicketCreate({
      targetRepo: join(tmp, 'linked-worktree'),
      exec: async () => ({
        stdout: `${join(tmp, '.git')}\n${join(tmp, '.git')}\n${tmp}\n`,
        stderr: '',
        exitCode: 0,
      }),
      title: 'Main tracker only',
      bodyFile,
      env: {},
      stdout: () => {},
    })

    expect(
      await readFile(join(tmp, '.autobuild', 'tickets', 'triage', 'file-1.md'), 'utf8'),
    ).toContain('title = "Main tracker only"')
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

class CapturingTicketSource extends FakeTicketSource {
  readonly listCriteria: Array<{ labels?: string[]; state?: string }> = []

  override async listReady(criteria: {
    labels?: string[]
    state?: string
  }): Promise<Ticket[]> {
    this.listCriteria.push({
      ...(criteria.labels !== undefined ? { labels: [...criteria.labels] } : {}),
      ...(criteria.state !== undefined ? { state: criteria.state } : {}),
    })
    return super.listReady(criteria)
  }
}

function seededTicket(overrides: Partial<Ticket> = {}): Ticket {
  return {
    ref: { source: 'fake', id: 'AUT-1', url: 'https://example.test/AUT-1' },
    title: 'Throttle repeated logins',
    body: '## What and why\n\nProtect accounts.\n',
    state: 'Ready',
    labels: ['security', 'api'],
    blockedBy: ['AUT-0'],
    ...overrides,
  }
}

describe('abTicketList', () => {
  test('an unfiltered list uses the dispatcher defaults for file and Linear', async () => {
    const cases = [
      {
        config: '[tickets]\nsource = "file"\nreadyState = "ready"\n',
        expected: { labels: [], state: 'ready' },
      },
      {
        config:
          '[tickets]\nsource = "linear"\nteamKey = "AUT"\nreadyState = "Todo"\n',
        expected: { labels: ['autobuild'], state: 'Todo' },
      },
    ]

    for (const { config, expected } of cases) {
      await writeRepo(config)
      const source = new CapturingTicketSource()
      await abTicketList({
        targetRepo: tmp,
        env: {},
        stdout: () => {},
        sourceFactory: () => source,
      })
      expect(source.listCriteria).toEqual([expected])
    }
  })

  test('explicit filters forward only the criteria the caller supplied', async () => {
    await writeRepo(FILE_TICKETS_TOML)

    const labelsOnly = new CapturingTicketSource()
    await abTicketList({
      targetRepo: tmp,
      labels: ['security', 'api'],
      env: {},
      stdout: () => {},
      sourceFactory: () => labelsOnly,
    })
    expect(labelsOnly.listCriteria).toEqual([{ labels: ['security', 'api'] }])

    const stateOnly = new CapturingTicketSource()
    await abTicketList({
      targetRepo: tmp,
      state: 'Triage',
      env: {},
      stdout: () => {},
      sourceFactory: () => stateOnly,
    })
    expect(stateOnly.listCriteria).toEqual([{ state: 'Triage' }])
  })

  test('labels retain the port all-match semantics and JSON is a bare Ticket array', async () => {
    await writeRepo(FILE_TICKETS_TOML)
    const source = new CapturingTicketSource([
      seededTicket(),
      seededTicket({
        ref: { source: 'fake', id: 'AUT-2' },
        title: 'Only security',
        labels: ['security'],
      }),
    ])
    const out: string[] = []

    await abTicketList({
      targetRepo: tmp,
      labels: ['security', 'api'],
      json: true,
      env: {},
      stdout: (line) => out.push(line),
      sourceFactory: () => source,
    })

    const parsed = JSON.parse(out.join('\n')) as Ticket[]
    expect(parsed.map((ticket) => ticket.ref.id)).toEqual(['AUT-1'])
    expect(source.listCriteria).toEqual([{ labels: ['security', 'api'] }])
  })

  test('human output is compact and an empty result is explicit', async () => {
    await writeRepo(FILE_TICKETS_TOML)
    const out: string[] = []
    await abTicketList({
      targetRepo: tmp,
      state: 'Ready',
      env: {},
      stdout: (line) => out.push(line),
      sourceFactory: () => new FakeTicketSource([seededTicket()]),
    })
    expect(out).toHaveLength(1)
    expect(out[0]).toContain('fake:AUT-1 (Ready) — Throttle repeated logins')
    expect(out[0]).toContain('labels: security, api')
    expect(out[0]).toContain('blocked by: AUT-0')
    expect(out[0]).toContain('https://example.test/AUT-1')

    const empty: string[] = []
    await abTicketList({
      targetRepo: tmp,
      env: {},
      stdout: (line) => empty.push(line),
      sourceFactory: () => new FakeTicketSource(),
    })
    expect(empty).toEqual([
      'no tickets matched in the configured fake ticket source',
    ])
  })
})

describe('abTicketShow', () => {
  test('human output includes metadata and preserves the multiline body exactly', async () => {
    await writeRepo(FILE_TICKETS_TOML)
    const body = 'first line\n\nlast line\n'
    const out: string[] = []
    await abTicketShow({
      targetRepo: tmp,
      id: 'AUT-1',
      env: {},
      stdout: (line) => out.push(line),
      sourceFactory: () =>
        new FakeTicketSource([seededTicket({ body })]),
    })

    expect(out.slice(0, -1).join('\n')).toContain('ticket fake:AUT-1')
    expect(out.slice(0, -1).join('\n')).toContain('blocked by: AUT-0')
    expect(out.slice(0, -1).join('\n')).toContain('url:     https://example.test/AUT-1')
    expect(out.at(-1)).toBe(body)
  })

  test('JSON is the complete Ticket and an unknown id names the source and id', async () => {
    await writeRepo(FILE_TICKETS_TOML)
    const ticket = seededTicket()
    const out: string[] = []
    await abTicketShow({
      targetRepo: tmp,
      id: ticket.ref.id,
      json: true,
      env: {},
      stdout: (line) => out.push(line),
      sourceFactory: () => new FakeTicketSource([ticket]),
    })
    expect(JSON.parse(out.join('\n'))).toEqual(ticket)

    await expect(
      abTicketShow({
        targetRepo: tmp,
        id: 'AUT-404',
        env: {},
        stdout: () => {},
        sourceFactory: () => new FakeTicketSource(),
      }),
    ).rejects.toThrow('no ticket "AUT-404" in the configured fake ticket source')
  })
})

describe('abTicketMove', () => {
  test('the real file source moves without rewriting, canonicalizes state, and emits post-move JSON', async () => {
    await writeRepo(FILE_TICKETS_TOML)
    const bodyFile = join(tmp, 'spec.md')
    await writeFile(bodyFile, 'line one\n\nline two\n')
    await abTicketCreate({
      targetRepo: tmp,
      title: 'Move without rewriting',
      bodyFile,
      labels: ['api'],
      env: {},
      stdout: () => {},
    })
    const triagePath = join(tmp, 'tickets', 'triage', 'file-1.md')
    const readyPath = join(tmp, 'tickets', 'ready', 'file-1.md')
    const rawBefore = await readFile(triagePath, 'utf8')
    const human: string[] = []

    await abTicketMove({
      targetRepo: tmp,
      id: 'file-1',
      state: 'ready',
      env: {},
      stdout: (line) => human.push(line),
    })

    expect(existsSync(triagePath)).toBe(false)
    expect(await readFile(readyPath, 'utf8')).toBe(rawBefore)
    expect(human).toEqual([
      'ticket moved: file:file-1 (Ready) — Move without rewriting — labels: api',
    ])

    const json: string[] = []
    await abTicketMove({
      targetRepo: tmp,
      id: 'file-1',
      state: 'doing',
      json: true,
      env: {},
      stdout: (line) => json.push(line),
    })
    const moved = JSON.parse(json.join('\n')) as Ticket
    expect(moved.state).toBe('Doing')
    expect(moved.body).toBe('line one\n\nline two\n')
  })

  test('unknown ids and invalid states fail with adapter-aware messages', async () => {
    await writeRepo(FILE_TICKETS_TOML)
    await expect(
      abTicketMove({
        targetRepo: tmp,
        id: 'file-404',
        state: 'Ready',
        env: {},
        stdout: () => {},
      }),
    ).rejects.toThrow('no ticket "file-404" in the configured file ticket source')

    const bodyFile = join(tmp, 'spec.md')
    await writeFile(bodyFile, 'body\n')
    await abTicketCreate({
      targetRepo: tmp,
      title: 'Known ticket',
      bodyFile,
      env: {},
      stdout: () => {},
    })
    await expect(
      abTicketMove({
        targetRepo: tmp,
        id: 'file-1',
        state: 'Review',
        env: {},
        stdout: () => {},
      }),
    ).rejects.toThrow(
      'unknown state "Review" — this tracker\'s states are the directories: Triage, Ready, Doing, Done',
    )
  })
})

describe('runCli — ticket routing', () => {
  function sessionlessDeps() {
    const out: string[] = []
    const err: string[] = []
    return {
      deps: {
        workspacePath: tmp,
        exec: async () => ({
          stdout: `${join(tmp, '.git')}\n${join(tmp, '.git')}\n${tmp}\n`,
          stderr: '',
          exitCode: 0,
        }),
        stdout: (line: string) => out.push(line),
        stderr: (line: string) => err.push(line),
      },
      out,
      err,
    }
  }

  test('ab ticket without a subcommand prints the complete usage and exits 1', async () => {
    const { deps, err } = sessionlessDeps()
    expect(await runCli(['ticket'], deps)).toBe(1)
    const usage = err.join('\n')
    for (const form of [
      'ab ticket create',
      'ab ticket list',
      'ab ticket show',
      'ab ticket move',
    ]) {
      expect(usage).toContain(form)
    }
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

  test('routes list, show, and move with human and JSON output', async () => {
    await writeRepo(FILE_TICKETS_TOML)
    const bodyFile = join(tmp, 'spec.md')
    await writeFile(bodyFile, 'the exact body\n')
    const { deps, out } = sessionlessDeps()
    expect(
      await runCli(
        ['ticket', 'create', 'Portable', 'operations', '--body', bodyFile, '--labels', 'api,cli'],
        deps,
      ),
    ).toBe(0)

    expect(await runCli(['ticket', 'list', '--json'], deps)).toBe(0)
    expect(JSON.parse(out.at(-1)!)).toEqual([])

    expect(await runCli(['ticket', 'move', 'file-1', 'ready'], deps)).toBe(0)
    expect(out.at(-1)).toContain('file:file-1 (Ready)')

    expect(await runCli(['ticket', 'list', '--labels', 'api,cli', '--json'], deps)).toBe(0)
    expect((JSON.parse(out.at(-1)!) as Ticket[])[0]?.ref.id).toBe('file-1')

    expect(await runCli(['ticket', 'show', 'file-1', '--json'], deps)).toBe(0)
    expect((JSON.parse(out.at(-1)!) as Ticket).body).toBe('the exact body\n')

    expect(await runCli(['ticket', 'move', 'file-1', 'done', '--json'], deps)).toBe(0)
    expect((JSON.parse(out.at(-1)!) as Ticket).state).toBe('Done')
  })

  test('unknown ticket ids exit nonzero and name the id', async () => {
    await writeRepo(FILE_TICKETS_TOML)
    for (const argv of [
      ['ticket', 'show', 'file-404'],
      ['ticket', 'move', 'file-404', 'Ready'],
    ]) {
      const { deps, err } = sessionlessDeps()
      expect(await runCli(argv, deps)).toBe(1)
      expect(err.join('\n')).toContain('file-404')
      expect(err.join('\n')).toContain('configured file ticket source')
    }
  })

  test('malformed argv and unknown subcommands print every ticket form', async () => {
    const cases = [
      ['ticket', 'frobnicate'],
      ['ticket', 'list', 'extra'],
      ['ticket', 'list', '--state'],
      ['ticket', 'list', '--state', '--json'],
      ['ticket', 'list', '--json', '--json'],
      ['ticket', 'show'],
      ['ticket', 'show', 'one', 'two'],
      ['ticket', 'move', 'file-1'],
      ['ticket', 'move', 'file-1', 'Ready', 'extra'],
      ['ticket', 'show', 'file-1', '--state', 'Ready'],
    ]
    for (const argv of cases) {
      const { deps, err, out } = sessionlessDeps()
      expect(await runCli(argv, deps)).toBe(1)
      const usage = err.join('\n')
      for (const form of [
        'ab ticket create',
        'ab ticket list',
        'ab ticket show',
        'ab ticket move',
      ]) {
        expect(usage).toContain(form)
      }
      expect(out).toEqual([])
    }
  })
})
