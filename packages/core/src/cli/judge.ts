/**
 * `ab judge context` and `ab judge prefer` (SPEC §8.2, §13.1.1): a judge
 * session's only commands. Context reads only the brief the runner wrote into
 * the judge's root and the rubric under `A/`; it makes no store read. Prefer
 * is the judge's typed terminal: one `panel.preferred`, appended through the
 * judge's write-only store handle when it holds one (a remote store), or saved
 * once to its outbox in the root for the runner to commit (a local store,
 * whose path a judge never learns).
 *
 * Both the full `ab` CLI and the self-contained judge launcher (`judge-entry`)
 * route here, so the two cannot drift.
 */
import { access, mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import { agentActor } from '../events/envelope'
import type { EventEnvelope } from '../events/catalog'
import { AccountRedactor } from '../store/account-redaction'
import type { JudgePreferenceOutbox } from '../store/judge-authority'
import type { BuildStore } from '../store/types'
import { parseArgs, stringFlag } from './args'
import type { JudgeCliEnv } from './env'

export interface JudgeCliDeps {
  /** The judge's write-only store handle; absent for a local store, whose
   * judges save their preference to the outbox instead. */
  store?: BuildStore
  env: JudgeCliEnv
  /** The judge's root: its working directory. */
  workspacePath: string
  /** Redacts account secrets from a reason saved to the outbox; a store
   * handle applies its own redaction. */
  redact?: (text: string) => string
}

export interface JudgeContextManifest {
  judge: number
  variants: { A: 'A'; B: 'B' }
  purpose: 'purpose.md'
  rubric: 'rubric.md'
  allowedTerminals: ['prefer']
}

const briefSchema = z.object({
  judge: z.number().int().min(1),
  purpose: z.string().min(1),
  rubric: z.string().min(1),
})

const TERMINAL_MARKER = 'terminal'
/** The outbox's name in the judge's context directory. */
export const JUDGE_OUTBOX_NAME = 'preference.json'
export const JUDGE_PREFERENCES = ['A', 'B', 'tie'] as const
export type JudgePreference = (typeof JUDGE_PREFERENCES)[number]

const ALREADY_PREFERRED = 'this judge already recorded its preference; a judge prefers exactly once'

/** Materialize the judge's context from its brief and the rubric under `A/`
 * (both variants carry the same pinned rubric). Reads no store. */
export async function buildJudgeContext(
  deps: Pick<JudgeCliDeps, 'env' | 'workspacePath'>,
): Promise<JudgeContextManifest> {
  const dir = join(deps.workspacePath, deps.env.contextDir)
  let brief: z.infer<typeof briefSchema>
  try {
    brief = briefSchema.parse(JSON.parse(await readFile(join(dir, 'brief.json'), 'utf8')))
  } catch (error) {
    throw new Error(
      `the judge brief at ${deps.env.contextDir}/brief.json is missing or malformed — ` +
        `run 'ab judge context' from the judge's root (${error instanceof Error ? error.message : String(error)})`,
    )
  }
  const rubric = await readFile(join(deps.workspacePath, 'A', brief.rubric), 'utf8')
  const manifest: JudgeContextManifest = {
    judge: brief.judge,
    variants: { A: 'A', B: 'B' },
    purpose: 'purpose.md',
    rubric: 'rubric.md',
    allowedTerminals: ['prefer'],
  }
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'purpose.md'), `${brief.purpose}\n`)
  await writeFile(join(dir, 'rubric.md'), rubric)
  await writeFile(join(dir, 'context.json'), `${JSON.stringify(manifest, null, 2)}\n`)
  return manifest
}

export type RecordedPreference =
  | { kind: 'recorded'; event: EventEnvelope<'panel.preferred'> }
  | { kind: 'saved'; preference: JudgePreference }

/** The judge's typed terminal: validate, refuse a second call, then append
 * the preference and mark the terminal locally, or, with no store, save it
 * to the outbox with an exclusive create that a second or racing call loses. */
export async function recordPreference(
  deps: JudgeCliDeps,
  input: { preference: string; reason: string },
): Promise<RecordedPreference> {
  if (!(JUDGE_PREFERENCES as readonly string[]).includes(input.preference))
    throw new Error(
      `preference "${input.preference}" is not one of A, B or tie — ` +
        'usage: ab judge prefer <A|B|tie> --reason "<one paragraph citing the rubric>"',
    )
  if (input.reason.trim() === '')
    throw new Error('--reason is blank — justify the preference against the rubric and purpose')
  const dir = join(deps.workspacePath, deps.env.contextDir)
  const marker = join(dir, TERMINAL_MARKER)
  const marked = await access(marker).then(
    () => true,
    () => false,
  )
  if (marked) throw new Error(ALREADY_PREFERRED)
  const preference = input.preference as JudgePreference
  if (deps.store === undefined) {
    const saved: JudgePreferenceOutbox = {
      panel: deps.env.panel,
      judge: deps.env.judge,
      session: deps.env.session,
      preference,
      reason: deps.redact ? deps.redact(input.reason) : input.reason,
    }
    await mkdir(dir, { recursive: true })
    try {
      await writeFile(join(dir, JUDGE_OUTBOX_NAME), `${JSON.stringify(saved)}\n`, { flag: 'wx' })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new Error(ALREADY_PREFERRED)
      throw error
    }
    return { kind: 'saved', preference }
  }
  const event = await deps.store.append(deps.env.build, {
    actor: agentActor('judge', deps.env.session),
    type: 'panel.preferred',
    payload: {
      panel: deps.env.panel,
      judge: deps.env.judge,
      session: deps.env.session,
      preference,
      reason: input.reason,
    },
  })
  await mkdir(dir, { recursive: true })
  await writeFile(marker, `${event.seq}\n`)
  return { kind: 'recorded', event }
}

/** Inputs to `ab judge …`, whichever entry routed it. */
export interface JudgeCommandDeps {
  store?: BuildStore
  judgeEnv?: JudgeCliEnv
  workspacePath: string
  redact?: (text: string) => string
}

function requireJudgeSession(command: string, deps: JudgeCommandDeps): JudgeCliDeps {
  if (deps.judgeEnv === undefined)
    throw new Error(
      `'ab judge ${command}' runs inside a judge session — the runner sets ` +
        'AB_JUDGE, AB_SESSION and AB_CONTEXT_DIR (and AB_STORE for a remote store).',
    )
  return {
    env: deps.judgeEnv,
    workspacePath: deps.workspacePath,
    ...(deps.store !== undefined ? { store: deps.store } : {}),
    ...(deps.redact !== undefined ? { redact: deps.redact } : {}),
  }
}

/** `ab judge <context|prefer> …`; `rest` follows the `judge` word. */
export async function runJudgeCommand(
  rest: readonly string[],
  deps: JudgeCommandDeps,
  stdout: (line: string) => void,
): Promise<number> {
  const [sub, ...more] = rest
  if (sub === 'context') {
    const usage = 'usage: ab judge context [--json]'
    const parsed = parseArgs(more, { json: 'boolean' }, usage)
    if (parsed.positionals.length > 0) throw new Error(usage)
    const judge = requireJudgeSession('context', deps)
    const manifest = await buildJudgeContext(judge)
    if (parsed.flags.get('json') === true) stdout(JSON.stringify(manifest, null, 2))
    else {
      stdout(`judge context materialized for judge ${manifest.judge}`)
      stdout(`variants: A/ and B/`)
      stdout(`directory: ${judge.env.contextDir}`)
      stdout(`  purpose.md — what the work is for`)
      stdout(`  rubric.md — the criteria to compare the variants against`)
      stdout(`allowed terminal: prefer`)
    }
    return 0
  }
  if (sub === 'prefer') {
    const usage = 'usage: ab judge prefer <A|B|tie> (--reason <text> | --reason-file <file>)'
    const parsed = parseArgs(more, { reason: 'value', 'reason-file': 'value' }, usage)
    const [preference] = parsed.positionals
    const inline = stringFlag(parsed, 'reason')
    const file = stringFlag(parsed, 'reason-file')
    if (
      preference === undefined ||
      parsed.positionals.length !== 1 ||
      (inline === undefined) === (file === undefined)
    )
      throw new Error(usage)
    const judge = requireJudgeSession('prefer', deps)
    const reason = inline ?? (await readFile(file!, 'utf8'))
    const result = await recordPreference(judge, { preference, reason })
    if (result.kind === 'recorded')
      stdout(
        `${result.event.type} recorded: ${result.event.payload.preference} (seq ${result.event.seq})`,
      )
    else
      stdout(
        `panel.preferred saved: ${result.preference} — the runner records it when this session ends`,
      )
    return 0
  }
  throw new Error('usage: ab judge <context|prefer> …')
}

/** The account-secret redaction a judge's outbox reason gets, from the
 * runner-supplied credential variable inventory. */
export function judgeAccountRedaction(
  env: Record<string, string | undefined>,
): ((text: string) => string) | undefined {
  const raw = env.AB_ACCOUNT_CREDENTIAL_ENVS
  if (!raw) return undefined
  const names: unknown = JSON.parse(raw)
  if (!Array.isArray(names) || !names.every((name) => typeof name === 'string'))
    throw new Error('Invalid account credential variable inventory')
  const redactor = new AccountRedactor(() => names.map((name) => env[name]))
  return (text) => redactor.text(text)
}
