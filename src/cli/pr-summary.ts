import type { AbEvent } from '../events/catalog'
import {
  currentPrAttachments,
  frozenPrImageHost,
  hostedPrAttachments,
} from '../kernel/pr-attachments'
import { normalizeVerifyCompletion } from '../events/payloads'
import type { CliEnv } from './env'

/** Replace controls that could alter a forge-rendered comment. */
export function printableCommentText(value: string): string {
  let out = ''
  for (const character of value) {
    const code = character.codePointAt(0)!
    if (character === '\n') out += character
    else if (code < 0x20 || code === 0x7f) out += `\\u{${code.toString(16)}}`
    else out += character
  }
  return out
}

export function html(value: string): string {
  return printableCommentText(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`
}

export function renderPrAttachmentSection(
  env: CliEnv,
  events: readonly AbEvent[],
): string[] {
  const designations = currentPrAttachments(events)
  if (designations.length === 0) return []

  const target = frozenPrImageHost(events)
  const hosted = hostedPrAttachments(events, designations)
  const lines = [
    '',
    '### PR attachments',
    '',
    'Download each exact BuildStore revision with the pinned command below.',
  ]

  for (const designation of designations) {
    const { artifact, filename, mediaType } = designation.payload
    const ref = `${artifact.kind}@${artifact.rev}`
    // Command-scoped parsing rejects flag-shaped values; retain the exact
    // basename while making a leading-dash filename unambiguously a path.
    const outputPath = filename.startsWith('-') ? `./${filename}` : filename
    const command =
      `ab artifact download ${shellQuote(env.build)} ${shellQuote(ref)} ` +
      `--output ${shellQuote(outputPath)} --store ${shellQuote(env.store)}`
    const hostedEvent = hosted.get(designation.seq)
    const imageUrl =
      mediaType.startsWith('image/') &&
      target !== undefined &&
      hostedEvent?.payload.asset.provider === target.provider &&
      hostedEvent.payload.asset.repository === target.repository &&
      hostedEvent.payload.asset.releaseId === target.releaseId
        ? hostedEvent.payload.asset.url
        : undefined

    lines.push(
      '',
      `#### <code>${html(filename)}</code>`,
      '',
      ...(imageUrl === undefined
        ? []
        : [
            `<img src="${html(imageUrl)}" alt="PR attachment ${html(filename)}">`,
            '',
          ]),
      `- artifact: <code>${html(ref)}</code>`,
      `- media type: <code>${html(mediaType)}</code>`,
      `<pre><code>${html(command)}</code></pre>`,
    )
  }
  return lines
}

/** The complete PR summary projection, rendered only from durable facts. */
export function renderPrSummary(env: CliEnv, events: readonly AbEvent[]): string {
  const verdicts: string[] = []
  const verifies: string[] = []
  for (const event of events) {
    if (event.type === 'plan-review.verdict' || event.type === 'code-review.verdict') {
      const phase = event.type === 'plan-review.verdict' ? 'plan-review' : 'code-review'
      const count = event.payload.findings.length
      const detail =
        event.payload.verdict === 'revise'
          ? ` (${count} finding${count === 1 ? '' : 's'})`
          : ''
      verdicts.push(
        `- ${phase} r${event.payload.round}: ${event.payload.verdict}${detail}`,
      )
    }
    if (event.type === 'verify.completed') {
      const result = normalizeVerifyCompletion(event.payload)
      const detail =
        result.outcome === 'skipped'
          ? ` — ${html(result.reason ?? '')}`
          : result.report !== undefined
            ? ` — <code>${html(`${result.report.kind}@${result.report.rev}`)}</code>`
            : ''
      verifies.push(
        `- <code>${html(result.step)}</code> (attempt ${result.attempt}): ${result.outcome}${detail}`,
      )
    }
  }

  return [
    `## Autobuild: ${html(env.build)}`,
    '',
    '### Verdict history',
    ...(verdicts.length > 0 ? verdicts : ['- (none)']),
    '',
    '### Verify',
    ...(verifies.length > 0 ? verifies : ['- (none)']),
    ...renderPrAttachmentSection(env, events),
    '',
    '### Store',
    `- store: <code>${html(env.store)}</code>`,
    `- build: <code>${html(env.build)}</code>`,
    '',
    'The full audit trail is queryable in the build store (§7.5).',
  ].join('\n')
}
