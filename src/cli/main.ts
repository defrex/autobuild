/**
 * `ab` — the only channel between agents and the store, and the enforcement
 * point of the entire ontology (SPEC §8). This module is pure routing: every
 * dependency is injected via CliDeps, so the whole surface is testable over
 * fakes; wiring real deps (resolved env, resolved store, real forge, real
 * exec, random ids) is `src/cli/binary.ts`'s job.
 *
 * Errors go to stderr with exit code 1, formatted as agent feedback (D6):
 * what was wrong and what would be accepted, so the in-session correction
 * loop is immediate and cheap.
 */
import type { Clock } from '../store/types'
import type { BuildStore } from '../store/types'
import { textContent } from '../store/types'
import type { Forge } from '../ports/types'
import type { Exec } from '../ports/workspace/git-worktree'
import type { IdSource } from '../ids'
import { artifactGet, artifactPut } from './artifact'
import {
  abBuildControl,
  type BuildControlAction,
  type BuildControlResult,
} from './build-control'
import { buildContext, type ContextManifest } from './context'
import { abDispatch } from './dispatch'
import type { DashboardRendererResolver } from './dashboard/render'
import type { TerminalInput, TerminalOut } from './terminal'
import type { CliEnv, HarvestCliEnv } from './env'
import { abInit } from './init'
import { abModels } from './models'
import { observe } from './observe'
import { ServerControl } from './server-control'
import { abBuilds, abBuildStatus } from './status'
import { done, escalate, verdict } from './terminals'
import {
  abTicketCreate,
  abTicketList,
  abTicketMove,
  abTicketShow,
} from './ticket'
import { abUpgrade } from './upgrade'
import {
  abHarvestStatus,
  buildHarvestContext,
  submitHarvestProposals,
  submitHarvestVerdict,
  type HarvestCliDeps,
} from './harvest'

/**
 * Commands that run OUTSIDE phase sessions (§16.3, §8.8, §3.3). Repository
 * commands resolve the cwd; durable controls additionally take a target build
 * slug. None requires the ambient AB_* phase tuple.
 *
 * `src/cli/binary.ts` routes on this set: a command absent from it goes through
 * `resolveCliEnv`, which REQUIRES AB_STORE/AB_BUILD/AB_PHASE/AB_SESSION and
 * exits 1 before routing. It lives here, beside the `switch` that implements
 * these commands, so the next sessionless command has one obvious place to
 * register — and so the list is unit-testable, which a literal inside the
 * binary is not.
 */
export const SESSIONLESS_COMMANDS = new Set([
  'init',
  'upgrade',
  'ticket',
  'dispatch',
  'builds',
  'build',
  'pause',
  'resume',
  'auto-merge',
  'answer',
  'abort',
  'models',
  'help',
  '--help',
  '-h',
])

export interface CliDeps {
  store: BuildStore
  /** Resolved ambient auth (D8) — see resolveCliEnv (src/cli/env.ts). */
  env: CliEnv
  workspacePath: string
  forge: Forge
  exec: Exec
  ids: IdSource
  clock: Clock
  stdout: (line: string) => void
  stderr: (line: string) => void
}

/**
 * What `runCli` minimally needs. `ab init` and `ab upgrade` run OUTSIDE
 * build sessions (§16.3) — they take a repo path, not a build, and must
 * work with no AB_* environment — so the session surface is optional here;
 * session commands demand it via requireSession. Full CliDeps satisfies
 * this structurally, so wired-up callers are unchanged.
 */
export interface SessionlessCliDeps {
  /** For init/upgrade this is just the cwd — the default target repo. */
  workspacePath: string
  stdout: (line: string) => void
  stderr: (line: string) => void
  /** Raw process environment for sessionless store selection, operator
   * provenance/self-control checks, and adapter secrets; distinct from `env`,
   * the resolved phase-session tuple. */
  processEnv?: Record<string, string | undefined>
  /** Stop signal for long-running sessionless commands (`ab dispatch`'s watch
   * loop); the binary aborts it on SIGINT. */
  signal?: AbortSignal
  /** Interactive output seam for `ab dispatch`'s dashboard (§14). Absent ⇒
   * non-interactive ⇒ plain, line-oriented output. */
  terminal?: TerminalOut
  /** Raw keyboard seam for the interactive dispatch dashboard. */
  input?: TerminalInput
  /** Optional per-paint presentation lookup used only by the repo-local dev
   * entry. The published binary never supplies it. */
  resolveDashboardRenderer?: DashboardRendererResolver
  store?: BuildStore
  env?: CliEnv
  harvestEnv?: HarvestCliEnv
  forge?: Forge
  exec?: Exec
  ids?: IdSource
  clock?: Clock
}

/** Narrow to full session deps, or fail with agent feedback (D6). */
function requireHarvestSession(
  command: string,
  deps: SessionlessCliDeps,
): HarvestCliDeps {
  const { store, harvestEnv: env, ids } = deps
  if (store === undefined || env === undefined || ids === undefined) {
    throw new Error(
      `'ab harvest ${command}' runs inside a harvest agent session — the ` +
        'runner sets AB_STORE, AB_REPO, AB_HARVEST, AB_PHASE, and AB_SESSION.',
    )
  }
  return { store, env, ids, workspacePath: deps.workspacePath }
}

function requireSession(command: string, deps: SessionlessCliDeps): CliDeps {
  const { store, env, forge, exec, ids, clock } = deps
  if (
    store === undefined ||
    env === undefined ||
    forge === undefined ||
    exec === undefined ||
    ids === undefined ||
    clock === undefined
  ) {
    throw new Error(
      `'ab ${command}' runs inside a build session — the runner sets AB_STORE, ` +
        'AB_BUILD, AB_PHASE, AB_SESSION for every session (SPEC §8.1, D8). ' +
        'Use `ab help` for commands that run sessionless.',
    )
  }
  return { ...deps, store, env, forge, exec, ids, clock }
}

/** The §8.2 command surface, verbatim enough to be the agent's cheat sheet. */
const HELP = [
  'ab — the agent↔store channel (SPEC §8.2)',
  '',
  '  ab context [--json]                    hydrate .ab/ with the phase\'s inputs; print the manifest',
  '  ab artifact put <kind> <file>          deposit a versioned artifact → prints the assigned rev',
  '  ab artifact get <kind>[@rev]           fetch an artifact within own build (latest when @rev omitted)',
  '  ab observe --kind <followup|refactor|latent-bug> [--files a,b] [--refs x,y] <summary>',
  '                                         structured observation — any phase, any time, not a terminal',
  '  ab server <start|stop|restart|status|logs> [n]',
  '                                         dev-server lifecycle, config-driven (§16.2); implement/verify only',
  '  ab done [--notes <file>]               complete a producer phase (TERMINAL: validates, then runs plumbing)',
  '  ab verdict <approve|revise|escalate|pass|fail|skip> [--findings <json>] [--notes <file>] [--reason <text>] [--report <file>]',
  '                                         complete a review/verify phase (TERMINAL; vocabulary is phase-dependent)',
  '  ab escalate <question> [--refs a,b]    park the build for human input (TERMINAL)',
  '',
  '  ab init [target] [--force]             vendor the default skills into a repo as ab-* + autobuild.toml (§16.3; runs outside sessions)',
  '  ab upgrade [target]                    three-way merge vendored ab-* skills with the new defaults (§16.3; runs outside sessions)',
  '  ab ticket create <title> --body <file> [--labels a,b] [--blocked-by id,id]',
  '                                         file a ticket to the configured [tickets] source (§8.8; runs outside sessions).',
  '  ab ticket list [--state <state>] [--labels a,b] [--json]',
  '                                         list tickets; with no filters, use the same ready criteria as dispatch.',
  '  ab ticket show <id> [--json]           show one ticket, including its body/spec.',
  '  ab ticket move <id> <state> [--json]   move one ticket to a source-local state.',
  '                                         Ticket reads/moves use human output by default; --json emits the complete Ticket value.',
  '                                         --blocked-by takes comma-separated ticket ids from that same source',
  '                                         (e.g. AUT-8 for linear, file-1 for file); dispatch waits for all of them.',
  '                                         State names and unknown-id errors come from the configured source.',
  '  ab dispatch [--once] [--interval <s>] [--store <ref>] [--plain] [--intake | --no-intake] [--auto-merge | --no-auto-merge]',
  '                                         run the outer loop for this repo — resume current builds, janitor, lease sweep, dispatch (§3.3, §12; runs outside sessions)',
  '                                         --auto-merge seeds durable intent on newly claimed builds only (default off); opposite flag forms cannot be combined',
  '                                         an interactive terminal gets a fixed global/harvest/build dashboard; TTY controls: Up/Down select, p toggles intake on the global row',
  '                                         or pauses/resumes the selected Harvest/build; m toggles the claim-time default on global or durable intent on a build; Ctrl-C stops;',
  '                                         blocked feedback: Enter submits (empty = retry), Esc cancels; the bottom controls list only keys active for the selection; --plain forces line-oriented output',
  '                                         (also automatic when stdout is not a TTY)',
  '  ab models [query] [--available]        list Pi\'s model catalog (filtered by query) to find a provider-qualified id for autobuild.toml (§9; runs outside sessions)',
  '  ab builds [--queued] [--all] [--json] [--store <ref>]',
  '                                         list this repo\'s builds — default: running, paused, blocked; --queued adds queued;',
  '                                         --all every status (§15.5; read-only, runs outside sessions)',
  '  ab build status <slug> [--events <n>] [--json] [--store <ref>]',
  '                                         detailed state for one build — escalations, sessions, verify, PR, lease;',
  '                                         --events <n> appends the newest n events (read-only, runs outside sessions)',
  '  ab pause <slug> [--store <ref>]        request that an active build pause (sessionless)',
  '  ab resume <slug> [--store <ref>]       request that an active build resume (sessionless)',
  '  ab auto-merge <slug> <on|off> [--store <ref>]',
  '                                         request or cancel native squash auto-merge (sessionless)',
  '  ab answer <slug> [<text>] [--store <ref>]',
  '                                         answer every open escalation: guidance with text, bare retry without; resumes a paused build last (sessionless)',
  '  ab abort <slug> [--store <ref>]        request that an active build abort (sessionless)',
  '  ab harvest status [--events <n>] [--json] [--store <ref>]',
  '                                         latest repository harvest workflow and paper trail (read-only)',
  '  ab harvest context [--json]            hydrate harvest session inputs',
  '  ab harvest submit <proposals.json>     synthesize terminal: validate and deposit proposals',
  '  ab harvest verdict <approve|revise|escalate> --notes <file> [--findings <json>] [--reason <text>]',
  '                                         harvest-review terminal',
  '',
  'Every phase ends with exactly one terminal command (D5).',
].join('\n')

const VALUE_FLAGS = new Set(['kind', 'files', 'refs', 'notes', 'findings', 'reason', 'report'])
const BOOLEAN_FLAGS = new Set(['json'])

interface ParsedArgs {
  positionals: string[]
  flags: Map<string, string | true>
}

function parseArgs(args: string[]): ParsedArgs {
  const positionals: string[] = []
  const flags = new Map<string, string | true>()
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]!
    if (!arg.startsWith('--')) {
      positionals.push(arg)
      continue
    }
    const name = arg.slice(2)
    if (BOOLEAN_FLAGS.has(name)) {
      flags.set(name, true)
      continue
    }
    if (!VALUE_FLAGS.has(name)) {
      throw new Error(
        `unknown flag --${name} — known flags: ${[...VALUE_FLAGS].map((f) => `--${f}`).join(', ')}, --json`,
      )
    }
    const value = args[i + 1]
    if (value === undefined) {
      throw new Error(`--${name} requires a value`)
    }
    flags.set(name, value)
    i += 1
  }
  return { positionals, flags }
}

/**
 * The value after a value-taking flag in a hand-rolled parser — present, and
 * not itself a flag.
 *
 * The second check is the one that matters: without it `--store --json`
 * consumes `--json` as the store REFERENCE, and a local ref is created on
 * demand (openLocalStore mkdirs it), so the command silently builds a store in
 * a directory named `--json`, prints human text to a caller that asked for
 * JSON, and exits 0. A plausible-looking wrong answer, which is exactly what
 * the "invalid argument produces an actionable error and a nonzero exit code"
 * rule exists to prevent.
 */
function flagValue(value: string | undefined, name: string, usage: string): string {
  if (value === undefined || value.startsWith('--')) {
    throw new Error(
      `--${name} requires a value${value !== undefined ? `, got "${value}"` : ''} — ${usage}`,
    )
  }
  return value
}

const TICKET_USAGE = [
  'usage: ab ticket create <title> --body <file> [--labels a,b] [--blocked-by id,id]',
  '       ab ticket list [--state <state>] [--labels a,b] [--json]',
  '       ab ticket show <id> [--json]',
  '       ab ticket move <id> <state> [--json]',
].join('\n')

type TicketFlagKind = 'value' | 'boolean'

/** Ticket flags are local to the namespace: strict, duplicate-free, and never
 * admitted into the phase-command parser's global flag vocabulary. */
function parseTicketArgs(
  args: string[],
  allowed: Readonly<Record<string, TicketFlagKind>>,
): ParsedArgs {
  const positionals: string[] = []
  const flags = new Map<string, string | true>()
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]!
    if (!arg.startsWith('--')) {
      positionals.push(arg)
      continue
    }
    const name = arg.slice(2)
    const kind = allowed[name]
    if (kind === undefined) {
      throw new Error(`unknown argument "${arg}" — ${TICKET_USAGE}`)
    }
    if (flags.has(name)) {
      throw new Error(`--${name} may be supplied only once — ${TICKET_USAGE}`)
    }
    if (kind === 'boolean') {
      flags.set(name, true)
      continue
    }
    flags.set(name, flagValue(args[(i += 1)], name, TICKET_USAGE))
  }
  return { positionals, flags }
}

interface ParsedBuildControlArgs {
  positionals: string[]
  storeRef?: string
}

/** New operator commands parse --store locally so it cannot leak into the
 * phase-command flag vocabulary. */
function parseBuildControlArgs(
  args: string[],
  usage: string,
): ParsedBuildControlArgs {
  const positionals: string[] = []
  let storeRef: string | undefined
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]!
    if (arg === '--store') {
      if (storeRef !== undefined) {
        throw new Error(`--store may be supplied only once — ${usage}`)
      }
      storeRef = flagValue(args[(i += 1)], 'store', usage)
    } else if (arg.startsWith('--')) {
      throw new Error(`unknown argument "${arg}" — ${usage}`)
    } else {
      positionals.push(arg)
    }
  }
  return {
    positionals,
    ...(storeRef !== undefined ? { storeRef } : {}),
  }
}

function buildControlConfirmation(result: BuildControlResult): string {
  switch (result.kind) {
    case 'command': {
      const outcome: Record<typeof result.command, string> = {
        pause: 'pause requested',
        resume: 'resume requested',
        abort: 'abort requested',
        'auto-merge-on': 'auto-merge requested',
        'auto-merge-off': 'auto-merge cancelled',
      }
      return `build ${result.slug}: ${outcome[result.command]}`
    }
    case 'answered':
      return (
        `build ${result.slug}: answered ${result.count} open escalation${
          result.count === 1 ? '' : 's'
        } with ${result.resolution}` +
        (result.resumed ? '; resume requested' : '')
      )
    case 'answer-required':
      throw new Error(
        'build-control requested interactive feedback for an explicit CLI command',
      )
  }
}

async function runBuildControl(
  deps: SessionlessCliDeps,
  slug: string,
  action: BuildControlAction,
  storeRef?: string,
): Promise<void> {
  if (deps.exec === undefined) {
    throw new Error(
      "build-control commands need an exec seam — this is a wiring bug in the ab binary",
    )
  }
  const result = await abBuildControl({
    targetRepo: deps.workspacePath,
    env: deps.processEnv ?? {},
    exec: deps.exec,
    slug,
    action,
    ...(storeRef !== undefined ? { storeRef } : {}),
  })
  deps.stdout(buildControlConfirmation(result))
}

function stringFlag(parsed: ParsedArgs, name: string): string | undefined {
  const value = parsed.flags.get(name)
  return typeof value === 'string' ? value : undefined
}

function listFlag(parsed: ParsedArgs, name: string): string[] | undefined {
  const value = stringFlag(parsed, name)
  if (value === undefined) return undefined
  return value
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '')
}

function renderManifest(manifest: ContextManifest): string[] {
  const lines = [
    `context materialized for ${manifest.build} — ${manifest.phase}@${manifest.round}`,
    `required deposits: ${manifest.required.join(', ') || '(none)'}`,
    `allowed terminals: ${manifest.allowedTerminals.join(', ')}`,
  ]
  if (manifest.commitRange !== undefined) {
    lines.push(`commit range: ${manifest.commitRange.base}..${manifest.commitRange.head}`)
  }
  if (manifest.conflict !== undefined) {
    lines.push(`conflict baseSha: ${manifest.conflict.baseSha}`)
  }
  if (manifest.step !== undefined) {
    lines.push(`verify step: ${manifest.step.name} (kind ${manifest.step.config.kind})`)
  }
  lines.push('.ab/ files:')
  const entries = Object.entries(manifest.materialized)
  if (entries.length === 0) {
    lines.push('  (none)')
  }
  for (const [relPath, source] of entries) {
    lines.push(
      `  ${relPath} — ${source === 'derived' ? 'derived' : `${source.kind}@${source.rev}`}`,
    )
  }
  return lines
}

export async function runCli(argv: string[], deps: SessionlessCliDeps): Promise<number> {
  try {
    return await dispatch(argv, deps)
  } catch (error) {
    deps.stderr(error instanceof Error ? error.message : String(error))
    return 1
  }
}

async function dispatch(argv: string[], deps: SessionlessCliDeps): Promise<number> {
  const [command, ...rest] = argv
  const { stdout, stderr } = deps

  switch (command) {
    case undefined: {
      stderr(HELP)
      return 1
    }

    case 'help':
    case '--help':
    case '-h': {
      stdout(HELP)
      return 0
    }

    // init and upgrade run OUTSIDE build sessions (§16.3): they operate on a
    // repo, not a build, so they route before any store/env requirement.
    case 'init': {
      let force = false
      const positionals: string[] = []
      for (const arg of rest) {
        if (arg === '--force') {
          force = true
          continue
        }
        if (arg.startsWith('--')) {
          throw new Error(`unknown flag ${arg} — usage: ab init [target] [--force] (§16.3)`)
        }
        positionals.push(arg)
      }
      if (positionals.length > 1) {
        throw new Error('usage: ab init [target] [--force] (§16.3)')
      }
      await abInit({ targetRepo: positionals[0] ?? deps.workspacePath, force, stdout })
      return 0
    }

    case 'upgrade': {
      const [target, ...extra] = rest
      if (extra.length > 0 || target?.startsWith('--') === true) {
        throw new Error('usage: ab upgrade [target] (§16.3)')
      }
      await abUpgrade({
        targetRepo: target ?? deps.workspacePath,
        stdout,
        ...(deps.exec !== undefined ? { exec: deps.exec } : {}),
      })
      return 0
    }

    // Ticket operations run OUTSIDE build sessions (§8.8): they resolve the
    // configured source for this repo before any build exists.
    case 'ticket': {
      const [sub, ...more] = rest
      if (sub === undefined) throw new Error(TICKET_USAGE)
      const needExec = (): Exec => {
        if (deps.exec === undefined) {
          throw new Error(
            `'ab ticket ${sub}' needs an exec seam — this is a wiring bug in the ab binary`,
          )
        }
        return deps.exec
      }
      const base = {
        targetRepo: deps.workspacePath,
        env: deps.processEnv ?? {},
        stdout,
      }

      switch (sub) {
        case 'create': {
          const parsed = parseTicketArgs(more, {
            body: 'value',
            labels: 'value',
            'blocked-by': 'value',
          })
          const title = parsed.positionals.join(' ')
          const bodyFile = stringFlag(parsed, 'body')
          if (title.trim() === '' || bodyFile === undefined || bodyFile.trim() === '') {
            throw new Error(TICKET_USAGE)
          }
          const labels = listFlag(parsed, 'labels')
          const blockedBy = listFlag(parsed, 'blocked-by')
          await abTicketCreate({
            ...base,
            title,
            bodyFile,
            ...(labels !== undefined ? { labels } : {}),
            ...(blockedBy !== undefined ? { blockedBy } : {}),
            exec: needExec(),
          })
          return 0
        }

        case 'list': {
          const parsed = parseTicketArgs(more, {
            state: 'value',
            labels: 'value',
            json: 'boolean',
          })
          if (parsed.positionals.length !== 0) throw new Error(TICKET_USAGE)
          const state = stringFlag(parsed, 'state')
          if (state !== undefined && state.trim() === '') throw new Error(TICKET_USAGE)
          const labels = listFlag(parsed, 'labels')
          await abTicketList({
            ...base,
            ...(state !== undefined ? { state } : {}),
            ...(labels !== undefined ? { labels } : {}),
            json: parsed.flags.has('json'),
            exec: needExec(),
          })
          return 0
        }

        case 'show': {
          const parsed = parseTicketArgs(more, { json: 'boolean' })
          if (
            parsed.positionals.length !== 1 ||
            parsed.positionals[0]!.trim() === ''
          ) {
            throw new Error(TICKET_USAGE)
          }
          await abTicketShow({
            ...base,
            id: parsed.positionals[0]!,
            json: parsed.flags.has('json'),
            exec: needExec(),
          })
          return 0
        }

        case 'move': {
          const parsed = parseTicketArgs(more, { json: 'boolean' })
          if (
            parsed.positionals.length !== 2 ||
            parsed.positionals.some((value) => value.trim() === '')
          ) {
            throw new Error(TICKET_USAGE)
          }
          await abTicketMove({
            ...base,
            id: parsed.positionals[0]!,
            state: parsed.positionals[1]!,
            json: parsed.flags.has('json'),
            exec: needExec(),
          })
          return 0
        }

        default:
          throw new Error(TICKET_USAGE)
      }
    }

    // dispatch runs OUTSIDE build sessions (§3.3, §12): it serves a repo, not
    // a build, so it routes before any store/env requirement and does its own
    // heavy wiring (like ticket create). One dispatcher per repo (§12).
    case 'dispatch': {
      const usage =
        'usage: ab dispatch [--once] [--interval <seconds>] [--store <ref>] [--plain] [--intake | --no-intake] [--auto-merge | --no-auto-merge] (§3.3)'
      let once = false
      let plain = false
      let intake = true
      let defaultAutoMerge = false
      let sawIntake = false
      let sawNoIntake = false
      let sawAutoMerge = false
      let sawNoAutoMerge = false
      let intervalMs: number | undefined
      let storeRef: string | undefined
      for (let i = 0; i < rest.length; i += 1) {
        const arg = rest[i]!
        if (arg === '--once') {
          once = true
        } else if (arg === '--plain') {
          plain = true
        } else if (arg === '--intake') {
          sawIntake = true
          intake = true
        } else if (arg === '--no-intake') {
          sawNoIntake = true
          intake = false
        } else if (arg === '--auto-merge') {
          sawAutoMerge = true
          defaultAutoMerge = true
        } else if (arg === '--no-auto-merge') {
          sawNoAutoMerge = true
          defaultAutoMerge = false
        } else if (arg === '--interval') {
          const value = rest[(i += 1)]
          const seconds = value === undefined ? NaN : Number(value)
          if (!Number.isFinite(seconds) || seconds <= 0) {
            throw new Error(`--interval requires a positive number of seconds — ${usage}`)
          }
          intervalMs = Math.round(seconds * 1000)
        } else if (arg === '--store') {
          storeRef = flagValue(rest[(i += 1)], 'store', usage)
        } else {
          throw new Error(`unknown argument "${arg}" — ${usage}`)
        }
      }
      if (sawIntake && sawNoIntake) {
        throw new Error(`--intake and --no-intake cannot be combined — ${usage}`)
      }
      if (sawAutoMerge && sawNoAutoMerge) {
        throw new Error(
          `--auto-merge and --no-auto-merge cannot be combined — ${usage}`,
        )
      }
      if (deps.exec === undefined) {
        throw new Error("'ab dispatch' needs an exec seam — this is a wiring bug in the ab binary")
      }
      await abDispatch({
        targetRepo: deps.workspacePath,
        env: deps.processEnv ?? {},
        exec: deps.exec,
        stdout,
        stderr,
        once,
        plain,
        intake,
        defaultAutoMerge,
        ...(intervalMs !== undefined ? { intervalMs } : {}),
        ...(storeRef !== undefined ? { storeRef } : {}),
        ...(deps.signal !== undefined ? { signal: deps.signal } : {}),
        ...(deps.terminal !== undefined ? { terminal: deps.terminal } : {}),
        ...(deps.input !== undefined ? { input: deps.input } : {}),
        ...(deps.resolveDashboardRenderer !== undefined
          ? { resolveDashboardRenderer: deps.resolveDashboardRenderer }
          : {}),
      })
      return 0
    }

    // models runs OUTSIDE build sessions (§9): it lists Pi's model catalog so a
    // human can find the provider-qualified id to paste into autobuild.toml. No
    // store/env needed — only the Pi SDK (behind an injectable seam).
    case 'models': {
      const usage = 'usage: ab models [query] [--available] (§9)'
      let availableOnly = false
      const positionals: string[] = []
      for (const arg of rest) {
        if (arg === '--available') {
          availableOnly = true
        } else if (arg.startsWith('--')) {
          throw new Error(`unknown flag ${arg} — ${usage}`)
        } else {
          positionals.push(arg)
        }
      }
      await abModels({
        ...(positionals.length > 0 ? { query: positionals.join(' ') } : {}),
        availableOnly,
        stdout,
      })
      return 0
    }

    // builds/build status run OUTSIDE build sessions (§16.3) like dispatch:
    // they query a repo's builds, so they route before any store/env
    // requirement and resolve their own store (--store > AB_STORE > default).
    // Arg parsing is local, exactly as dispatch's is: main's parseArgs uses
    // module-global VALUE_FLAGS/BOOLEAN_FLAGS, so registering --store/--events
    // there would silently make `ab done --store x` legal.
    case 'builds': {
      const usage = 'usage: ab builds [--queued] [--all] [--json] [--store <ref>] (§8.2)'
      let queued = false
      let all = false
      let json = false
      let storeRef: string | undefined
      for (let i = 0; i < rest.length; i += 1) {
        const arg = rest[i]!
        if (arg === '--queued') {
          queued = true
        } else if (arg === '--all') {
          all = true
        } else if (arg === '--json') {
          json = true
        } else if (arg === '--store') {
          storeRef = flagValue(rest[(i += 1)], 'store', usage)
        } else {
          throw new Error(`unknown argument "${arg}" — ${usage}`)
        }
      }
      if (deps.exec === undefined) {
        throw new Error("'ab builds' needs an exec seam — this is a wiring bug in the ab binary")
      }
      await abBuilds({
        targetRepo: deps.workspacePath,
        env: deps.processEnv ?? {},
        exec: deps.exec,
        stdout,
        queued,
        all,
        json,
        ...(storeRef !== undefined ? { storeRef } : {}),
        ...(deps.clock !== undefined ? { now: deps.clock } : {}),
      })
      return 0
    }

    case 'build': {
      const usage =
        'usage: ab build status <slug> [--events <n>] [--json] [--store <ref>] (§8.2)'
      const [sub, ...more] = rest
      // Only `status` today; the subcommand shape keeps room for `ab build <verb>`.
      if (sub !== 'status') {
        throw new Error(usage)
      }
      let slug: string | undefined
      let events: number | undefined
      let json = false
      let storeRef: string | undefined
      for (let i = 0; i < more.length; i += 1) {
        const arg = more[i]!
        if (arg === '--json') {
          json = true
        } else if (arg === '--events') {
          const value = more[(i += 1)]
          const count = value === undefined ? NaN : Number(value)
          if (!Number.isInteger(count) || count <= 0) {
            throw new Error(
              `--events requires a positive integer, got "${value ?? ''}" — ${usage}`,
            )
          }
          events = count
        } else if (arg === '--store') {
          storeRef = flagValue(more[(i += 1)], 'store', usage)
        } else if (arg.startsWith('--')) {
          throw new Error(`unknown argument "${arg}" — ${usage}`)
        } else if (slug === undefined) {
          slug = arg
        } else {
          throw new Error(`unexpected argument "${arg}" — ${usage}`)
        }
      }
      if (slug === undefined) {
        throw new Error(usage)
      }
      if (deps.exec === undefined) {
        throw new Error("'ab build' needs an exec seam — this is a wiring bug in the ab binary")
      }
      await abBuildStatus({
        targetRepo: deps.workspacePath,
        env: deps.processEnv ?? {},
        exec: deps.exec,
        stdout,
        slug,
        json,
        ...(events !== undefined ? { events } : {}),
        ...(storeRef !== undefined ? { storeRef } : {}),
        ...(deps.clock !== undefined ? { now: deps.clock } : {}),
      })
      return 0
    }

    case 'pause':
    case 'resume':
    case 'abort': {
      const usage = `usage: ab ${command} <slug> [--store <ref>]`
      const parsed = parseBuildControlArgs(rest, usage)
      if (parsed.positionals.length !== 1) throw new Error(usage)
      await runBuildControl(
        deps,
        parsed.positionals[0]!,
        { kind: command },
        parsed.storeRef,
      )
      return 0
    }

    case 'auto-merge': {
      const usage =
        'usage: ab auto-merge <slug> <on|off> [--store <ref>]'
      const parsed = parseBuildControlArgs(rest, usage)
      const [slug, setting] = parsed.positionals
      if (
        parsed.positionals.length !== 2 ||
        slug === undefined ||
        (setting !== 'on' && setting !== 'off')
      ) {
        throw new Error(usage)
      }
      await runBuildControl(
        deps,
        slug,
        { kind: setting === 'on' ? 'auto-merge-on' : 'auto-merge-off' },
        parsed.storeRef,
      )
      return 0
    }

    case 'answer': {
      const usage =
        'usage: ab answer <slug> [<text>] [--store <ref>]'
      const parsed = parseBuildControlArgs(rest, usage)
      const [slug, ...text] = parsed.positionals
      if (slug === undefined) throw new Error(usage)
      const answer = text.join(' ')
      await runBuildControl(
        deps,
        slug,
        {
          kind: 'answer',
          ...(answer !== '' ? { text: answer } : {}),
        },
        parsed.storeRef,
      )
      return 0
    }

    case 'harvest': {
      const [sub, ...more] = rest
      if (sub === 'status') {
        const usage =
          'usage: ab harvest status [--events <n>] [--json] [--store <ref>]'
        let json = false
        let events: number | undefined
        let storeRef: string | undefined
        for (let i = 0; i < more.length; i += 1) {
          const arg = more[i]!
          if (arg === '--json') json = true
          else if (arg === '--events') {
            const value = more[(i += 1)]
            const count = value === undefined ? NaN : Number(value)
            if (!Number.isInteger(count) || count <= 0) {
              throw new Error(`--events requires a positive integer — ${usage}`)
            }
            events = count
          } else if (arg === '--store') {
            storeRef = flagValue(more[(i += 1)], 'store', usage)
          } else {
            throw new Error(`unknown argument "${arg}" — ${usage}`)
          }
        }
        if (deps.exec === undefined) {
          throw new Error("'ab harvest status' needs an exec seam — this is a wiring bug in the ab binary")
        }
        await abHarvestStatus({
          repo: deps.workspacePath,
          env: deps.processEnv ?? {},
          exec: deps.exec,
          stdout,
          json,
          ...(events !== undefined ? { events } : {}),
          ...(storeRef !== undefined ? { storeRef } : {}),
        })
        return 0
      }
      if (sub === 'context') {
        const parsed = parseArgs(more)
        if (parsed.positionals.length > 0) {
          throw new Error('usage: ab harvest context [--json]')
        }
        const manifest = await buildHarvestContext(
          requireHarvestSession('context', deps),
        )
        if (parsed.flags.get('json') === true) {
          stdout(JSON.stringify(manifest, null, 2))
        } else {
          stdout(
            `harvest context materialized for ${manifest.run} — ${manifest.phase}@${manifest.round}`,
          )
          stdout(`required deposit: ${manifest.required.join(', ')}`)
          for (const file of manifest.materialized) stdout(`  .ab/${file}`)
        }
        return 0
      }
      if (sub === 'submit') {
        const [file, ...extra] = more
        if (file === undefined || extra.length > 0 || file.startsWith('--')) {
          throw new Error('usage: ab harvest submit <proposals.json>')
        }
        const event = await submitHarvestProposals(
          requireHarvestSession('submit', deps),
          file,
        )
        stdout(`${event.type} recorded (repo seq ${event.seq})`)
        return 0
      }
      if (sub === 'verdict') {
        const parsed = parseArgs(more)
        const [kind, ...extra] = parsed.positionals
        const notes = stringFlag(parsed, 'notes')
        if (kind === undefined || extra.length > 0 || notes === undefined) {
          throw new Error(
            'usage: ab harvest verdict <approve|revise|escalate> --notes <file> ' +
              '[--findings <json>] [--reason <text>]',
          )
        }
        const event = await submitHarvestVerdict(
          requireHarvestSession('verdict', deps),
          {
            verdict: kind,
            notes,
            ...(stringFlag(parsed, 'findings') !== undefined
              ? { findings: stringFlag(parsed, 'findings')! }
              : {}),
            ...(stringFlag(parsed, 'reason') !== undefined
              ? { reason: stringFlag(parsed, 'reason')! }
              : {}),
          },
        )
        stdout(`${event.type} recorded (repo seq ${event.seq})`)
        return 0
      }
      throw new Error(
        'usage: ab harvest <status|context|submit|verdict> …',
      )
    }

    case 'context': {
      const session = requireSession(command, deps)
      const parsed = parseArgs(rest)
      const manifest = await buildContext(session)
      if (parsed.flags.get('json') === true) {
        stdout(JSON.stringify(manifest, null, 2))
      } else {
        for (const line of renderManifest(manifest)) stdout(line)
      }
      return 0
    }

    case 'artifact': {
      const session = requireSession(command, deps)
      const [sub, ...more] = rest
      if (sub === 'put') {
        const [kind, file] = more
        if (kind === undefined || file === undefined) {
          throw new Error('usage: ab artifact put <kind> <file> (§8.2)')
        }
        const meta = await artifactPut(session, kind, file)
        // The assigned rev is the command's one output (§8.2).
        stdout(String(meta.revision))
        return 0
      }
      if (sub === 'get') {
        const [spec] = more
        if (spec === undefined) {
          throw new Error('usage: ab artifact get <kind>[@rev] (§8.2)')
        }
        const artifact = await artifactGet(session, spec)
        stdout(textContent(artifact))
        return 0
      }
      throw new Error('usage: ab artifact <put|get> … (§8.2)')
    }

    case 'observe': {
      const parsed = parseArgs(rest)
      const kind = stringFlag(parsed, 'kind')
      if (kind === undefined) {
        throw new Error(
          "'ab observe' requires --kind <followup|refactor|latent-bug> (§8.2)",
        )
      }
      const session = requireSession(command, deps)
      const summary = parsed.positionals.join(' ')
      const files = listFlag(parsed, 'files')
      const refs = listFlag(parsed, 'refs')
      const event = await observe(session, {
        kind,
        summary,
        ...(files !== undefined ? { files } : {}),
        ...(refs !== undefined ? { refs } : {}),
      })
      stdout(`observation recorded: ${event.payload.id}`)
      return 0
    }

    case 'server': {
      const session = requireSession(command, deps)
      const [sub, count] = rest
      const control = new ServerControl({
        workspacePath: session.workspacePath,
        phase: session.env.phase,
      })
      switch (sub) {
        case 'start': {
          const started = await control.start()
          stdout(`server ready at ${started.url} (pid ${started.pid})`)
          return 0
        }
        case 'restart': {
          const started = await control.restart()
          stdout(`server ready at ${started.url} (pid ${started.pid})`)
          return 0
        }
        case 'stop': {
          await control.stop()
          stdout('server stopped')
          return 0
        }
        case 'status': {
          const status = control.status()
          stdout(status.running ? `running (pid ${status.pid})` : 'not running')
          return 0
        }
        case 'logs': {
          const lines = count === undefined ? undefined : Number(count)
          if (lines !== undefined && (!Number.isInteger(lines) || lines <= 0)) {
            throw new Error(
              `'ab server logs [n]' — n must be a positive integer, got "${count}"`,
            )
          }
          for (const line of control.logs(lines)) stdout(line)
          return 0
        }
        default:
          throw new Error('usage: ab server <start|stop|restart|status|logs> [n] (§8.2)')
      }
    }

    case 'done': {
      const session = requireSession(command, deps)
      const parsed = parseArgs(rest)
      const notes = stringFlag(parsed, 'notes')
      const event = await done(session, notes !== undefined ? { notes } : {})
      stdout(`${event.type} recorded (seq ${event.seq})`)
      return 0
    }

    case 'verdict': {
      const parsed = parseArgs(rest)
      const [kind] = parsed.positionals
      if (kind === undefined) {
        throw new Error(
          'usage: ab verdict <approve|revise|escalate|pass|fail|skip> ' +
            '[--findings <json>] [--notes <file>] [--reason <text>] [--report <file>] (§8.2)',
        )
      }
      const session = requireSession(command, deps)
      const notes = stringFlag(parsed, 'notes')
      const findings = stringFlag(parsed, 'findings')
      const reason = stringFlag(parsed, 'reason')
      const report = stringFlag(parsed, 'report')
      const events = await verdict(session, {
        verdict: kind,
        ...(notes !== undefined ? { notes } : {}),
        ...(findings !== undefined ? { findings } : {}),
        ...(reason !== undefined ? { reason } : {}),
        ...(report !== undefined ? { report } : {}),
      })
      for (const event of events) stdout(`${event.type} recorded (seq ${event.seq})`)
      return 0
    }

    case 'escalate': {
      const parsed = parseArgs(rest)
      const question = parsed.positionals.join(' ')
      if (question === '') {
        throw new Error('usage: ab escalate <question> [--refs a,b] (§8.2)')
      }
      const session = requireSession(command, deps)
      const refs = listFlag(parsed, 'refs')
      const event = await escalate(session, {
        question,
        ...(refs !== undefined ? { refs } : {}),
      })
      stdout(`escalation raised: ${event.payload.id}`)
      return 0
    }

    default: {
      stderr(`unknown command "${command}"\n\n${HELP}`)
      return 1
    }
  }
}
