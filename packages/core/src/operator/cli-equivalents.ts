/**
 * The checked-in map between the `ab` CLI and the operator tool registry.
 *
 * A connected agent reads skills written for agents with a shell. The
 * context tools (`context.read`) prepend a generated preamble that maps every
 * `ab` command a text mentions onto the tool that performs it, or says why no
 * tool does. The mapping lives here, never in a skill, so it cannot drift
 * from the registry: a unit test holds every tool to a declaration and every
 * declared or classified command to the help catalog (`cli/help.ts`).
 */
import type { OperatorToolName } from './annotations'

/** One CLI form a tool performs. `command` is the full spelling
 * (`ab ticket create`); `note` names the argument or flag that selects it. */
export interface CliEquivalent {
  command: string
  note?: string
}

/** Every tool declares its CLI forms, or `none` with the reason no command
 * performs it. `aliasOf` marks a deprecated tool alias the preamble skips. */
export type ToolCliDeclaration =
  | { cli: readonly CliEquivalent[]; aliasOf?: OperatorToolName }
  | { none: string }

export const OPERATOR_TOOL_CLI: Record<OperatorToolName, ToolCliDeclaration> = {
  'merges.list': { cli: [{ command: 'ab merges' }] },
  'landings.list': { cli: [{ command: 'ab merges' }], aliasOf: 'merges.list' },
  'tickets.tree': { cli: [{ command: 'ab ticket tree' }] },
  'builds.list': { cli: [{ command: 'ab builds' }] },
  'builds.get': { cli: [{ command: 'ab build status' }] },
  'builds.events': {
    cli: [
      { command: 'ab build status', note: 'the --events tail, paged by cursor' },
      { command: 'ab wait', note: 'poll with cursor and waitSeconds' },
      { command: 'ab watch', note: 'named slugs; poll with cursor' },
    ],
  },
  'builds.artifact': {
    cli: [{ command: 'ab artifact download', note: 'returns contentBase64 instead of --output' }],
  },
  'builds.restack': { cli: [{ command: 'ab restack' }] },
  'optimization.revise': { cli: [{ command: 'ab objective', note: 'the revision flags' }] },
  'optimization.stop': { cli: [{ command: 'ab objective', note: '--stop' }] },
  'optimization.settle-unmeasured': {
    cli: [{ command: 'ab objective', note: '--settle-unmeasured' }],
  },
  'builds.control': {
    cli: [
      { command: 'ab pause', note: 'action: "pause"' },
      { command: 'ab resume', note: 'action: "resume"' },
      { command: 'ab abort', note: 'action: "abort"' },
      { command: 'ab merge', note: 'action: "merge"' },
      { command: 'ab hold', note: 'action: "hold"' },
      { command: 'ab priority', note: 'action: "priority"' },
    ],
  },
  'builds.answer': { cli: [{ command: 'ab answer' }] },
  'builds.reopen': { cli: [{ command: 'ab reopen' }] },
  'repository.forge_clear': { cli: [{ command: 'ab repository forge-clear' }] },
  'repository.status': { cli: [{ command: 'ab repository status' }] },
  'repository.events': {
    cli: [{ command: 'ab watch', note: 'the repository journal; poll with cursor' }],
  },
  'repository.attention': {
    none: 'the attention digest has no CLI form; it gathers what ab watch and ab repository status show',
  },
  'repository.settings': {
    none: 'ticket intake and the auto-merge default are dispatcher flags and dashboard toggles',
  },
  'repository.bulk_control': {
    cli: [
      { command: 'ab pause', note: '--all; action: "pause"' },
      { command: 'ab resume', note: '--all; action: "resume"' },
    ],
  },
  'harvest.status': { cli: [{ command: 'ab harvest status' }] },
  'harvest.control': { none: 'harvest gate and run controls are dashboard actions' },
  'tickets.states': { cli: [{ command: 'ab ticket states' }] },
  'tickets.state.create': { cli: [{ command: 'ab ticket state create' }] },
  'tickets.list': { cli: [{ command: 'ab ticket list' }] },
  'tickets.search': { cli: [{ command: 'ab ticket search' }] },
  'tickets.get': { cli: [{ command: 'ab ticket show' }] },
  'tickets.create': { cli: [{ command: 'ab ticket create', note: 'body as text, not a file' }] },
  'tickets.update': {
    cli: [
      { command: 'ab ticket update', note: 'body as text, not a file' },
      { command: 'ab ticket edit', note: 'pass the changed fields' },
    ],
  },
  'tickets.block': { cli: [{ command: 'ab ticket block' }] },
  'tickets.unblock': { cli: [{ command: 'ab ticket unblock' }] },
  'tickets.move': { cli: [{ command: 'ab ticket move' }] },
  'tickets.start': { cli: [{ command: 'ab start' }] },
  'tickets.asset.attach': {
    cli: [{ command: 'ab ticket attach', note: 'files as base64 entries' }],
  },
  'tickets.asset.get': { cli: [{ command: 'ab ticket asset get', note: 'returns base64' }] },
  'tickets.asset.remove': { cli: [{ command: 'ab ticket asset rm' }] },
  'notes.read': { none: 'operator notes are reachable only through the tools' },
  'notes.write': { none: 'operator notes are reachable only through the tools' },
  'sandbox.open': { none: 'the sandbox is a connected agent’s checkout; no command manages it' },
  'sandbox.status': { none: 'the sandbox is a connected agent’s checkout; no command manages it' },
  'sandbox.close': { none: 'the sandbox is a connected agent’s checkout; no command manages it' },
  'sandbox.refresh': { none: 'the sandbox is a connected agent’s checkout; no command manages it' },
  'sandbox.exec': { none: 'runs a shell command in the sandbox' },
  'sandbox.start': { none: 'runs a shell command in the sandbox' },
  'sandbox.wait': { none: 'runs a shell command in the sandbox' },
  'sandbox.read_file': { none: 'reads a file in the sandbox' },
  'sandbox.write_file': { none: 'writes a file in the sandbox' },
  'sandbox.reset': { none: 'the sandbox is a connected agent’s checkout; no command manages it' },
  'sandbox.publish': { none: 'the sandbox is a connected agent’s checkout; no command manages it' },
  'context.list': { none: 'a checkout reads its skills and agent instructions directly' },
  'context.read': { none: 'a checkout reads its skills and agent instructions directly' },
}

/** Where a command with no tool can run, from a connected agent's seat:
 * - `sandbox`: works from a checkout with no store credential and no session,
 *   so `sandbox.exec` can run it;
 * - `build-session`: a phase or harvest session's own command;
 * - `host`: needs store credentials, a dispatcher or the maintainer's
 *   machine. */
export type CliAvailability = 'sandbox' | 'build-session' | 'host'

export const CLI_WITHOUT_TOOL: readonly {
  command: string
  availability: CliAvailability
  note?: string
}[] = [
  { command: 'ab help', availability: 'sandbox' },
  { command: 'ab init', availability: 'sandbox' },
  { command: 'ab plugin', availability: 'sandbox' },
  { command: 'ab context', availability: 'build-session' },
  { command: 'ab artifact', availability: 'build-session' },
  { command: 'ab observe', availability: 'build-session' },
  { command: 'ab issue', availability: 'build-session' },
  { command: 'ab done', availability: 'build-session' },
  { command: 'ab verdict', availability: 'build-session' },
  { command: 'ab propose', availability: 'build-session' },
  { command: 'ab escalate', availability: 'build-session' },
  { command: 'ab wait-on', availability: 'build-session' },
  { command: 'ab judge', availability: 'build-session' },
  { command: 'ab harvest', availability: 'build-session' },
  { command: 'ab dispatch', availability: 'host' },
  { command: 'ab upgrade', availability: 'host' },
  { command: 'ab connect', availability: 'host' },
  { command: 'ab disconnect', availability: 'host' },
  { command: 'ab accounts', availability: 'host' },
  { command: 'ab secrets', availability: 'host' },
  { command: 'ab web', availability: 'host' },
  { command: 'ab mcp', availability: 'host' },
  { command: 'ab operator', availability: 'host' },
  { command: 'ab models', availability: 'host' },
  { command: 'ab ticket export', availability: 'host' },
  { command: 'ab ticket import', availability: 'host' },
  { command: 'ab ticket migration', availability: 'host' },
  { command: 'ab build asset', availability: 'host', note: 'a build’s frozen asset copy' },
]

/** Spellings the CLI accepts for another command. */
export const CLI_COMMAND_ALIASES: Readonly<Record<string, string>> = {
  'ab land': 'ab merge',
  'ab landings': 'ab merges',
  'ab update': 'ab upgrade',
}

interface CommandTarget {
  tool: OperatorToolName
  note?: string
}

function toolTargets(): Map<string, CommandTarget[]> {
  const targets = new Map<string, CommandTarget[]>()
  for (const [tool, declaration] of Object.entries(OPERATOR_TOOL_CLI) as [
    OperatorToolName,
    ToolCliDeclaration,
  ][]) {
    if (!('cli' in declaration) || declaration.aliasOf !== undefined) continue
    for (const { command, note } of declaration.cli) {
      const list = targets.get(command) ?? []
      list.push({ tool, ...(note !== undefined ? { note } : {}) })
      targets.set(command, list)
    }
  }
  return targets
}

const TARGETS = toolTargets()
const WITHOUT = new Map(CLI_WITHOUT_TOOL.map((entry) => [entry.command, entry]))

/** Every command this module knows: tool-mapped and tool-less. */
export function knownCliCommands(): string[] {
  return [...new Set([...TARGETS.keys(), ...WITHOUT.keys()])]
}

/** Top-level command words (`ticket`, `build`, …) that the table covers,
 * directly or through a subcommand. */
const TOP_LEVEL: ReadonlySet<string> = new Set(
  [...knownCliCommands(), ...Object.keys(CLI_COMMAND_ALIASES)].map(
    (command) => command.split(' ')[1]!,
  ),
)

/** The command families (`ab ticket`) whose subcommands map to tools but
 * which have no declaration of their own. */
function familyTools(command: string): string[] {
  const families = new Set<string>()
  for (const [known, targets] of TARGETS)
    if (known.startsWith(`${command} `))
      for (const target of targets) families.add(target.tool.split('.')[0]!)
  return [...families]
}

function resolve(mention: string): string | undefined {
  const words = mention.split(' ')
  for (let length = words.length; length >= 2; length--) {
    const candidate = words.slice(0, length).join(' ')
    const aliased = CLI_COMMAND_ALIASES[candidate] ?? candidate
    if (TARGETS.has(aliased) || WITHOUT.has(aliased)) return aliased
    if (length === 2 && familyTools(aliased).length > 0) return aliased
  }
  return undefined
}

const MENTION = /(?<![\w./-])ab ((?:[a-z][a-z-]*)(?: [a-z][a-z-]*)*)/g

/** The distinct known `ab` commands a text mentions, in first-mention order.
 * A mention resolves to the longest known command that prefixes it (through
 * the CLI's own aliases); one whose first word is no known command is prose
 * ("ab over") and is ignored. */
export function cliMentions(text: string): string[] {
  const seen = new Set<string>()
  for (const match of text.matchAll(MENTION)) {
    const mention = `ab ${match[1]!}`
    if (!TOP_LEVEL.has(mention.split(' ')[1]!)) continue
    const command = resolve(mention)
    if (command !== undefined) seen.add(command)
  }
  return [...seen]
}

function availabilityLine(availability: CliAvailability): string {
  switch (availability) {
    case 'sandbox':
      return 'no tool: run it inside the sandbox with `sandbox.exec` (no store credentials there)'
    case 'build-session':
      return 'no tool: build sessions only; it does not apply to you'
    case 'host':
      return 'no tool: runs on the maintainer’s host with store credentials; ask a human'
  }
}

/** One markdown line per command: the tools that perform it, or why none
 * does. Commands come from `cliMentions`. */
export function renderCliMapping(commands: readonly string[]): string[] {
  return commands.map((command) => {
    const targets = TARGETS.get(command)
    if (targets !== undefined) {
      const tools = targets
        .map(({ tool, note }) => `\`${tool}\`${note !== undefined ? ` (${note})` : ''}`)
        .join(' or ')
      return `- \`${command}\` → ${tools}`
    }
    const without = WITHOUT.get(command)
    if (without !== undefined)
      return `- \`${command}\` → ${availabilityLine(without.availability)}${without.note !== undefined ? ` (${without.note})` : ''}`
    const families = familyTools(command)
    return `- \`${command} …\` → the ${families.map((family) => `\`${family}.*\``).join(' and ')} tools`
  })
}
