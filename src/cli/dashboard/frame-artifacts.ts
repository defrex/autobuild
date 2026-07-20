import { z } from 'zod'

/** Versioned, report-embedded link between one captured terminal frame and its
 * exact BuildStore text/PNG revisions. */

const artifactRef = z.strictObject({
  kind: z.string().min(1),
  rev: z.number().int().nonnegative(),
})

const frame = z.strictObject({
  id: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
  terminal: z.strictObject({
    columns: z.number().int().positive(),
    rows: z.number().int().positive(),
  }),
  text: artifactRef,
  png: artifactRef,
})

export const dashboardFrameManifestSchema = z
  .strictObject({
    version: z.literal(1),
    renderer: z.literal('dashboard-ansi-png-v1'),
    frames: z.array(frame).min(1),
  })
  .superRefine((manifest, context) => {
    const ids = new Set<string>()
    for (const [index, item] of manifest.frames.entries()) {
      if (ids.has(item.id)) {
        context.addIssue({
          code: 'custom',
          path: ['frames', index, 'id'],
          message: `duplicate frame id "${item.id}"`,
        })
      }
      ids.add(item.id)
      const expectedText = dashboardFrameArtifactKind(item.id, 'text')
      const expectedPng = dashboardFrameArtifactKind(item.id, 'png')
      if (item.text.kind !== expectedText) {
        context.addIssue({
          code: 'custom',
          path: ['frames', index, 'text', 'kind'],
          message: `expected stable kind "${expectedText}"`,
        })
      }
      if (item.png.kind !== expectedPng) {
        context.addIssue({
          code: 'custom',
          path: ['frames', index, 'png', 'kind'],
          message: `expected stable kind "${expectedPng}"`,
        })
      }
    }
  })

export type DashboardFrameManifest = z.infer<
  typeof dashboardFrameManifestSchema
>
export type DashboardFrameEntry = DashboardFrameManifest['frames'][number]
export type DashboardFrameArtifactType = 'text' | 'png'

export function dashboardFrameArtifactKind(
  id: string,
  type: DashboardFrameArtifactType,
): string {
  return `dashboard-frame:${id}:${type}`
}

export const DASHBOARD_MANIFEST_START =
  '<!-- autobuild-dashboard-frame-manifest:v1 -->'
export const DASHBOARD_MANIFEST_END =
  '<!-- /autobuild-dashboard-frame-manifest -->'

/** Initial report written by the deterministic capture command. The verifier
 * appends image-based observations below the checklist before depositing it. */
export function dashboardVerifyReport(
  input: DashboardFrameManifest,
): string {
  const manifest = dashboardFrameManifestSchema.parse(input)
  return [
    '# Dashboard frame verification',
    '',
    'The deterministic capture completed. Inspect every PNG; do not reach a verdict from the text copies.',
    '',
    DASHBOARD_MANIFEST_START,
    '```json',
    JSON.stringify(manifest, null, 2),
    '```',
    DASHBOARD_MANIFEST_END,
    '',
    '## Visual checklist',
    '',
    '- [ ] Every PNG opens and contains a non-empty dashboard frame.',
    '- [ ] Build rows, status columns, progress rows, and separators do not overlap.',
    '- [ ] The Harvest row is legible and follows the same row grammar as builds.',
    '- [ ] The narrow frame truncates or wraps deliberately without clipping or leaking control text.',
    '- [ ] Colour emphasis is present while status and intent remain readable without colour.',
    '',
    '## Visual observations',
    '',
    '<!-- The verifier records criterion-by-criterion observations here. -->',
    '',
  ].join('\n')
}

/** Extract the one exact manifest from a report that may contain later agent
 * observations. Missing, duplicated, malformed, or schema-invalid blocks are
 * loud errors; finalize catches them and safely omits the optional section. */
export function extractDashboardFrameManifest(
  report: string,
): DashboardFrameManifest {
  const starts = report.split(DASHBOARD_MANIFEST_START).length - 1
  const ends = report.split(DASHBOARD_MANIFEST_END).length - 1
  if (starts !== 1 || ends !== 1) {
    throw new Error(
      `dashboard verify report must contain exactly one manifest block (found ${starts} start marker(s), ${ends} end marker(s))`,
    )
  }
  const start = report.indexOf(DASHBOARD_MANIFEST_START) +
    DASHBOARD_MANIFEST_START.length
  const end = report.indexOf(DASHBOARD_MANIFEST_END, start)
  if (end < start) {
    throw new Error('dashboard verify report manifest markers are out of order')
  }
  const body = report.slice(start, end).trim()
  const fenced = /^```json\s*\n([\s\S]*?)\n```\s*$/.exec(body)
  if (fenced === null) {
    throw new Error('dashboard verify report manifest must be one fenced JSON value')
  }
  let decoded: unknown
  try {
    decoded = JSON.parse(fenced[1]!)
  } catch (error) {
    throw new Error(
      `dashboard verify report manifest is not valid JSON: ${
        error instanceof Error ? error.message : String(error)
      }`,
    )
  }
  const parsed = dashboardFrameManifestSchema.safeParse(decoded)
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('; ')
    throw new Error(`dashboard verify report manifest is invalid: ${issues}`)
  }
  return parsed.data
}
