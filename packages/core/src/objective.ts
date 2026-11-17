/**
 * The optimization-node objective (SPEC §13.1, RFC 0005 §4): the one place the
 * `autobuild-objective` marker is found, parsed and validated. The dispatcher,
 * spec revisions, `ab objective`, `ab ticket` and the event catalog all call
 * this module, so the marker's false-positive rules exist exactly once.
 *
 * Import boundary: this module imports only zod, smol-toml and the path
 * selector grammar. The event catalog imports it, never the reverse.
 */
import { parse as parseToml, TomlError } from 'smol-toml'
import { z } from 'zod'
import { compilePathSelectors, pathSelectorSchema } from './config/path-selectors'

/** The exact info string that marks an optimization node's objective. */
export const OBJECTIVE_INFO_STRING = 'autobuild-objective'

const FENCE_OPEN = /^( {0,3})(`{3,}|~{3,})(.*)$/

interface FenceScan {
  blocks: string[]
  /** The last objective fence was never closed. Its content is still counted. */
  unterminated: boolean
}

/**
 * CommonMark-style fence scan. A fence opens on a line indented at most three
 * spaces with three or more backticks or tildes, and closes on a fence of the
 * same character, at least as long, with no info string. Only a fence whose
 * trimmed info string is exactly `autobuild-objective` counts, and never one
 * nested inside another open fence, inside an HTML block (an HTML comment
 * included), inside a blockquote, or indented four or more spaces. Headings,
 * `toml` blocks, prose and inline code never count.
 */
function scanObjectiveFences(body: string): FenceScan {
  const blocks: string[] = []
  let open: { char: string; length: number; indent: number; lines: string[] | null } | undefined
  let html: HtmlBlockEnd | undefined
  let paragraph = false
  for (const line of body.replace(/\r\n?/g, '\n').split('\n')) {
    if (html !== undefined) {
      if (html === 'blank' ? isBlank(line) : html.test(line)) html = undefined
      paragraph = false
      continue
    }
    if (open !== undefined) {
      const close = line.match(/^ {0,3}(`{3,}|~{3,})[ \t]*$/)
      if (close?.[1] !== undefined && close[1][0] === open.char && close[1].length >= open.length) {
        if (open.lines !== null) blocks.push(open.lines.join('\n'))
        open = undefined
        continue
      }
      open.lines?.push(stripIndent(line, open.indent))
      continue
    }
    const htmlEnd = htmlBlockStart(line, paragraph)
    if (htmlEnd !== undefined) {
      // A block whose end condition holds on its first line ends there.
      if (htmlEnd === 'blank' || !htmlEnd.test(line)) html = htmlEnd
      paragraph = false
      continue
    }
    const match = line.match(FENCE_OPEN)
    if (match === null) {
      paragraph = continuesParagraph(line, paragraph)
      continue
    }
    const [, indent = '', fence = '', info = ''] = match
    // A backtick fence's info string never contains a backtick: that line is
    // inline code, not a fence.
    if (fence[0] === '`' && info.includes('`')) {
      paragraph = true
      continue
    }
    paragraph = false
    open = {
      char: fence[0] ?? '`',
      length: fence.length,
      indent: indent.length,
      lines: info.trim() === OBJECTIVE_INFO_STRING ? [] : null,
    }
  }
  if (open?.lines != null) {
    blocks.push(open.lines.join('\n'))
    return { blocks, unterminated: true }
  }
  return { blocks, unterminated: false }
}

/** How an HTML block ends: at a blank line, or on a line matching the pattern. */
type HtmlBlockEnd = 'blank' | RegExp

const HTML_BLOCK_NAMES =
  'address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|' +
  'dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h1|h2|h3|h4|h5|' +
  'h6|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|nav|noframes|ol|optgroup|' +
  'option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul'

const HTML_ATTRIBUTE = String.raw`\s+[A-Za-z_:][\w.:-]*(?:\s*=\s*(?:[^\s"'=<>\x60]+|'[^']*'|"[^"]*"))?`

/**
 * The CommonMark HTML block starts (types 1–7), each with its end condition.
 * Type 7, a complete tag alone on its line, cannot interrupt a paragraph.
 */
const HTML_BLOCK_STARTS: { start: RegExp; end: HtmlBlockEnd; interruptsParagraph: boolean }[] = [
  {
    start: /^ {0,3}<(?:pre|script|style|textarea)(?:[\s>]|$)/i,
    end: /<\/(?:pre|script|style|textarea)>/i,
    interruptsParagraph: true,
  },
  { start: /^ {0,3}<!--/, end: /-->/, interruptsParagraph: true },
  { start: /^ {0,3}<\?/, end: /\?>/, interruptsParagraph: true },
  { start: /^ {0,3}<![A-Za-z]/, end: />/, interruptsParagraph: true },
  { start: /^ {0,3}<!\[CDATA\[/, end: /\]\]>/, interruptsParagraph: true },
  {
    start: new RegExp(String.raw`^ {0,3}<\/?(?:${HTML_BLOCK_NAMES})(?:\s|\/?>|$)`, 'i'),
    end: 'blank',
    interruptsParagraph: true,
  },
  {
    start: new RegExp(
      String.raw`^ {0,3}(?:<[A-Za-z][A-Za-z0-9-]*(?:${HTML_ATTRIBUTE})*\s*\/?>|<\/[A-Za-z][A-Za-z0-9-]*\s*>)\s*$`,
    ),
    end: 'blank',
    interruptsParagraph: false,
  },
]

function htmlBlockStart(line: string, paragraph: boolean): HtmlBlockEnd | undefined {
  for (const { start, end, interruptsParagraph } of HTML_BLOCK_STARTS)
    if ((interruptsParagraph || !paragraph) && start.test(line)) return end
  return undefined
}

function isBlank(line: string): boolean {
  return /^[ \t]*$/.test(line)
}

/**
 * Whether a line that opens no fence or HTML block leaves an open paragraph
 * behind it, which only matters to whether the next line can start a type 7
 * HTML block. A blank line, an ATX heading or a thematic break leaves none, and
 * an indented line opens indented code unless it continues a paragraph.
 */
function continuesParagraph(line: string, paragraph: boolean): boolean {
  if (isBlank(line)) return false
  if (/^ {0,3}#{1,6}(?:[ \t]|$)/.test(line)) return false
  if (/^ {0,3}(?:(?:\*[ \t]*){3,}|(?:-[ \t]*){3,}|(?:_[ \t]*){3,})$/.test(line)) return false
  if (!paragraph && /^(?: {4}| {0,3}\t)/.test(line)) return false
  return true
}

function stripIndent(line: string, indent: number): string {
  let index = 0
  while (index < indent && line[index] === ' ') index += 1
  return line.slice(index)
}

/** The raw contents of every `autobuild-objective` block in a spec body. */
export function objectiveBlocks(body: string): string[] {
  return scanObjectiveFences(body).blocks
}

const positiveInt = z.number().int().min(1)

export const objectiveEpsilonSchema = z
  .strictObject({
    absolute: z.number().gt(0).optional(),
    relative: z.number().gt(0).lt(1).optional(),
  })
  .superRefine((epsilon, ctx) => {
    if ((epsilon.absolute === undefined) === (epsilon.relative === undefined))
      ctx.addIssue({ code: 'custom', message: 'set exactly one of absolute or relative' })
  })
export type ObjectiveEpsilon = z.infer<typeof objectiveEpsilonSchema>

const harnessSchema = z.array(pathSelectorSchema).min(1)

const commandMetricSchema = z.strictObject({
  kind: z.literal('command'),
  command: z.string().trim().min(1),
  direction: z.enum(['minimize', 'maximize']),
  samples: z.number().int().min(1).max(100),
  harness: harnessSchema,
})

const panelMetricSchema = z
  .strictObject({
    kind: z.literal('panel'),
    judges: z.number().int().min(1).max(20),
    rubric: pathSelectorSchema.refine(
      (rubric) => !/[*?]/.test(rubric),
      'must be a literal path, not a glob',
    ),
    harness: harnessSchema,
  })
  .superRefine((metric, ctx) => {
    if (!compilePathSelectors(metric.harness)(metric.rubric))
      ctx.addIssue({ code: 'custom', path: ['rubric'], message: 'must be inside metric.harness' })
  })

const metricSchema = z.discriminatedUnion('kind', [commandMetricSchema, panelMetricSchema])
export type ObjectiveMetric = z.infer<typeof metricSchema>

const BUDGET_MISSING = 'set budget.maxAttempts or budget.maxHours'

const budgetSchema = z
  .strictObject({
    maxAttempts: positiveInt.optional(),
    maxHours: z.number().gt(0).optional(),
  })
  .superRefine((budget, ctx) => {
    if (budget.maxAttempts === undefined && budget.maxHours === undefined)
      ctx.addIssue({ code: 'custom', message: BUDGET_MISSING })
  })

/** The objective, normalized with its defaults. This form is what events store. */
export const objectiveSchema = z
  .strictObject({
    purpose: z.string().trim().min(1),
    metric: metricSchema,
    target: z.strictObject({
      threshold: z.number().optional(),
      epsilon: objectiveEpsilonSchema,
    }),
    budget: budgetSchema,
    stop: z
      .strictObject({
        plateau: z.strictObject({ attempts: positiveInt }).optional(),
        mode: z.enum(['abort', 'drain']).default('abort'),
      })
      .default({ mode: 'abort' }),
    proposer: z.strictObject({ concurrency: positiveInt.default(1) }).default({ concurrency: 1 }),
  })
  .superRefine((objective, ctx) => {
    if (objective.metric.kind !== 'panel') return
    const { epsilon, threshold } = objective.target
    if (epsilon.absolute === undefined || epsilon.absolute >= 0.5)
      ctx.addIssue({
        code: 'custom',
        path: ['target', 'epsilon'],
        message: 'a panel accepts only an absolute epsilon below 0.5',
      })
    if (threshold !== undefined && !(threshold > 0.5 && threshold <= 1))
      ctx.addIssue({
        code: 'custom',
        path: ['target', 'threshold'],
        message: 'a panel threshold is a win rate in (0.5, 1]',
      })
  })
export type Objective = z.infer<typeof objectiveSchema>

/** The fields `ab objective` and `optimization.revise` may change. */
export const REVISABLE_FIELDS = [
  'threshold',
  'epsilon',
  'maxAttempts',
  'maxHours',
  'plateau',
  'stopMode',
  'concurrency',
] as const
export type RevisableField = (typeof REVISABLE_FIELDS)[number]

export const revisableChangesSchema = z
  .strictObject({
    threshold: z.number().optional(),
    epsilon: objectiveEpsilonSchema.optional(),
    maxAttempts: positiveInt.optional(),
    maxHours: z.number().gt(0).optional(),
    plateau: positiveInt.optional(),
    stopMode: z.enum(['abort', 'drain']).optional(),
    concurrency: positiveInt.optional(),
  })
  .refine((changes) => Object.keys(changes).length > 0, 'revise at least one field')
export type ObjectiveChanges = z.infer<typeof revisableChangesSchema>

/** Every field a ticket's block and the effective objective are compared on. */
export type ObjectiveField = 'purpose' | 'metric' | RevisableField

const COMMAND_ONLY = new Set(['command', 'direction', 'samples'])
const PANEL_ONLY = new Set(['judges', 'rubric'])

function fieldPath(path: readonly PropertyKey[]): string {
  let out = ''
  for (const segment of path) {
    if (typeof segment === 'number') out += `[${segment}]`
    else out += out === '' ? String(segment) : `.${String(segment)}`
  }
  return out
}

function describeIssue(issue: z.core.$ZodIssue, input: unknown): string {
  const path = fieldPath(issue.path)
  if (issue.code === 'unrecognized_keys') {
    const kind =
      path === 'metric' && input !== null && typeof input === 'object' && 'metric' in input
        ? (input.metric as { kind?: unknown } | null)?.kind
        : undefined
    return issue.keys
      .map((key) => {
        const field = path === '' ? key : `${path}.${key}`
        if (kind === 'panel' && COMMAND_ONLY.has(key))
          return `${field}: not allowed for a panel metric (panels always maximize the win rate)`
        if (kind === 'command' && PANEL_ONLY.has(key))
          return `${field}: not allowed for a command metric`
        return `unknown field ${field}`
      })
      .join('; ')
  }
  if (issue.code === 'invalid_union' && 'discriminator' in issue)
    return `${path}: must be "command" or "panel"`
  if (issue.code === 'invalid_type' && issue.message.endsWith('received undefined'))
    return `${path}: is required`
  return path === '' ? issue.message : `${path}: ${issue.message}`
}

export type ParsedObjective = { objective: Objective } | { absent: true } | { refusal: string }

/** Validate an already-parsed TOML table, naming the first failing field. */
export function validateObjective(input: unknown): { objective: Objective } | { refusal: string } {
  const parsed = objectiveSchema.safeParse(input)
  if (parsed.success) return { objective: parsed.data }
  const issues = parsed.error.issues
  const budget = issues.find(
    (issue) =>
      fieldPath(issue.path) === 'budget' &&
      (issue.message === BUDGET_MISSING || issue.code === 'invalid_type'),
  )
  if (budget !== undefined)
    return { refusal: `a budget limit in the ${OBJECTIVE_INFO_STRING} block: ${BUDGET_MISSING}` }
  return {
    refusal: `a valid ${OBJECTIVE_INFO_STRING} block: ${issues
      .map((issue) => describeIssue(issue, input))
      .join('; ')}`,
  }
}

/**
 * Find and validate a spec body's objective. `absent` means a plain node;
 * `refusal` names why the body cannot open as either kind.
 */
export function parseObjective(body: string): ParsedObjective {
  const scan = scanObjectiveFences(body)
  if (scan.blocks.length === 0) return { absent: true }
  if (scan.blocks.length > 1)
    return {
      refusal: `exactly one ${OBJECTIVE_INFO_STRING} block (found ${scan.blocks.length})`,
    }
  if (scan.unterminated)
    return { refusal: `a valid ${OBJECTIVE_INFO_STRING} block: the fence is never closed` }
  let table: unknown
  try {
    table = parseToml(scan.blocks[0] ?? '')
  } catch (error) {
    const detail =
      error instanceof TomlError
        ? `TOML syntax error at line ${error.line}: ${error.message.split('\n')[0]?.replace(/^Invalid TOML document: /, '')}`
        : `TOML syntax error: ${error instanceof Error ? error.message : String(error)}`
    return { refusal: `a valid ${OBJECTIVE_INFO_STRING} block: ${detail}` }
  }
  return validateObjective(table)
}

/** The reason a block refuses the work ticket that carries it. */
export const WORK_TICKET_OBJECTIVE_REFUSAL = `no ${OBJECTIVE_INFO_STRING} block in a work ticket: the block marks an optimization node (file it with --kind node)`
/** The reason an objective node cannot open without a rejected role. */
export const REJECTED_ROLE_REFUSAL =
  'a rejected role for optimization attempts: set [tickets].rejectedState'

/**
 * Why a ticket body cannot be dispatched as `kind` because of its objective
 * block. Empty when it may dispatch: no block, or one valid block on a node
 * whose ticket source has a rejected role.
 */
export function objectiveRefusals(
  body: string,
  context: { kind: 'work' | 'node'; rejectedState: string | undefined },
): string[] {
  const parsed = parseObjective(body)
  if ('absent' in parsed) return []
  if (context.kind === 'work') return [WORK_TICKET_OBJECTIVE_REFUSAL]
  const refusals = 'refusal' in parsed ? [parsed.refusal] : []
  if (context.rejectedState === undefined || context.rejectedState.trim() === '')
    refusals.push(REJECTED_ROLE_REFUSAL)
  return refusals
}

/** Apply quick revisions, oldest first, to an accepted objective. */
export function applyObjectiveRevisions(
  objective: Objective,
  changes: readonly ObjectiveChanges[],
): Objective {
  const next: Objective = structuredClone(objective)
  for (const change of changes) {
    if (change.threshold !== undefined) next.target.threshold = change.threshold
    if (change.epsilon !== undefined) next.target.epsilon = { ...change.epsilon }
    if (change.maxAttempts !== undefined) next.budget.maxAttempts = change.maxAttempts
    if (change.maxHours !== undefined) next.budget.maxHours = change.maxHours
    if (change.plateau !== undefined) next.stop.plateau = { attempts: change.plateau }
    if (change.stopMode !== undefined) next.stop.mode = change.stopMode
    if (change.concurrency !== undefined) next.proposer.concurrency = change.concurrency
  }
  return next
}

/** Key-order-independent JSON: persisted payloads do not preserve key order. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value !== null && typeof value === 'object')
    return `{${Object.keys(value)
      .filter((key) => (value as Record<string, unknown>)[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`)
      .join(',')}}`
  return JSON.stringify(value)
}

function fieldValues(objective: Objective): Record<ObjectiveField, unknown> {
  return {
    purpose: objective.purpose,
    metric: objective.metric,
    threshold: objective.target.threshold,
    epsilon: objective.target.epsilon,
    maxAttempts: objective.budget.maxAttempts,
    maxHours: objective.budget.maxHours,
    plateau: objective.stop.plateau?.attempts,
    stopMode: objective.stop.mode,
    concurrency: objective.proposer.concurrency,
  }
}

/**
 * The fields where the effective objective differs from a ticket's block.
 * Every field differs from a ticket whose block is gone or invalid.
 */
export function objectiveFieldDiff(
  effective: Objective,
  ticket: Objective | undefined,
): ObjectiveField[] {
  const mine = fieldValues(effective)
  const theirs = ticket === undefined ? undefined : fieldValues(ticket)
  return (Object.keys(mine) as ObjectiveField[]).filter(
    (field) => theirs === undefined || canonical(mine[field]) !== canonical(theirs[field]),
  )
}

/**
 * Whether accepting `next` after `previous` starts a new ruler: the metric
 * changed, or the purpose of a panel (judges read it). Measurements under an
 * older ruler are history and are never compared with new ones.
 */
export function objectiveRulerChanged(previous: Objective, next: Objective): boolean {
  if (canonical(previous.metric) !== canonical(next.metric)) return true
  return next.metric.kind === 'panel' && previous.purpose !== next.purpose
}

function formatEpsilon(epsilon: ObjectiveEpsilon): string {
  return epsilon.relative !== undefined
    ? `${+(epsilon.relative * 100).toFixed(6)}% relative`
    : `${epsilon.absolute} absolute`
}

/**
 * Render an objective as indented lines, marking every field in `revised`
 * with `(revised)`.
 */
export function formatObjective(
  objective: Objective,
  revised: ReadonlySet<string> = new Set(),
): string[] {
  const lines: string[] = []
  const line = (field: ObjectiveField, text: string) =>
    lines.push(revised.has(field) ? `${text} (revised)` : text)
  const [first = '', ...rest] = objective.purpose.trim().split('\n')
  line('purpose', `purpose: ${first}`)
  for (const more of rest) lines.push(`  ${more}`)
  const metric = objective.metric
  if (metric.kind === 'command')
    line(
      'metric',
      `metric: command \`${metric.command}\`, ${metric.direction}, ${metric.samples} samples`,
    )
  else line('metric', `metric: panel of ${metric.judges} judges, rubric ${metric.rubric}`)
  line('metric', `harness: ${metric.harness.join(', ')}`)
  line(
    'threshold',
    `threshold: ${objective.target.threshold === undefined ? 'none' : objective.target.threshold}`,
  )
  line('epsilon', `epsilon: ${formatEpsilon(objective.target.epsilon)}`)
  line(
    'maxAttempts',
    `max attempts: ${objective.budget.maxAttempts === undefined ? 'none' : objective.budget.maxAttempts}`,
  )
  line(
    'maxHours',
    `max hours: ${objective.budget.maxHours === undefined ? 'none' : objective.budget.maxHours}`,
  )
  line(
    'plateau',
    `plateau: ${objective.stop.plateau === undefined ? 'none' : `${objective.stop.plateau.attempts} attempts`}`,
  )
  line('stopMode', `stop mode: ${objective.stop.mode}`)
  line('concurrency', `concurrency: ${objective.proposer.concurrency}`)
  return lines
}
