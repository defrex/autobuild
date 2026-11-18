/**
 * `ab judge context` and `ab judge prefer` (SPEC §8.2, §13.1.1): a judge
 * session's only commands. Context reads only the brief the runner wrote into
 * the judge's root and the rubric under `A/`; it makes no store read. Prefer
 * is the judge's typed terminal: one `panel.preferred` through its write-only
 * store handle.
 */
import { access, mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import { agentActor } from '../events/envelope'
import type { EventEnvelope } from '../events/catalog'
import type { BuildStore } from '../store/types'
import type { JudgeCliEnv } from './env'

export interface JudgeCliDeps {
  store: BuildStore
  env: JudgeCliEnv
  /** The judge's root: its working directory. */
  workspacePath: string
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
export const JUDGE_PREFERENCES = ['A', 'B', 'tie'] as const
export type JudgePreference = (typeof JUDGE_PREFERENCES)[number]

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

/** The judge's typed terminal: validate, refuse a second call, append the
 * preference, then mark the terminal locally. */
export async function recordPreference(
  deps: JudgeCliDeps,
  input: { preference: string; reason: string },
): Promise<EventEnvelope<'panel.preferred'>> {
  if (!(JUDGE_PREFERENCES as readonly string[]).includes(input.preference))
    throw new Error(
      `preference "${input.preference}" is not one of A, B or tie — ` +
        'usage: ab judge prefer <A|B|tie> --reason "<one paragraph citing the rubric>"',
    )
  if (input.reason.trim() === '')
    throw new Error('--reason is blank — justify the preference against the rubric and purpose')
  const marker = join(deps.workspacePath, deps.env.contextDir, TERMINAL_MARKER)
  const marked = await access(marker).then(
    () => true,
    () => false,
  )
  if (marked)
    throw new Error('this judge already recorded its preference; a judge prefers exactly once')
  const event = await deps.store.append(deps.env.build, {
    actor: agentActor('judge', deps.env.session),
    type: 'panel.preferred',
    payload: {
      panel: deps.env.panel,
      judge: deps.env.judge,
      session: deps.env.session,
      preference: input.preference as JudgePreference,
      reason: input.reason,
    },
  })
  await mkdir(join(deps.workspacePath, deps.env.contextDir), { recursive: true })
  await writeFile(marker, `${event.seq}\n`)
  return event
}
