import { parse as parseToml } from 'smol-toml'
import { z } from 'zod'
import type { Config } from '../config/schema'

const planMetadataSchema = z.strictObject({
  verifySteps: z.array(
    z
      .string()
      .min(1, 'verify step names must be nonempty')
      .refine((step) => step.trim() === step, 'verify step names must not be blank or padded'),
  ),
})

/**
 * Read an opening TOML `+++` front-matter block. A document without an
 * opening fence has no metadata; once an opening fence is attempted, malformed
 * fences are errors rather than silently becoming Markdown body text.
 */
function parsePlanMetadata(plan: string): z.infer<typeof planMetadataSchema> | undefined {
  if (!plan.startsWith('+++')) return undefined

  const firstBreak = plan.indexOf('\n')
  const opening = (firstBreak === -1 ? plan : plan.slice(0, firstBreak)).replace(/\r$/, '')
  if (opening !== '+++') {
    throw new Error('plan front matter has a malformed opening fence — expected a line containing only "+++"')
  }
  if (firstBreak === -1) {
    throw new Error('plan front matter is missing its closing "+++" fence')
  }

  const metadataStart = firstBreak + 1
  let cursor = metadataStart
  let metadataEnd: number | undefined
  while (cursor <= plan.length) {
    const nextBreak = plan.indexOf('\n', cursor)
    const lineEnd = nextBreak === -1 ? plan.length : nextBreak
    const line = plan.slice(cursor, lineEnd).replace(/\r$/, '')
    if (line === '+++') {
      metadataEnd = cursor
      break
    }
    if (nextBreak === -1) break
    cursor = nextBreak + 1
  }
  if (metadataEnd === undefined) {
    throw new Error('plan front matter is missing its closing "+++" fence')
  }

  let parsed: unknown
  try {
    parsed = parseToml(plan.slice(metadataStart, metadataEnd))
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(`plan front matter is not valid TOML: ${message}`)
  }

  const result = planMetadataSchema.safeParse(parsed)
  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => `  ${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('\n')
    throw new Error(`plan front matter is invalid:\n${issues}`)
  }
  return result.data
}

/**
 * Resolve a plan's requested verification set against repository config.
 *
 * Missing front matter preserves the historical default (all configured
 * steps). An explicit list is a set, while returned order always comes from
 * `[verify].steps`. `always = true` is the mandatory/non-deselectable marker.
 */
export function resolvePlanVerifySteps(plan: string, config: Config): string[] {
  const metadata = parsePlanMetadata(plan)
  if (metadata === undefined) return [...config.verify.steps]

  const selected = new Set<string>()
  for (const step of metadata.verifySteps) {
    if (selected.has(step)) {
      throw new Error(`plan verifySteps contains duplicate step ${JSON.stringify(step)}`)
    }
    selected.add(step)

    if (
      !config.verify.steps.includes(step) ||
      !Object.hasOwn(config.verify.stepConfigs, step)
    ) {
      throw new Error(
        `plan verifySteps names unknown step ${JSON.stringify(step)} — ` +
          `no [verify.${step}] table is configured`,
      )
    }
  }

  for (const step of config.verify.steps) {
    if (config.verify.stepConfigs[step]?.always === true && !selected.has(step)) {
      throw new Error(
        `plan verifySteps omits mandatory step ${JSON.stringify(step)} — ` +
          `[verify.${step}].always = true steps cannot be deselected`,
      )
    }
  }

  return config.verify.steps.filter((step) => selected.has(step))
}
