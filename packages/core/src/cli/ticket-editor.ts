import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { TicketSource, TicketUpdate } from '../ports/types'
import { parseTicketFile, serializeTicketFile } from '../ports/tickets/file-codec'
import { TicketRevisionUnsupported } from '../ports/tickets/revision'
import { requireTicket, updateTicket } from '../ports/tickets/operations'

export type TicketEditorRunner = (command: string, path: string) => Promise<number>

/** The configured editor is a shell command; only our generated path is quoted. */
export const runTicketEditor: TicketEditorRunner = async (command, path) => {
  const quoted = `'${path.replaceAll("'", "'\\''")}'`
  return Bun.spawn(['sh', '-c', `${command} ${quoted}`], {
    stdin: 'inherit',
    stdout: 'inherit',
    stderr: 'inherit',
  }).exited
}

export async function editTicket(
  source: TicketSource,
  id: string,
  env: Record<string, string | undefined>,
  stdout: (line: string) => void,
  runner: TicketEditorRunner = runTicketEditor,
): Promise<void> {
  if (!source.mutateIfRevision) throw new TicketRevisionUnsupported(source.name)
  const command = env.VISUAL?.trim() || env.EDITOR?.trim()
  if (!command) throw new Error('set VISUAL or EDITOR to edit a ticket')
  const ticket = await requireTicket(source, id)
  const front = {
    id,
    kind: ticket.kind ?? 'work',
    ...(ticket.target !== undefined ? { target: ticket.target } : {}),
    title: ticket.title,
    labels: [...ticket.labels],
    blockedBy: [...(ticket.blockedBy ?? [])],
    ...(ticket.creationKey !== undefined ? { idempotencyKey: ticket.creationKey } : {}),
  }
  // Reference comments remain part of the frontmatter, outside the editable keys.
  const reference = `# Read-only reference\n# target = ${JSON.stringify(ticket.target ?? null)} (root when null)\n# state = ${JSON.stringify(ticket.state ?? null)}\n# revision = ${JSON.stringify(ticket.revision)}\n`
  const serialized = serializeTicketFile({ ...front, kind: 'work' }, ticket.body).replace(
    '+++\n',
    `+++\nkind = ${JSON.stringify(front.kind)}\n`,
  )
  const original = serialized.replace('+++\n', `+++\n${reference}`)
  const directory = await mkdtemp(join(tmpdir(), 'ab-ticket-edit-'))
  const path = join(directory, 'ticket.md')
  await writeFile(path, original, { mode: 0o600 })
  try {
    const code = await runner(command, path)
    if (code !== 0) throw new Error(`editor exited with status ${code}`)
    const edited = await readFile(path, 'utf8')
    if (edited !== original) {
      const parsed = parseTicketFile(path, edited)
      const close = edited.indexOf('\n+++\n', 4)
      const comments = edited
        .slice(4, close)
        .split('\n')
        .filter((line) => line.trimStart().startsWith('#'))
        .join('\n')
      if (comments !== reference.trimEnd())
        throw new Error('read-only reference comments cannot change')
      if (
        parsed.front.kind !== front.kind ||
        parsed.front.target !== front.target ||
        parsed.front.id !== id ||
        parsed.front.idempotencyKey !== front.idempotencyKey ||
        JSON.stringify(parsed.front.blockedBy ?? []) !== JSON.stringify(front.blockedBy)
      )
        throw new Error('kind, target, id, idempotencyKey and blockedBy are read-only')
      const patch: TicketUpdate = {}
      if (parsed.front.title !== ticket.title) patch.title = parsed.front.title
      if (parsed.body !== ticket.body) patch.body = parsed.body
      if (JSON.stringify(parsed.front.labels) !== JSON.stringify(ticket.labels))
        patch.labels = parsed.front.labels
      if (Object.keys(patch).length > 0)
        await updateTicket(source, id, patch, false, ticket.revision)
    }
    await rm(directory, { recursive: true })
    stdout(`ticket edit complete: ${source.name}:${id}`)
  } catch (error) {
    throw new Error(
      `${error instanceof Error ? error.message : String(error)}; edited text kept at ${path}`,
      { cause: error },
    )
  }
}
