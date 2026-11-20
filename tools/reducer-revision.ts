/** Append a reducer revision to the ledger after changing a reducer's
 * accumulator shape or fold semantics:
 * bun tools/reducer-revision.ts <shape|fold> <identity>... --reason "AUT-123 …"
 * Each identity gets one line with a fresh random id, so concurrent branches
 * never add the same line and their revisions merge by union. */
import { readFile, writeFile } from 'node:fs/promises'
import '../packages/core/src/kernel/reducer-registry'
import {
  IDENTIFIED,
  REGENERATE_COMMAND,
  appendRevision,
} from '../packages/core/src/kernel/reducer-identity'

export { appendRevision }

const LEDGER = new URL('../packages/core/src/kernel/reducer-revisions.ts', import.meta.url)
const ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz'

/** Ten random base36 characters. */
export function revisionId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(10))
  return Array.from(bytes, (byte) => ALPHABET[byte % ALPHABET.length]).join('')
}

const USAGE = 'usage: bun tools/reducer-revision.ts <shape|fold> <identity>... --reason "AUT-123 …"'

async function main(argv: string[]): Promise<void> {
  const at = argv.indexOf('--reason')
  const reason = at >= 0 ? argv[at + 1] : undefined
  const positional = at >= 0 ? [...argv.slice(0, at), ...argv.slice(at + 2)] : argv
  const [kind, ...identities] = positional
  if ((kind !== 'shape' && kind !== 'fold') || !identities.length || reason === undefined)
    throw new Error(USAGE)
  for (const identity of identities)
    if (!IDENTIFIED.has(identity))
      throw new Error(
        `unknown reducer identity ${identity}; known: ${[...IDENTIFIED].sort().join(', ')}`,
      )
  let source = await readFile(LEDGER, 'utf8')
  for (const identity of identities)
    source = appendRevision(source, { identity, kind, reason, id: revisionId() })
  await writeFile(LEDGER, source)
  console.log(`appended ${identities.length} ${kind} revision(s); now regenerate the identity
records and accumulator shapes:\n  ${REGENERATE_COMMAND}`)
}

if (import.meta.main)
  await main(process.argv.slice(2)).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error)
    process.exit(1)
  })
