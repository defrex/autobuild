/**
 * Source-agnostic `ab ticket` operations (SPEC §8.8): config selects the
 * adapter, secrets come from the process env, and errors are agent feedback
 * (D6) naming what would be accepted.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { TicketsConfig } from '../config/schema'
import { FakeTicketSource } from '../ports/tickets/fake'
import type {
  Ticket,
  TicketDraft,
  TicketListing,
  TicketSource,
  TicketUpdate,
} from '../ports/types'
import { runCli } from './main'
import {
  abTicketBlock,
  abTicketCreate,
  abTicketList,
  abTicketMove,
  abTicketShow,
  abTicketUnblock,
  abTicketUpdate,
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
    update?: { id: string; patch: TicketUpdate }
    blockerAdds?: Array<{ id: string; blockerId: string }>
    blockerRemovals?: Array<{ id: string; blockerId: string }>
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
      listReady: () => Promise.resolve({ tickets: [], diagnostics: [] }),
      get: () => Promise.resolve(null),
      claim: () => Promise.resolve(false),
      comment: () => Promise.resolve(),
      transition: () => Promise.resolve(),
      update: (id, patch) => {
        created.update = {
          id,
          patch: {
            ...(patch.title !== undefined ? { title: patch.title } : {}),
            ...(patch.body !== undefined ? { body: patch.body } : {}),
            ...(patch.labels !== undefined ? { labels: [...patch.labels] } : {}),
          },
        }
        return Promise.resolve()
      },
      addBlocker: (id, blockerId) => {
        ;(created.blockerAdds ??= []).push({ id, blockerId })
        return Promise.resolve()
      },
      removeBlocker: (id, blockerId) => {
        ;(created.blockerRemovals ??= []).push({ id, blockerId })
        return Promise.resolve()
      },
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
      'baseBranch = "main"\n',
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

describe('abTicket update/block/unblock', () => {
  test('update builds one partial patch from flags and prints a stable confirmation', async () => {
    await writeRepo(FILE_TICKETS_TOML)
    const bodyFile = join(tmp, 'replacement.md')
    await writeFile(bodyFile, 'replacement spec\n')
    const created: Parameters<typeof fakeFactory>[0] = {}
    const out: string[] = []

    await abTicketUpdate({
      targetRepo: tmp,
      id: 'AUT-7',
      title: 'Renamed ticket',
      bodyFile,
      labels: [],
      env: { LINEAR_API_KEY: 'secret' },
      stdout: (line) => out.push(line),
      sourceFactory: fakeFactory(created),
    })

    expect(created.update).toEqual({
      id: 'AUT-7',
      patch: {
        title: 'Renamed ticket',
        body: 'replacement spec\n',
        labels: [],
      },
    })
    expect(created.env).toEqual({ LINEAR_API_KEY: 'secret' })
    expect(out).toEqual(['ticket updated: fake:AUT-7'])
  })

  test('block and unblock preserve target/blocker ordering through the source', async () => {
    await writeRepo(FILE_TICKETS_TOML)
    const created: Parameters<typeof fakeFactory>[0] = {}
    const out: string[] = []
    const common = {
      targetRepo: tmp,
      id: 'AUT-9',
      blockerId: 'AUT-8',
      env: {},
      stdout: (line: string) => out.push(line),
      sourceFactory: fakeFactory(created),
    }

    await abTicketBlock(common)
    await abTicketUnblock(common)

    expect(created.blockerAdds).toEqual([{ id: 'AUT-9', blockerId: 'AUT-8' }])
    expect(created.blockerRemovals).toEqual([
      { id: 'AUT-9', blockerId: 'AUT-8' },
    ])
    expect(out).toEqual([
      'ticket blocker added: fake:AUT-9 — blocked by AUT-8',
      'ticket blocker removed: fake:AUT-9 — no longer blocked by AUT-8',
    ])
  })

  test('a missing update body file fails before constructing or mutating a source', async () => {
    await writeRepo(FILE_TICKETS_TOML)
    const created: Parameters<typeof fakeFactory>[0] = {}

    await expect(
      abTicketUpdate({
        targetRepo: tmp,
        id: 'AUT-7',
        bodyFile: join(tmp, 'missing.md'),
        env: {},
        stdout: () => {},
        sourceFactory: fakeFactory(created),
      }),
    ).rejects.toThrow(/--body .*missing\.md: file not found/)
    expect(created.config).toBeUndefined()
    expect(created.update).toBeUndefined()
  })
})

class CapturingTicketSource extends FakeTicketSource {
  readonly listCriteria: Array<{ labels?: string[]; state?: string }> = []
  readonly diagnostics: string[] = []

  override async listReady(criteria: {
    labels?: string[]
    state?: string
  }): Promise<TicketListing> {
    this.listCriteria.push({
      ...(criteria.labels !== undefined ? { labels: [...criteria.labels] } : {}),
      ...(criteria.state !== undefined ? { state: criteria.state } : {}),
    })
    const listing = await super.listReady(criteria)
    return { ...listing, diagnostics: [...this.diagnostics] }
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
        stderr: () => {},
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
      stderr: () => {},
      sourceFactory: () => labelsOnly,
    })
    expect(labelsOnly.listCriteria).toEqual([{ labels: ['security', 'api'] }])

    const stateOnly = new CapturingTicketSource()
    await abTicketList({
      targetRepo: tmp,
      state: 'Triage',
      env: {},
      stdout: () => {},
      stderr: () => {},
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
    const errors: string[] = []
    source.diagnostics.push(
      '/repo/tickets/done/notes.md: invalid frontmatter — title is required',
    )

    await abTicketList({
      targetRepo: tmp,
      labels: ['security', 'api'],
      json: true,
      env: {},
      stdout: (line) => out.push(line),
      stderr: (line) => errors.push(line),
      sourceFactory: () => source,
    })

    const parsed = JSON.parse(out.join('\n')) as Ticket[]
    expect(parsed.map((ticket) => ticket.ref.id)).toEqual(['AUT-1'])
    expect(errors).toEqual([
      '/repo/tickets/done/notes.md: invalid frontmatter — title is required',
    ])
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
      stderr: () => {},
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
      stderr: () => {},
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
      'ab ticket update',
      'ab ticket block',
      'ab ticket unblock',
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

  test('list routes malformed-record diagnostics to stderr while JSON stdout stays bare', async () => {
    await writeRepo(FILE_TICKETS_TOML)
    const bodyFile = join(tmp, 'spec.md')
    await writeFile(bodyFile, 'body\n')
    const { deps, out, err } = sessionlessDeps()
    await runCli(['ticket', 'create', 'Valid', '--body', bodyFile], deps)
    await runCli(['ticket', 'move', 'file-1', 'ready'], deps)
    const malformedPath = join(tmp, 'tickets', 'done', 'notes.md')
    await mkdir(join(tmp, 'tickets', 'done'), { recursive: true })
    await writeFile(malformedPath, '# not ticket frontmatter\n')

    expect(await runCli(['ticket', 'list', '--json'], deps)).toBe(0)

    expect((JSON.parse(out.at(-1)!) as Ticket[]).map((ticket) => ticket.ref.id)).toEqual([
      'file-1',
    ])
    expect(err).toContain(
      `${malformedPath}: malformed ticket file — missing opening "+++" fence`,
    )
  })

  test('update partially replaces a real file ticket and explicit empty labels clear', async () => {
    await writeRepo(FILE_TICKETS_TOML)
    const originalBody = join(tmp, 'original.md')
    const replacementBody = join(tmp, 'replacement.md')
    await writeFile(originalBody, 'original body\n')
    await writeFile(replacementBody, 'replacement body\n')
    const { deps, out } = sessionlessDeps()

    expect(
      await runCli(
        [
          'ticket',
          'create',
          'Original title',
          '--body',
          originalBody,
          '--labels',
          'bug,api',
        ],
        deps,
      ),
    ).toBe(0)
    expect(
      await runCli(
        [
          'ticket',
          'update',
          'file-1',
          '--title',
          'Renamed title',
          '--body',
          replacementBody,
        ],
        deps,
      ),
    ).toBe(0)

    const path = join(tmp, 'tickets', 'triage', 'file-1.md')
    let written = await readFile(path, 'utf8')
    expect(written).toContain('title = "Renamed title"')
    expect(written).toContain('labels = [ "bug", "api" ]')
    expect(written).toContain('replacement body')
    expect(written).not.toContain('original body')
    expect(written).not.toContain('state =')

    expect(
      await runCli(['ticket', 'update', 'file-1', '--labels', ''], deps),
    ).toBe(0)
    written = await readFile(path, 'utf8')
    expect(written).not.toContain('labels =')
    expect(written).toContain('replacement body')
    expect(out).toContain('ticket updated: file:file-1')
  })

  test('block/unblock are idempotent against the real configured file source', async () => {
    await writeRepo(FILE_TICKETS_TOML)
    const bodyFile = join(tmp, 'spec.md')
    await writeFile(bodyFile, 'body\n')
    const { deps, out } = sessionlessDeps()
    await runCli(['ticket', 'create', 'Blocker', '--body', bodyFile], deps)
    await runCli(['ticket', 'create', 'Dependent', '--body', bodyFile], deps)

    expect(
      await runCli(['ticket', 'block', 'file-2', 'file-1'], deps),
    ).toBe(0)
    expect(
      await runCli(['ticket', 'block', 'file-2', 'file-1'], deps),
    ).toBe(0)
    const path = join(tmp, 'tickets', 'triage', 'file-2.md')
    const blocked = await readFile(path, 'utf8')
    expect((blocked.match(/file-1/g) ?? [])).toHaveLength(1)

    expect(
      await runCli(['ticket', 'unblock', 'file-2', 'file-1'], deps),
    ).toBe(0)
    expect(
      await runCli(['ticket', 'unblock', 'file-2', 'file-404'], deps),
    ).toBe(0)
    expect(await readFile(path, 'utf8')).not.toContain('blockedBy')
    expect(out).toContain(
      'ticket blocker added: file:file-2 — blocked by file-1',
    )
    expect(out).toContain(
      'ticket blocker removed: file:file-2 — no longer blocked by file-1',
    )
  })

  test('new write failures name self, missing blocker, unknown target, and invalid fields', async () => {
    await writeRepo(FILE_TICKETS_TOML)
    const bodyFile = join(tmp, 'spec.md')
    await writeFile(bodyFile, 'body\n')
    const { deps, err } = sessionlessDeps()
    await runCli(['ticket', 'create', 'Target', '--body', bodyFile], deps)

    expect(
      await runCli(['ticket', 'block', 'file-1', 'file-1'], deps),
    ).toBe(1)
    expect(err.at(-1)).toContain('file-1')
    expect(
      await runCli(['ticket', 'block', 'file-1', 'file-404'], deps),
    ).toBe(1)
    expect(err.at(-1)).toContain('file-404')
    expect(
      await runCli(['ticket', 'update', 'file-404', '--title', 'New'], deps),
    ).toBe(1)
    expect(err.at(-1)).toContain('file-404')
    expect(
      await runCli(['ticket', 'update', 'file-1', '--title', '   '], deps),
    ).toBe(1)
    expect(err.at(-1)).toContain('title')
    expect(
      await readFile(join(tmp, 'tickets', 'triage', 'file-1.md'), 'utf8'),
    ).not.toContain('blockedBy')
  })

  test('update resolves an autobuild worktree cwd back to the main tracker', async () => {
    await writeRepo('[tickets]\nsource = "file"\n')
    const bodyFile = join(tmp, 'spec.md')
    await writeFile(bodyFile, 'body\n')
    const { deps } = sessionlessDeps()
    await runCli(['ticket', 'create', 'Original', '--body', bodyFile], deps)
    deps.workspacePath = join(tmp, 'linked-worktree')

    expect(
      await runCli(
        ['ticket', 'update', 'file-1', '--title', 'From worktree'],
        deps,
      ),
    ).toBe(0)
    expect(
      await readFile(
        join(tmp, '.autobuild', 'tickets', 'triage', 'file-1.md'),
        'utf8',
      ),
    ).toContain('title = "From worktree"')
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

  test('ticket subcommands share diagnostics without sharing flag vocabularies', async () => {
    const cases: Array<{ argv: string[]; diagnostic: string }> = [
      {
        argv: ['ticket', 'list', '--json', '--json'],
        diagnostic: '--json may be supplied only once',
      },
      {
        argv: ['ticket', 'create', 'Title', '--body', '--labels', 'api'],
        diagnostic: '--body requires a value, got "--labels"',
      },
      {
        argv: ['ticket', 'show', 'file-1', '--state', 'Ready'],
        diagnostic: 'unknown flag --state',
      },
      {
        argv: ['ticket', 'update', 'file-1', '--json'],
        diagnostic: 'unknown flag --json',
      },
      {
        argv: ['ticket', 'block', 'file-1', 'file-2', '--force'],
        diagnostic: 'unknown flag --force',
      },
    ]

    for (const { argv, diagnostic } of cases) {
      const { deps, err, out } = sessionlessDeps()
      expect(await runCli(argv, deps)).toBe(1)
      expect(err.join('\n')).toContain(diagnostic)
      expect(err.join('\n')).toContain('usage: ab ticket create')
      expect(err.join('\n')).toContain('usage: ab ticket move')
      expect(out).toEqual([])
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
      ['ticket', 'update', 'file-1'],
      ['ticket', 'update', 'file-1', '--title', 'x', 'extra'],
      ['ticket', 'update', 'file-1', '--state', 'Done'],
      ['ticket', 'block', 'file-1'],
      ['ticket', 'block', 'file-1', 'file-2', 'extra'],
      ['ticket', 'unblock', 'file-1', 'file-2', '--force'],
    ]
    for (const argv of cases) {
      const { deps, err, out } = sessionlessDeps()
      expect(await runCli(argv, deps)).toBe(1)
      const usage = err.join('\n')
      for (const form of [
        'ab ticket create',
        'ab ticket update',
        'ab ticket block',
        'ab ticket unblock',
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
