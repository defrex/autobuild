/** Stable change identity, independent of commit object ids. */
const KEY = 'Autobuild-Build'

export function validateBuildSlug(slug: string): void {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) {
    throw new Error(`invalid build slug: ${JSON.stringify(slug)}`)
  }
}

interface Trailer {
  key: string
  value: string
  raw: string
}

/** Only the terminal paragraph can be a trailer block. Continuations belong
 * to the preceding trailer; prose elsewhere is never identity evidence. */
function splitTrailers(
  message: string,
  allowStandalone = true,
): { prefix: string; trailers: Trailer[] } {
  const content = message.replace(/(?:\r?\n)+$/, '')
  const boundaries = [...content.matchAll(/\r?\n(?:[ \t]*\r?\n)+/g)]
  const boundary = boundaries.at(-1)
  const start = boundary === undefined ? 0 : boundary.index + boundary[0].length
  if (boundary === undefined && !allowStandalone) return { prefix: content, trailers: [] }
  const lines = content.slice(start).split('\n')
  const trailers: Trailer[] = []
  for (const line of lines) {
    const match = /^([A-Za-z0-9-]+)[ \t]*:[ \t]*(.*)\r?$/.exec(line)
    if (match) {
      trailers.push({ key: match[1]!, value: match[2]!.trim(), raw: line })
    } else if (/^[ \t]+\S/.test(line) && trailers.length > 0) {
      const last = trailers[trailers.length - 1]!
      last.value += `\n${line.trim()}`
      last.raw += `\n${line}`
    } else {
      trailers.push({ key: '', value: '', raw: line })
    }
  }
  const entries = trailers.filter((entry) => entry.key !== '')
  // Git accepts mixed prose/trailer paragraphs only when a generated signoff
  // is present and trailers make up at least a quarter of the paragraph.
  if (
    entries.length !== trailers.length &&
    !(
      entries.some((entry) => entry.key.toLowerCase() === 'signed-off-by') &&
      entries.length * 4 >= trailers.length
    )
  ) {
    return { prefix: content, trailers: [] }
  }
  return { prefix: content.slice(0, start), trailers }
}

export function buildTrailers(message: string): string[] {
  return splitTrailers(message, false)
    .trailers.filter((entry) => entry.key.toLowerCase() === KEY.toLowerCase())
    .map((entry) => entry.value)
}

export function hasBuildTrailer(message: string, slug: string): boolean {
  validateBuildSlug(slug)
  return buildTrailers(message).includes(slug)
}

/** Preserve non-identity bytes, use LF for new separators, and emit exactly
 * one final newline. Empty bodies become a trailer-only message. */
export function withBuildTrailer(
  message: string,
  slug: string,
  options: { includesSubject?: boolean } = {},
): string {
  validateBuildSlug(slug)
  const { prefix, trailers } = splitTrailers(message, options.includesSubject !== true)
  const kept = trailers.filter((entry) => entry.key.toLowerCase() !== KEY.toLowerCase())
  let body = prefix + kept.map((entry) => entry.raw).join('\n')
  if (kept.length > 0) body += '\n'
  else if (
    (body !== '' || options.includesSubject === true) &&
    !/(?:\r?\n)[ \t]*(?:\r?\n)$/.test(body)
  )
    body += '\n\n'
  return `${body}${KEY}: ${slug}\n`
}

export async function historyContainsBuild(
  messages: AsyncIterable<string>,
  slug: string,
): Promise<boolean> {
  validateBuildSlug(slug)
  for await (const message of messages) if (hasBuildTrailer(message, slug)) return true
  return false
}
