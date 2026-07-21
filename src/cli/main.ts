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
import { reduceBuild } from '../kernel/reducer'
import { artifactDownload, artifactGet, artifactPut } from './artifact'
import { parseArgs, stringFlag, type ParsedArgs } from './args'
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
import { preparePrAttachments } from './pr-attachments'
import { renderPrSummary } from './pr-summary'
import { ServerControl } from './server-control'
import { abBuilds, abBuildStatus } from './status'
import { done, escalate, verdict } from './terminals'
import { abTicket } from './ticket'
import { abUpgrade, type ResolveConflict } from './upgrade'
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
 * `src/cli/binary.ts` routes through `isSessionlessInvocation` below. This set
 * owns flat command names; that helper additionally owns the few mixed nested
 * namespaces (`artifact download`, `harvest status`). Everything else first
 * attempts strict ambient resolution in `binary.ts`. A complete tuple gets a
 * scoped store; an absent value routes here with unscoped dependencies so the
 * command-specific guard below can name the full build or harvest context.
 * Keeping the classification here beside the switch makes it unit-testable.
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

/** Nested namespaces can mix operator and phase forms. In particular only
 * `artifact download` is sessionless; put/get retain ambient build scoping. */
export function isSessionlessInvocation(argv: readonly string[]): boolean {
  const command = argv[0]
  return (
    command === undefined ||
    SESSIONLESS_COMMANDS.has(command) ||
    (command === 'artifact' && argv[1] === 'download') ||
    (command === 'harvest' && argv[1] === 'status')
  )
}

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
 * work with no AB_* environment — so the session surface is optional here.
 * The binary also uses this narrow shape when ambient phase context is absent,
 * allowing requireSession/requireHarvestSession to return namespace-aware
 * guidance without constructing a store. Full CliDeps satisfies this
 * structurally, so wired-up callers are unchanged.
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
  /** Production supplies the tool-free upgrade agent; tests inject a fake.
   * Construction is deferred until a skill actually conflicts. */
  upgradeResolverFactory?: (opts: {
    targetRepo: string
    env: Record<string, string | undefined>
  }) => ResolveConflict
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
  '  ab artifact put <kind> <file> [--attach] deposit a versioned artifact → prints the assigned rev; optionally designate it for the PR',
  '  ab artifact get <kind>[@rev]           fetch an artifact within own build (latest when @rev omitted)',
  '  ab artifact download <build> <kind>[@rev] --output <file> [--store <ref>]',
  '                                         retrieve exact artifact bytes after a build (read-only, sessionless)',
  '  ab observe --kind <followup|refactor|latent-bug> [--files a,b] [--refs x,y] <summary>',
  '                                         structured observation — any phase, any time, not a terminal',
  '  ab server <start|stop|restart|status|logs> [n]',
  '                                         dev-server lifecycle, config-driven (§16.2); implement/verify only',
  '  ab done [--notes <file>]               complete a producer phase (TERMINAL: validates, then runs plumbing)',
  '  ab verdict <approve|revise|escalate|pass|fail|skip> [--findings <json>] [--notes <file>] [--reason <text>] [--report <file>]',
  '                                         complete a review/verify phase (TERMINAL; vocabulary is phase-dependent)',
  '  ab escalate <question> [--refs a,b]    park the build for human input (TERMINAL)',
  '',
  '  ab init [target] [--force]             create autobuild.toml only when absent; vendor the default ab-* skills (§16.3; runs outside sessions)',
  '                                         on reruns, --force overwrites edited vendored skills only; it never overwrites an existing autobuild.toml',
  '  ab upgrade [target]                    three-way merge vendored ab-* skills with the new defaults (§16.3; runs outside sessions)',
  '  ab ticket create <title> --body <file> [--labels a,b] [--blocked-by id,id]',
  '                                         file a ticket to the configured [tickets] source (§8.8; runs outside sessions).',
  '  ab ticket update <id> [--title <title>] [--body <file>] [--labels a,b]',
  '                                         partially update editable fields; omitted fields survive and --labels "" clears labels.',
  '  ab ticket block <id> <blocker-id>      add a blocker to an existing ticket (idempotent).',
  '  ab ticket unblock <id> <blocker-id>    remove a blocker from an existing ticket (idempotent).',
  '  ab ticket list [--state <state>] [--labels a,b] [--json]',
  '                                         list tickets; with no filters, use the same ready criteria as dispatch.',
  '  ab ticket show <id> [--json]           show one ticket, including its body/spec.',
  '  ab ticket move <id> <state> [--json]   move one ticket to a source-local state.',
  '                                         Ticket reads/moves use human output by default; --json emits the complete Ticket value.',
  '                                         Ticket ids are source-local (e.g. AUT-8 or file-1); for block/unblock, the first id is always the ticket being changed.',
  '                                         State names and unknown-id errors come from the configured source; ticket update never changes state.',
  '  ab dispatch [--once] [--interval <s>] [--store <ref>] [--plain] [--intake | --no-intake] [--auto-merge | --no-auto-merge]',
  '                                         run the outer loop for this repo — resume current builds, janitor, lease sweep, dispatch (§3.3, §12; runs outside sessions)',
  '                                         intake/auto-merge flags durably set repository defaults; omission reuses stored state (fresh repo: intake on, auto-merge off);',
  '                                         --auto-merge seeds durable intent on newly claimed builds only; opposite flag forms cannot be combined',
  '                                         an interactive terminal gets a fixed global/harvest/build dashboard; TTY controls: Up/Down select, p durably toggles intake on the global row',
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
  '                                         all unresolved repository harvest workflows and paper trail (read-only)',
  '  ab harvest context [--json]            hydrate harvest session inputs',
  '  ab harvest submit <proposals.json>     synthesize terminal: validate and deposit proposals',
  '  ab harvest verdict <approve|revise|escalate> --notes <file> [--findings <json>] [--reason <text>]',
  '                                         harvest-review terminal',
  '',
  'Every phase ends with exactly one terminal command (D5).',
].join('\n')

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
      const usage = 'usage: ab help'
      const parsed = parseArgs(rest, {}, usage)
      if (parsed.positionals.length > 0) throw new Error(usage)
      stdout(HELP)
      return 0
    }

    // init and upgrade run OUTSIDE build sessions (§16.3): they operate on a
    // repo, not a build, so they route before any store/env requirement.
    case 'init': {
      const usage = 'usage: ab init [target] [--force] (§16.3)'
      const parsed = parseArgs(rest, { force: 'boolean' }, usage)
      if (parsed.positionals.length > 1) throw new Error(usage)
      await abInit({
        targetRepo: parsed.positionals[0] ?? deps.workspacePath,
        force: parsed.flags.has('force'),
        stdout,
      })
      return 0
    }

    case 'upgrade': {
      const usage = 'usage: ab upgrade [target] (§16.3)'
      const parsed = parseArgs(rest, {}, usage)
      if (parsed.positionals.length > 1) throw new Error(usage)
      const targetRepo = parsed.positionals[0] ?? deps.workspacePath
      const resolverFactory = deps.upgradeResolverFactory
      let resolver: ResolveConflict | undefined
      const resolveConflict: ResolveConflict | undefined =
        resolverFactory === undefined
          ? undefined
          : async (input) => {
              // Factory/config/runtime work is lazy: a clean upgrade never
              // needs agent infrastructure. Throws are caught per skill by
              // abUpgrade and become the byte-preserving conflicted outcome.
              resolver ??= resolverFactory({
                targetRepo,
                env: deps.processEnv ?? {},
              })
              return resolver(input)
            }
      await abUpgrade({
        targetRepo,
        stdout,
        ...(deps.exec !== undefined ? { exec: deps.exec } : {}),
        ...(resolveConflict !== undefined ? { resolveConflict } : {}),
      })
      return 0
    }

    // Ticket grooming runs OUTSIDE build sessions (§8.8): command-scoped flag
    // declarations and one configured-source seam own every pre-build operation.
    case 'ticket': {
      if (deps.exec === undefined) {
        throw new Error(
          "'ab ticket' needs an exec seam — this is a wiring bug in the ab binary",
        )
      }
      await abTicket(rest, {
        targetRepo: deps.workspacePath,
        env: deps.processEnv ?? {},
        exec: deps.exec,
        stdout,
        stderr,
      })
      return 0
    }

    // dispatch runs OUTSIDE build sessions (§3.3, §12): it serves a repo, not
    // a build, so it routes before any store/env requirement and does its own
    // heavy wiring (like ticket create). One dispatcher per repo (§12).
    case 'dispatch': {
      const usage =
        'usage: ab dispatch [--once] [--interval <seconds>] [--store <ref>] [--plain] [--intake | --no-intake] [--auto-merge | --no-auto-merge] (§3.3)'
      const parsed = parseArgs(
        rest,
        {
          once: 'boolean',
          interval: 'value',
          store: 'value',
          plain: 'boolean',
          intake: 'boolean',
          'no-intake': 'boolean',
          'auto-merge': 'boolean',
          'no-auto-merge': 'boolean',
        },
        usage,
      )
      if (parsed.positionals.length > 0) throw new Error(usage)

      const once = parsed.flags.has('once')
      const plain = parsed.flags.has('plain')
      const sawIntake = parsed.flags.has('intake')
      const sawNoIntake = parsed.flags.has('no-intake')
      const sawAutoMerge = parsed.flags.has('auto-merge')
      const sawNoAutoMerge = parsed.flags.has('no-auto-merge')
      if (sawIntake && sawNoIntake) {
        throw new Error(`--intake and --no-intake cannot be combined — ${usage}`)
      }
      if (sawAutoMerge && sawNoAutoMerge) {
        throw new Error(
          `--auto-merge and --no-auto-merge cannot be combined — ${usage}`,
        )
      }

      const interval = stringFlag(parsed, 'interval')
      let intervalMs: number | undefined
      if (interval !== undefined) {
        const seconds = Number(interval)
        if (!Number.isFinite(seconds) || seconds <= 0) {
          throw new Error(`--interval requires a positive number of seconds — ${usage}`)
        }
        intervalMs = Math.round(seconds * 1000)
      }
      const storeRef = stringFlag(parsed, 'store')
      const intake = sawIntake ? true : sawNoIntake ? false : undefined
      const defaultAutoMerge = sawAutoMerge
        ? true
        : sawNoAutoMerge
          ? false
          : undefined
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
        ...(intake !== undefined ? { intake } : {}),
        ...(defaultAutoMerge !== undefined ? { defaultAutoMerge } : {}),
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
      const parsed = parseArgs(rest, { available: 'boolean' }, usage)
      await abModels({
        ...(parsed.positionals.length > 0
          ? { query: parsed.positionals.join(' ') }
          : {}),
        availableOnly: parsed.flags.has('available'),
        stdout,
      })
      return 0
    }

    // builds/build status run OUTSIDE build sessions (§16.3) like dispatch:
    // they query a repo's builds, so they route before any store/env
    // requirement and resolve their own store (--store > AB_STORE > default).
    case 'builds': {
      const usage = 'usage: ab builds [--queued] [--all] [--json] [--store <ref>] (§8.2)'
      const parsed = parseArgs(
        rest,
        { queued: 'boolean', all: 'boolean', json: 'boolean', store: 'value' },
        usage,
      )
      if (parsed.positionals.length > 0) throw new Error(usage)
      const storeRef = stringFlag(parsed, 'store')
      if (deps.exec === undefined) {
        throw new Error("'ab builds' needs an exec seam — this is a wiring bug in the ab binary")
      }
      await abBuilds({
        targetRepo: deps.workspacePath,
        env: deps.processEnv ?? {},
        exec: deps.exec,
        stdout,
        queued: parsed.flags.has('queued'),
        all: parsed.flags.has('all'),
        json: parsed.flags.has('json'),
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
      const parsed = parseArgs(
        more,
        { events: 'value', json: 'boolean', store: 'value' },
        usage,
      )
      const [slug] = parsed.positionals
      if (slug === undefined || parsed.positionals.length !== 1) {
        throw new Error(usage)
      }
      const eventCount = stringFlag(parsed, 'events')
      let events: number | undefined
      if (eventCount !== undefined) {
        const count = Number(eventCount)
        if (!Number.isInteger(count) || count <= 0) {
          throw new Error(
            `--events requires a positive integer, got "${eventCount}" — ${usage}`,
          )
        }
        events = count
      }
      const storeRef = stringFlag(parsed, 'store')
      if (deps.exec === undefined) {
        throw new Error("'ab build' needs an exec seam — this is a wiring bug in the ab binary")
      }
      await abBuildStatus({
        targetRepo: deps.workspacePath,
        env: deps.processEnv ?? {},
        exec: deps.exec,
        stdout,
        slug,
        json: parsed.flags.has('json'),
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
      const parsed = parseArgs(rest, { store: 'value' }, usage)
      if (parsed.positionals.length !== 1) throw new Error(usage)
      await runBuildControl(
        deps,
        parsed.positionals[0]!,
        { kind: command },
        stringFlag(parsed, 'store'),
      )
      return 0
    }

    case 'auto-merge': {
      const usage =
        'usage: ab auto-merge <slug> <on|off> [--store <ref>]'
      const parsed = parseArgs(rest, { store: 'value' }, usage)
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
        stringFlag(parsed, 'store'),
      )
      return 0
    }

    case 'answer': {
      const usage =
        'usage: ab answer <slug> [<text>] [--store <ref>]'
      const parsed = parseArgs(rest, { store: 'value' }, usage)
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
        stringFlag(parsed, 'store'),
      )
      return 0
    }

    case 'harvest': {
      const [sub, ...more] = rest
      if (sub === 'status') {
        const usage =
          'usage: ab harvest status [--events <n>] [--json] [--store <ref>]'
        const parsed = parseArgs(
          more,
          { events: 'value', json: 'boolean', store: 'value' },
          usage,
        )
        if (parsed.positionals.length > 0) throw new Error(usage)
        const eventCount = stringFlag(parsed, 'events')
        let events: number | undefined
        if (eventCount !== undefined) {
          const count = Number(eventCount)
          if (!Number.isInteger(count) || count <= 0) {
            throw new Error(`--events requires a positive integer — ${usage}`)
          }
          events = count
        }
        const storeRef = stringFlag(parsed, 'store')
        if (deps.exec === undefined) {
          throw new Error("'ab harvest status' needs an exec seam — this is a wiring bug in the ab binary")
        }
        await abHarvestStatus({
          repo: deps.workspacePath,
          env: deps.processEnv ?? {},
          exec: deps.exec,
          stdout,
          json: parsed.flags.has('json'),
          ...(events !== undefined ? { events } : {}),
          ...(storeRef !== undefined ? { storeRef } : {}),
        })
        return 0
      }
      if (sub === 'context') {
        const usage = 'usage: ab harvest context [--json]'
        const parsed = parseArgs(more, { json: 'boolean' }, usage)
        if (parsed.positionals.length > 0) throw new Error(usage)
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
        const usage = 'usage: ab harvest submit <proposals.json>'
        const parsed = parseArgs(more, {}, usage)
        const [file] = parsed.positionals
        if (file === undefined || parsed.positionals.length !== 1) {
          throw new Error(usage)
        }
        const event = await submitHarvestProposals(
          requireHarvestSession('submit', deps),
          file,
        )
        stdout(`${event.type} recorded (repo seq ${event.seq})`)
        return 0
      }
      if (sub === 'verdict') {
        const usage =
          'usage: ab harvest verdict <approve|revise|escalate> --notes <file> ' +
          '[--findings <json>] [--reason <text>]'
        const parsed = parseArgs(
          more,
          { notes: 'value', findings: 'value', reason: 'value' },
          usage,
        )
        const [kind] = parsed.positionals
        const notes = stringFlag(parsed, 'notes')
        if (
          kind === undefined ||
          parsed.positionals.length !== 1 ||
          notes === undefined
        ) {
          throw new Error(usage)
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
      const usage = 'usage: ab context [--json]'
      const parsed = parseArgs(rest, { json: 'boolean' }, usage)
      if (parsed.positionals.length > 0) throw new Error(usage)
      const manifest = await buildContext(session)
      if (parsed.flags.get('json') === true) {
        stdout(JSON.stringify(manifest, null, 2))
      } else {
        for (const line of renderManifest(manifest)) stdout(line)
      }
      return 0
    }

    case 'artifact': {
      const [sub, ...more] = rest
      if (sub === 'download') {
        const usage =
          'usage: ab artifact download <build> <kind>[@rev] --output <file> [--store <ref>] (§8.2)'
        const parsed = parseArgs(
          more,
          { output: 'value', store: 'value' },
          usage,
        )
        const [build, spec] = parsed.positionals
        const outputPath = stringFlag(parsed, 'output')
        if (
          build === undefined ||
          spec === undefined ||
          parsed.positionals.length !== 2 ||
          outputPath === undefined
        ) {
          throw new Error(usage)
        }
        const storeRef = stringFlag(parsed, 'store')
        if (deps.exec === undefined) {
          throw new Error(
            "'ab artifact download' needs an exec seam — this is a wiring bug in the ab binary",
          )
        }
        const downloaded = await artifactDownload({
          targetRepo: deps.workspacePath,
          env: deps.processEnv ?? {},
          exec: deps.exec,
          build,
          spec,
          outputPath,
          ...(storeRef !== undefined ? { storeRef } : {}),
        })
        stdout(
          `downloaded ${downloaded.artifact.meta.kind}@${downloaded.artifact.meta.revision} to ${downloaded.outputPath}`,
        )
        return 0
      }

      const session = requireSession(command, deps)
      if (sub === 'put') {
        const usage = 'usage: ab artifact put <kind> <file> [--attach] (§8.2)'
        const parsed = parseArgs(more, { attach: 'boolean' }, usage)
        const [kind, file] = parsed.positionals
        if (
          kind === undefined ||
          file === undefined ||
          parsed.positionals.length !== 2
        ) {
          throw new Error(usage)
        }
        const attach = parsed.flags.has('attach')
        const meta = await artifactPut(session, kind, file, { attach })

        // A designation made after the PR exists (verify after reconcile or a
        // finalize post-step) republishes the same complete projection. Every
        // external side effect is best-effort after the atomic designation.
        if (attach) {
          try {
            const events = await session.store.getEvents(session.env.build)
            const pr = reduceBuild(events).pr
            if (pr !== undefined) {
              try {
                await preparePrAttachments(session, events, pr.url)
              } catch {
                // A post-upload hosted-fact failure records the exact public
                // asset identity before throwing. Keep going so its hosting
                // failure cannot suppress the complete text projection.
              }
              try {
                await session.forge.commentOnPr(
                  session.workspacePath,
                  pr.number,
                  renderPrSummary(
                    session.env,
                    await session.store.getEvents(session.env.build),
                  ),
                )
              } catch {
                // The exact artifact and designation are already durable. A
                // comment refresh cannot turn the agent's deposit into failure.
              }
            }
          } catch {
            // Reading the optional PR projection is best-effort too.
          }
        }

        // The assigned rev is the command's one output (§8.2).
        stdout(String(meta.revision))
        return 0
      }
      if (sub === 'get') {
        const usage = 'usage: ab artifact get <kind>[@rev] (§8.2)'
        const parsed = parseArgs(more, {}, usage)
        const [spec] = parsed.positionals
        if (spec === undefined || parsed.positionals.length !== 1) {
          throw new Error(usage)
        }
        const artifact = await artifactGet(session, spec)
        stdout(textContent(artifact))
        return 0
      }
      throw new Error('usage: ab artifact <put|get|download> … (§8.2)')
    }

    case 'observe': {
      const usage =
        'usage: ab observe --kind <followup|refactor|latent-bug> [--files a,b] [--refs x,y] <summary> (§8.2)'
      const parsed = parseArgs(
        rest,
        { kind: 'value', files: 'value', refs: 'value' },
        usage,
      )
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
      const usage =
        'usage: ab server <start|stop|restart|status|logs> [n] (§8.2)'
      const parsed = parseArgs(rest, {}, usage)
      const [sub, count, ...extra] = parsed.positionals
      const control = new ServerControl({
        workspacePath: session.workspacePath,
        phase: session.env.phase,
      })
      switch (sub) {
        case 'start': {
          if (count !== undefined) throw new Error(usage)
          const started = await control.start()
          stdout(`server ready at ${started.url} (pid ${started.pid})`)
          return 0
        }
        case 'restart': {
          if (count !== undefined) throw new Error(usage)
          const started = await control.restart()
          stdout(`server ready at ${started.url} (pid ${started.pid})`)
          return 0
        }
        case 'stop': {
          if (count !== undefined) throw new Error(usage)
          await control.stop()
          stdout('server stopped')
          return 0
        }
        case 'status': {
          if (count !== undefined) throw new Error(usage)
          const status = control.status()
          stdout(status.running ? `running (pid ${status.pid})` : 'not running')
          return 0
        }
        case 'logs': {
          if (extra.length > 0) throw new Error(usage)
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
          throw new Error(usage)
      }
    }

    case 'done': {
      const session = requireSession(command, deps)
      const usage = 'usage: ab done [--notes <file>] (§8.2)'
      const parsed = parseArgs(rest, { notes: 'value' }, usage)
      if (parsed.positionals.length > 0) throw new Error(usage)
      const notes = stringFlag(parsed, 'notes')
      const event = await done(session, notes !== undefined ? { notes } : {})
      stdout(`${event.type} recorded (seq ${event.seq})`)
      return 0
    }

    case 'verdict': {
      const usage =
        'usage: ab verdict <approve|revise|escalate|pass|fail|skip> ' +
        '[--findings <json>] [--notes <file>] [--reason <text>] [--report <file>] (§8.2)'
      const parsed = parseArgs(
        rest,
        {
          findings: 'value',
          notes: 'value',
          reason: 'value',
          report: 'value',
        },
        usage,
      )
      const [kind] = parsed.positionals
      if (kind === undefined || parsed.positionals.length !== 1) {
        throw new Error(usage)
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
      const usage = 'usage: ab escalate <question> [--refs a,b] (§8.2)'
      const parsed = parseArgs(rest, { refs: 'value' }, usage)
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
