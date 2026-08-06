export type HelpAudience = 'human' | 'ai'

export interface HelpEntry {
  name: string
  audience: HelpAudience
  summary: string
  detail: string
}

function page(lines: string[]): string {
  return lines.join('\n')
}

/**
 * The command catalog is the single source for overview inventory/order and
 * detailed help. Keep command families here rather than deriving them from a
 * parser: several families have mixed session boundaries and behavioral notes
 * that are part of the public CLI contract.
 */
export const HELP_CATALOG: readonly HelpEntry[] = [
  {
    name: 'help',
    audience: 'human',
    summary: 'Show the command overview or detailed help for one command.',
    detail: page([
      'Usage:',
      '  ab help',
      '  ab --help',
      '  ab -h',
      '  ab help <command>',
      '  ab <command> --help',
      '',
      'The first three forms show the command overview. The last two forms show',
      'the same detailed page for a command. Help is sessionless and requires no',
      'AB_* environment variables.',
    ]),
  },
  {
    name: 'init',
    audience: 'human',
    summary: 'Install Autobuild and hand repository setup to a coding agent.',
    detail: page([
      'Usage:',
      '  ab init [target] [--force]',
      '',
      'Deterministically vendor the editable ab-* skills, maintain .gitignore, probe every',
      'registered agent runtime, and create a stack-neutral autobuild.toml only when absent.',
      'The target defaults to the current directory. This command runs outside sessions.',
      '',
      'On an interactive terminal, init selects a usable shipped runtime in a fixed product',
      'preference order and starts a conversational setup agent. The agent inspects the',
      'repository, asks for team-specific choices, configures commands, verification, roles,',
      'and tickets, and leaves one groomed ticket. Its exit status becomes init’s exit status.',
      'Without a usable runtime or interactive terminal, init completes installation, prints',
      'every probe result, and emits the identical setup prompt for use in a coding agent.',
      '',
      'On reruns, init preserves autobuild.toml and asks the setup agent to review and improve it.',
      '--force overwrites edited vendored skills only; it never overwrites autobuild.toml.',
    ]),
  },
  {
    name: 'upgrade',
    audience: 'human',
    summary: 'Update Autobuild and merge updated default skills.',
    detail: page([
      'Usage:',
      '  ab upgrade [target] [--no-self-update | --version <semver>] [--no-commit]',
      '',
      '`ab update` is an accepted alias; `upgrade` remains the canonical name.',
      '',
      'By default, update the running Bun forge installation to its repository’s',
      'latest GitHub Release, then use the replacement binary and defaults to',
      'Three-way merge vendored ab-* skills (§16.3). The target defaults to the',
      'current directory. --version selects an exact release, including an older',
      'one. --no-self-update skips distribution update and merges against what is',
      'installed. Source checkouts are never mutated and still merge installed skills.',
      '',
      'For latest, unknown mechanisms and lookup/install failures warn and continue',
      'with installed defaults. For --version, those failures stop before skill merge.',
      'A local Bun install',
      'updates its owning package.json and bun.lock; a global install updates Bun’s',
      'global package-manager state. Local customizations remain preferred, and',
      'unresolved conflicts remain byte-untouched.',
      '',
      'After a clean merge, upgrade commits only the skill, pristine, discovery-link,',
      'and target-local package.json/bun.lock changes it owns. Unrelated staged and',
      'working-tree changes remain untouched. --no-commit leaves all merge output for',
      'manual review. Content or discovery conflicts, pre-existing dirt in an owned',
      'path, a non-Git target, an in-progress Git operation, or a replacement handoff',
      'missing its pre-update baseline suppress the commit with a warning. A staging or',
      'commit failure restores the pre-attempt index without touching merged files or',
      'changing upgrade’s merge-derived exit status.',
      'This command runs outside sessions.',
    ]),
  },
  {
    name: 'dispatch',
    audience: 'human',
    summary: 'Run the repository build dispatcher and dashboard.',
    detail: page([
      'Usage:',
      '  ab dispatch [--once] [--interval <s>] [--store <ref>] [--plain] [--intake | --no-intake] [--auto-merge | --no-auto-merge]',
      '',
      'Run the outer loop for this repository: resume current builds, run the',
      'janitor and lease sweep, and dispatch ready work (§3.3, §12). This command',
      'runs outside sessions.',
      '',
      'Options:',
      '  --once             Run one pass instead of watching continuously.',
      '  --interval <s>     Set the positive polling interval in seconds.',
      '  --store <ref>      Override the BuildStore path or URL.',
      '  --plain            Force line-oriented output.',
      '  --intake           Durably turn new ticket intake on.',
      '  --no-intake        Durably turn new ticket intake off.',
      '  --auto-merge       Durably enable auto-merge intent for newly claimed builds.',
      '  --no-auto-merge    Durably disable that claim-time default.',
      '',
      'The intake and auto-merge flags durably set repository defaults; omission reuses stored state (fresh repo: intake on, auto-merge off).',
      '--auto-merge seeds durable intent on newly claimed builds only. Opposite forms of the same setting cannot be combined.',
      '',
      'An interactive terminal gets a fixed global/harvest/build dashboard.',
      'TTY controls:',
      '  Up/Down   Select the global, Harvest, or a build row.',
      '  h         Toggle harvesting when the global row is selected.',
      '  i         Toggle intake when the global row is selected.',
      '  m         Toggle the claim-time default on the global row, or durable',
      '            auto-merge intent on a build.',
      '  p         On the global row, pause every pausable build and turn intake',
      '            off. On a build, pause or cancel a pending pause; on Harvest,',
      '            resume or acknowledge the run.',
      '  r         On the global row, resume every paused build and turn intake',
      '            back on. On a build, resume a paused or blocked build.',
      '  Ctrl-C    Stop dispatch.',
      '',
      'ab pause --all and ab resume --all are the sessionless equivalents of the',
      'global row’s p and r; they need no dispatcher and no terminal.',
      '',
      'For blocked feedback, Enter submits (empty means retry) and Esc cancels.',
      'The bottom controls list only keys active for the selection. Plain output',
      'is also selected automatically when stdout is not a TTY.',
    ]),
  },
  {
    name: 'ticket',
    audience: 'human',
    summary: 'Create, groom, inspect, and move source-agnostic tickets.',
    detail: page([
      'Usage:',
      '  ab ticket create <title> --body <file> [--state <state>] [--labels a,b] [--blocked-by id,id] [--json]',
      '  ab ticket update <id> [--title <title>] [--body <file>] [--labels a,b] [--json]',
      '  ab ticket block <id> <blocker-id[,blocker-id...]> [--json]',
      '  ab ticket unblock <id> <blocker-id[,blocker-id...]> [--json]',
      '  ab ticket list [--state <state>] [--labels a,b] [--json]',
      '  ab ticket show <id> [--json]',
      '  ab ticket move <id> <state> [--json]',
      '',
      'Operate on the configured [tickets] source (§8.8); all ticket commands run',
      'outside sessions. create files a ticket and may establish initial blockers.',
      '--state overrides [tickets].createState (or the provider default) for that',
      'create only; it is passed through unchanged and validated by the source.',
      'update partially replaces editable fields: omitted fields survive, --labels',
      '"" clears labels, and update never changes state. block and unblock accept',
      'comma-separated blocker ids and are idempotent. Every id is validated before',
      'any relationship is written, so an invalid list leaves the ticket unchanged.',
      '',
      'With no list filters, list uses the same ready criteria as dispatch. show one ticket, including its body/spec.',
      'Human output is the default. --json emits exactly one bare value: Ticket[]',
      'for list and the complete resulting Ticket for every other subcommand.',
      '',
      'Ticket ids are source-local (for example AUT-8 or file-1). For block and',
      'unblock, the first id is always the ticket being changed. State names and',
      'unknown-id errors come from the configured source.',
    ]),
  },
  {
    name: 'repository',
    audience: 'human',
    summary: 'Inspect durable repository dispatcher settings.',
    detail: page([
      'Usage:',
      '  ab repository status [--json] [--store <ref>]',
      '',
      'Report the durable ticket-intake setting, repository-wide pause, and',
      'claim-time auto-merge default from the same journal projection used by',
      'dispatch and the dashboard. A repository with no setting events reports',
      'the defaults: intake on, repository pause off, and auto-merge default off.',
      '',
      '--json emits one bare object for scripts. --store overrides AB_STORE, which',
      'overrides the repository-local .autobuild store. This sessionless command',
      'writes no state and starts no dispatcher, runner, ticket claim, or other work.',
    ]),
  },
  {
    name: 'builds',
    audience: 'human',
    summary: 'List repository builds and their current status.',
    detail: page([
      'Usage:',
      '  ab builds [--queued] [--all] [--json] [--store <ref>]',
      '',
      "List this repository's builds (§15.5). By default this shows active builds:",
      'running, paused, blocked. --queued also includes queued builds; --all',
      'shows every status and subsumes --queued. --json emits the projection as a',
      'bare JSON value, and --store overrides the BuildStore path or URL.',
      '',
      'This command is read-only and runs outside sessions.',
    ]),
  },
  {
    name: 'build',
    audience: 'human',
    summary: 'Inspect detailed state and recent events for one build.',
    detail: page([
      'Usage:',
      '  ab build status <slug> [--events <n>] [--json] [--store <ref>]',
      '',
      'Show detailed state for one build: unresolved escalations, open sessions,',
      'verify progress, PR state, the latest event, heartbeat, and lease.',
      '--events <n> appends the newest positive number of events in chronological',
      'order. --json emits the complete projection; --store overrides the',
      'BuildStore path or URL.',
      '',
      'This command is read-only and runs outside sessions.',
    ]),
  },
  {
    name: 'pause',
    audience: 'human',
    summary: 'Request that an active build pause, or pause the whole repository.',
    detail: page([
      'Usage:',
      '  ab pause <slug> [--store <ref>]',
      '  ab pause --all [--store <ref>] [--json]',
      '',
      'Durably request that an active build pause. --store overrides the BuildStore',
      'path or URL. This command is sessionless; a phase may not control its own build.',
      '',
      '--all is the repository-wide form and the sessionless equivalent of the',
      'dashboard’s global-row p: it durably holds every queued build, then',
      'turns ticket intake off, then requests a pause on every running build that',
      'does not already have one. While the hold is set no dispatcher tick gives a',
      'queued build a runner. Pausing, paused, blocked, and finished builds are',
      'skipped without error, and a pending pause is never cancelled. Output names',
      'every build that received a request, the hold, and the intake value written;',
      '--json emits that summary as JSON. Re-running it changes nothing further. A',
      'phase session may not use --all. A failure exits nonzero and reports which of',
      'the two repository facts landed and which builds were requested.',
    ]),
  },
  {
    name: 'resume',
    audience: 'human',
    summary: 'Request that a paused build resume, or resume the whole repository.',
    detail: page([
      'Usage:',
      '  ab resume <slug> [--store <ref>]',
      '  ab resume --all [--store <ref>] [--json]',
      '',
      'Durably request that an active paused build resume. This does not answer open',
      'escalations; use ab answer for a blocked build. See ab help answer for the complete',
      'resolution menu. --store overrides the BuildStore path or URL. This command is',
      'sessionless; a phase may not control',
      'its own build.',
      '',
      '--all is the repository-wide form and the sessionless equivalent of the',
      'dashboard’s global-row r: it durably releases the queued-build hold, then',
      'turns ticket intake back on, then requests a resume on every cleanly paused',
      'build that does not already have one. A released queued build becomes',
      'launchable on the next ordinary tick with no further action. Running, resuming,',
      'blocked, and finished builds are skipped without error, and a build still',
      'holding an open escalation is left to ab answer. Output names every build that',
      'received a request, the hold, and the intake value written; --json emits that',
      'summary as JSON. Re-running it changes nothing further. A phase session may not',
      'use --all. A failure exits nonzero and reports which of the two repository',
      'facts landed and which builds were requested.',
    ]),
  },
  {
    name: 'answer',
    audience: 'human',
    summary: 'Answer a build’s open escalations or request a retry.',
    detail: page([
      'Usage:',
      '  ab answer <slug> [<text>] [--store <ref>]',
      '  ab answer <slug> [<text>] --dismiss [--store <ref>]',
      '  ab answer <slug> [<text>] --revise-spec <file> [--store <ref>]',
      '  ab answer <slug> [<text>] --revise-spec-from-ticket [--store <ref>]',
      '',
      'Nonblank text supplies guidance to the loop producer.',
      'Omitting text requests a bare retry. --dismiss retires each cited finding chain,',
      'tells the next reviewer not to re-raise it and settles its stall counter.',
      'A blocker citing no real review finding remains open and must receive guidance or',
      'a retry.',
      '',
      '--revise-spec reads a replacement body from a file; --revise-spec-from-ticket',
      're-imports the build ticket after it was amended. A conforming replacement becomes',
      'the next spec revision and restarts from plan while keeping an open PR. Revision',
      'requires an open escalation. Non-conforming bodies are refused before anything is',
      'recorded. Retrying an interrupted revision completes the exact body authorized by',
      'the earlier recorded answer, not a newly supplied body.',
      '',
      'If paused and every blocker clears, resume is requested last. --store overrides the',
      'BuildStore path or URL. This command is sessionless; a phase may not answer its',
      'own build.',
    ]),
  },
  {
    name: 'abort',
    audience: 'human',
    summary: 'Request that a non-terminal build abort and be cleaned up.',
    detail: page([
      'Usage:',
      '  ab abort <slug> [--store <ref>]',
      '',
      'Durably request that a queued, running, paused, or blocked build abort. The live',
      'agent turn is cancelled promptly; dispatcher cleanup closes any unmerged PR,',
      'removes the workspace and local/remote branches, labels the ticket',
      'autobuild:aborted, and returns it to triage. Cleanup is asynchronous and retry-safe.',
      '--store overrides the BuildStore path or URL. This command is sessionless; a phase',
      'may not control its own build.',
    ]),
  },
  {
    name: 'auto-merge',
    audience: 'human',
    summary: 'Enable or cancel native auto-merge for one build.',
    detail: page([
      'Usage:',
      '  ab auto-merge <slug> <on|off> [--store <ref>]',
      '',
      'Request or cancel native squash auto-merge for an active build. --store',
      'overrides the BuildStore path or URL. This command is sessionless; a phase',
      'may not control its own build.',
    ]),
  },
  {
    name: 'models',
    audience: 'human',
    summary: 'Search Pi’s model catalog for role configuration.',
    detail: page([
      'Usage:',
      '  ab models [query] [--available]',
      '',
      "List Pi's model catalog, optionally filtered by query, to find a",
      'provider-qualified model id for autobuild.toml (§9). --available limits',
      'results to models whose provider credentials are currently available.',
      'This command runs outside sessions.',
    ]),
  },
  {
    name: 'plugin',
    audience: 'human',
    summary: 'Inspect, diagnose, and contract-test adapters.',
    detail: page([
      'Usage:',
      '  ab plugin list',
      '  ab plugin doctor',
      '  ab plugin test <ticket-source|agent-runtime|workspace-provider|forge> <adapter>',
      '',
      'list shows builtin and configured adapters, resolution, API status, and',
      'contract availability. doctor diagnoses every configured plugin module and',
      "exits nonzero if any fail. test runs the adapter's shared port contract suite;",
      'live fixtures require AB_RUN_LIVE_PORT_CONTRACTS=1.',
      '',
      'All plugin commands are sessionless.',
    ]),
  },
  {
    name: 'context',
    audience: 'ai',
    summary: 'Hydrate the current build phase’s input files.',
    detail: page([
      'Usage:',
      '  ab context [--json]',
      '',
      "Hydrate .ab/ with the current phase's inputs and print the context manifest.",
      '--json prints the manifest as JSON instead of the human summary. This command',
      'runs inside a build session and uses the runner-provided AB_* phase context.',
    ]),
  },
  {
    name: 'artifact',
    audience: 'ai',
    summary: 'Deposit, fetch, or download versioned build artifacts.',
    detail: page([
      'Usage:',
      '  ab artifact put <kind> <file> [--attach]',
      '  ab artifact get <kind>[@rev]',
      '  ab artifact download <build> <kind>[@rev] --output <file> [--store <ref>]',
      '',
      'put deposits a versioned artifact and prints its assigned revision. --attach',
      'also designates that exact revision for the PR. get fetches an artifact within',
      'the current build, using the latest revision when @rev is omitted. put and get',
      'run inside build sessions.',
      '',
      'download retrieves exact artifact bytes after a build into --output. It is',
      'read-only and sessionless; --store overrides the BuildStore path or URL.',
    ]),
  },
  {
    name: 'observe',
    audience: 'ai',
    summary: 'Record a structured non-terminal observation.',
    detail: page([
      'Usage:',
      '  ab observe --kind <followup|refactor|latent-bug> [--files a,b] [--refs x,y] <summary>',
      '',
      'Record a structured observation. --files associates repository paths and',
      '--refs associates artifact or source references. This is available in any',
      'build phase at any time and is not a terminal command.',
    ]),
  },
  {
    name: 'done',
    audience: 'ai',
    summary: 'Complete the current producer phase.',
    detail: page([
      'Usage:',
      '  ab done [--notes <file>]',
      '',
      'Complete a producer phase, optionally depositing --notes. This is a terminal',
      'command: it validates the phase outputs and clean worktree before kernel-side',
      'plumbing runs. Every phase ends with exactly one terminal command (D5).',
    ]),
  },
  {
    name: 'verdict',
    audience: 'ai',
    summary: 'Complete a review or verification phase with a verdict.',
    detail: page([
      'Usage:',
      '  ab verdict <approve|revise|escalate|pass|fail|skip> [--findings <json>] [--notes <file>] [--reason <text>] [--report <file>]',
      '',
      'Complete a review or verify phase. The accepted verdict vocabulary is',
      'phase-dependent. --findings supplies structured review findings, --notes',
      'deposits review notes, --reason explains escalation or skip, and --report',
      'deposits a verification failure report.',
      '',
      'This is a terminal command. Every phase ends with exactly one terminal',
      'command (D5).',
    ]),
  },
  {
    name: 'escalate',
    audience: 'ai',
    summary: 'Park the build with a question for a human.',
    detail: page([
      'Usage:',
      '  ab escalate <question> [--refs a,b]',
      '',
      'Park the build for human input, optionally attaching comma-separated source',
      'or artifact references. This is a terminal command. Every phase ends with',
      'exactly one terminal command (D5).',
    ]),
  },
  {
    name: 'harvest',
    audience: 'ai',
    summary: 'Inspect or drive repository observation-harvest workflows.',
    detail: page([
      'Usage:',
      '  ab harvest status [--events <n>] [--json] [--store <ref>]',
      '  ab harvest context [--json]',
      '  ab harvest submit <proposals.json>',
      '  ab harvest verdict <approve|revise|escalate> --notes <file> [--findings <json>] [--reason <text>]',
      '',
      'status shows all unresolved repository harvest workflows and their paper',
      'trail. --events appends the newest positive number of repository events,',
      '--json emits JSON, and --store overrides the BuildStore path or URL. status',
      'is read-only and sessionless.',
      '',
      'context hydrates harvest-session inputs; --json prints its manifest as JSON.',
      'submit is the synthesize terminal: it validates and deposits proposals from',
      'the named JSON file. verdict is the harvest-review terminal; --notes is',
      'required, --findings supplies revision findings, and --reason explains an',
      'escalation. These three forms require a runner-provided harvest session.',
    ]),
  },
]

const ENTRY_BY_NAME = new Map(HELP_CATALOG.map((entry) => [entry.name, entry]))

export type HelpRequest = { kind: 'overview' } | { kind: 'command'; command: string }

/** Recognize only complete help forms. Malformed forms stay on normal routing
 * so the command-specific parser can return usage feedback. */
export function recognizeHelpRequest(argv: readonly string[]): HelpRequest | undefined {
  if (argv.length === 1 && (argv[0] === 'help' || argv[0] === '--help' || argv[0] === '-h')) {
    return { kind: 'overview' }
  }
  if (argv.length === 2 && argv[1] === '--help') {
    return { kind: 'command', command: argv[0]! }
  }
  if (argv.length === 2 && argv[0] === 'help') {
    return { kind: 'command', command: argv[1]! }
  }
  return undefined
}

export function renderTopLevelHelp(): string {
  const lines = [
    'ab — agent-driven software delivery from groomed ticket to merged PR',
    '',
    '`ab` is Autobuild’s human/operator CLI and the agent↔store channel (SPEC §8.2).',
    '',
    'Primary human workflow:',
    '  Run `ab init` once, groom tickets to Ready, then run `ab dispatch`.',
    '  Dispatch drives planning, implementation, review, verification, and merge.',
    '',
    'For details, run `ab help <command>` or `ab <command> --help`.',
    'Run `ab --version` to report the installed version and plugin API offline.',
    '',
  ]

  for (const audience of ['human', 'ai'] as const) {
    lines.push(audience === 'human' ? 'Human-first commands:' : 'AI-first commands:')
    for (const entry of HELP_CATALOG) {
      if (entry.audience === audience) {
        lines.push(`  ab ${entry.name.padEnd(12)} ${entry.summary}`)
      }
    }
    if (audience === 'human') lines.push('')
  }
  return lines.join('\n')
}

export function renderCommandHelp(command: string): string {
  const entry = ENTRY_BY_NAME.get(command === 'update' ? 'upgrade' : command)
  if (entry === undefined) {
    throw new Error(`unknown help command "${command}"`)
  }
  return `ab ${entry.name} — ${entry.summary}\n\n${entry.detail}`
}
