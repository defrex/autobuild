/**
 * Serving a repository's agent context to connected agents (#1225).
 *
 * The dispatcher captures the base branch's skills and agent instructions
 * into one record (`store/agent-context.ts`). This module turns that record,
 * or the canonical skills bundled with the serving Autobuild when a
 * repository has none, into what an MCP client needs for progressive
 * disclosure:
 *
 * - the index (`context.list`): skills with descriptions and files, agent
 *   instructions with scopes, and which to load before operating or ticket
 *   work;
 * - one file (`context.read`), found by path or by a relative link from
 *   another file, with a generated preamble that maps the `ab` commands the
 *   text mentions onto the operator tools (`operator/cli-equivalents.ts`) and
 *   frames agent instructions as the repository's own file;
 * - the server-instruction section and the MCP prompt identities.
 *
 * It is pure: no store, no filesystem. Every binding (hosted `/mcp`, the
 * per-repository endpoint, `ab mcp`) renders through it, so wording and
 * prompt names cannot drift between them.
 */
import { createHash } from 'node:crypto'
import type { DistSkill } from '../cli/init'
import { normalizeRepoPath } from '../processes/agent-context-assemble'
import { contentBytes, type AgentContextRecord } from '../store/agent-context'
import { cliMentions, renderCliMapping } from './cli-equivalents'

/** The canonical skills bundled with the serving Autobuild, in install form. */
export interface CanonicalSkillBundle {
  version: string
  skills: readonly Pick<DistSkill, 'installName' | 'files'>[]
}

export type ContextSource = 'captured' | 'canonical'
export type ContextFileKind = 'skill' | 'skill-file' | 'instructions' | 'import'

interface ContextFile {
  path: string
  aliases: string[]
  kind: ContextFileKind
  skill?: string
  scope?: string
  importedBy?: string[]
  text?: string
  base64?: string
}

/** A uniform view over a captured record or the canonical bundle. */
export interface ContextView {
  source: ContextSource
  commit: string | null
  baseBranch?: string
  version?: string
  files: ContextFile[]
  skills: { name: string; paths: string[]; entry: string; files: string[] }[]
  instructions: { path: string; aliases: string[]; scope: string; imports: string[] }[]
  imports: { path: string; importedBy: string[] }[]
  links: { path: string; target: string }[]
  omitted: { path: string; reason: string }[]
}

export interface ContextIndex {
  repo: string
  source: ContextSource
  commit: string | null
  baseBranch?: string
  version?: string
  notice?: string
  skills: {
    name: string
    description: string | null
    paths: string[]
    entry: string
    files: string[]
  }[]
  instructions: { path: string; aliases: string[]; scope: string; imports: string[] }[]
  imports: { path: string; importedBy: string[] }[]
  load: { beforeOperating: string[]; beforeTicketWork: string[] }
}

export type ContextReadResult = {
  path: string
  kind: ContextFileKind
  skill?: string
  scope?: string
  source: ContextSource
  commit: string | null
  links: { href: string; path: string }[]
} & ({ text: string } | { contentBase64: string })

export type ContextReadOutcome =
  | ({ kind: 'found' } & { result: ContextReadResult })
  | { kind: 'not-found'; message: string }

const SKILL_FILE = 'SKILL.md'
const OPERATE_SKILL = 'ab-operate'
const TICKET_SKILLS = ['ab-spec', 'ab-tickets'] as const

const utf8 = new TextDecoder('utf-8')

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

function body(entry: { text?: string; base64?: string; oid: string; bytes: number }): {
  text?: string
  base64?: string
} {
  if (entry.text !== undefined) return { text: entry.text }
  return { base64: Buffer.from(contentBytes(entry)).toString('base64') }
}

/** Build the view: the record when one is captured, else the bundle. */
export function contextSource(
  record: AgentContextRecord | null,
  bundle: CanonicalSkillBundle | null,
): ContextView {
  if (record !== null) {
    const files: ContextFile[] = []
    const skills: ContextView['skills'] = []
    for (const skill of record.skills) {
      const [primary, ...others] = skill.paths
      const paths: string[] = []
      for (const file of skill.files) {
        const path = `${primary}/${file.path}`
        paths.push(path)
        files.push({
          path,
          aliases: others.map((other) => `${other}/${file.path}`),
          kind: file.path === SKILL_FILE ? 'skill' : 'skill-file',
          skill: skill.name,
          ...body(file),
        })
      }
      skills.push({
        name: skill.name,
        paths: skill.paths,
        entry: `${primary}/${SKILL_FILE}`,
        files: paths,
      })
    }
    const instructions = record.instructions.map((entry) => {
      const [path, ...aliases] = entry.paths as [string, ...string[]]
      files.push({ path, aliases, kind: 'instructions', scope: entry.directory, ...body(entry) })
      return { path, aliases, scope: entry.directory, imports: entry.imports }
    })
    // Repository root first, then by path.
    instructions.sort(
      (a, b) => Number(a.scope !== '') - Number(b.scope !== '') || compare(a.path, b.path),
    )
    const imports = record.imports.map((entry) => {
      files.push({
        path: entry.path,
        aliases: [],
        kind: 'import',
        importedBy: entry.importedBy,
        ...body(entry),
      })
      return { path: entry.path, importedBy: entry.importedBy }
    })
    return {
      source: 'captured',
      commit: record.commit,
      baseBranch: record.baseBranch,
      files,
      skills,
      instructions,
      imports,
      links: record.links,
      omitted: record.omitted,
    }
  }
  if (bundle === null) throw new Error('no captured record and no canonical skill bundle')
  const files: ContextFile[] = []
  const skills: ContextView['skills'] = []
  for (const skill of bundle.skills) {
    const root = `.agents/skills/${skill.installName}`
    const paths: string[] = []
    for (const file of skill.files) {
      const path = `${root}/${file.path}`
      paths.push(path)
      files.push({
        path,
        aliases: [`.claude/skills/${skill.installName}/${file.path}`],
        kind: file.path === SKILL_FILE ? 'skill' : 'skill-file',
        skill: skill.installName,
        text: file.content,
      })
    }
    skills.push({
      name: skill.installName,
      paths: [root, `.claude/skills/${skill.installName}`],
      entry: `${root}/${SKILL_FILE}`,
      files: paths,
    })
  }
  return {
    source: 'canonical',
    commit: null,
    version: bundle.version,
    files,
    skills,
    instructions: [],
    imports: [],
    links: [],
    omitted: [],
  }
}

// ── Frontmatter ─────────────────────────────────────────────────────────────

function unquote(value: string): string {
  const trimmed = value.trim()
  if (trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')) {
    try {
      return JSON.parse(trimmed) as string
    } catch {
      return trimmed.slice(1, -1)
    }
  }
  if (trimmed.length >= 2 && trimmed.startsWith("'") && trimmed.endsWith("'"))
    return trimmed.slice(1, -1).replaceAll("''", "'")
  return trimmed
}

/** `description` from a SKILL.md YAML frontmatter: a single-line plain or
 * quoted value, or a folded (`>`) or literal (`|`) block scalar. Null when
 * the frontmatter is absent or the field cannot be read. */
export function skillDescription(text: string): string | null {
  const lines = text.replace(/^�/, '').split(/\r?\n/)
  if (lines[0]?.trim() !== '---') return null
  const close = lines.findIndex((line, index) => index > 0 && line.trim() === '---')
  if (close < 0) return null
  const front = lines.slice(1, close)
  const at = front.findIndex((line) => /^description\s*:/.test(line))
  if (at < 0) return null
  const value = front[at]!.replace(/^description\s*:/, '').trim()
  const block = /^([>|])[+-]?\d*$/.exec(value)
  if (block === null) {
    if (value === '') return null
    return unquote(value) || null
  }
  const continued: string[] = []
  for (const line of front.slice(at + 1)) {
    if (line.trim() !== '' && !/^\s/.test(line)) break
    continued.push(line.trim())
  }
  while (continued.at(-1) === '') continued.pop()
  if (continued.length === 0) return null
  if (block[1] === '|') return continued.join('\n')
  return continued
    .join('\n')
    .split(/\n{2,}/)
    .map((paragraph) => paragraph.split('\n').join(' '))
    .join('\n')
}

// ── Index ───────────────────────────────────────────────────────────────────

function canonicalNotice(repo: string, version: string | undefined): string {
  return `${repo} has no captured agent context: serving the canonical skills bundled with Autobuild ${version ?? 'unknown'}; agent instructions are absent.`
}

function fileByPath(view: ContextView, path: string): ContextFile | undefined {
  return view.files.find((file) => file.path === path || file.aliases.includes(path))
}

export function contextIndex(view: ContextView, repo: string): ContextIndex {
  const skills = view.skills.map((skill) => {
    const entry = fileByPath(view, skill.entry)
    return {
      name: skill.name,
      description: entry?.text !== undefined ? skillDescription(entry.text) : null,
      paths: skill.paths,
      entry: skill.entry,
      files: skill.files,
    }
  })
  const entryOf = (name: string) => skills.find((skill) => skill.name === name)?.entry
  const operate = entryOf(OPERATE_SKILL)
  return {
    repo,
    source: view.source,
    commit: view.commit,
    ...(view.baseBranch !== undefined ? { baseBranch: view.baseBranch } : {}),
    ...(view.version !== undefined ? { version: view.version } : {}),
    ...(view.source === 'canonical' ? { notice: canonicalNotice(repo, view.version) } : {}),
    skills,
    instructions: view.instructions,
    imports: view.imports,
    load: {
      beforeOperating: operate !== undefined ? [operate] : [],
      beforeTicketWork: [
        ...TICKET_SKILLS.map(entryOf).filter((entry): entry is string => entry !== undefined),
        ...view.instructions.map((entry) => entry.path),
      ],
    },
  }
}

// ── Reads ───────────────────────────────────────────────────────────────────

function stripTarget(path: string): string {
  return path.replace(/[#?].*$/, '')
}

function dirnameOf(path: string): string {
  const slash = path.lastIndexOf('/')
  return slash < 0 ? '' : path.slice(0, slash)
}

/** Normalize `path` (relative to `from`'s directory when given) to a
 * repository path; null when it climbs above the root. */
function normalizePath(path: string, from?: string): string | null {
  const target = stripTarget(path)
  if (from !== undefined && !target.startsWith('/'))
    return normalizeRepoPath(dirnameOf(stripTarget(from).replace(/^\/+/, '')), target)
  return normalizeRepoPath('', target.replace(/^\/+/, ''))
}

/** Find a file by path, following captured directory links (bounded). */
function findFile(view: ContextView, path: string): ContextFile | undefined {
  let current = path
  for (let depth = 0; depth < 8; depth++) {
    const file = fileByPath(view, current)
    if (file !== undefined) return file
    const link = view.links.find(
      (entry) => current === entry.path || current.startsWith(`${entry.path}/`),
    )
    if (link === undefined) return undefined
    const target = normalizeRepoPath(dirnameOf(link.path), link.target)
    if (target === null) return undefined
    current = `${target}${current.slice(link.path.length)}`
  }
  return undefined
}

const MARKDOWN_LINK = /\[[^\]]*\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g

/** Resolve `path` relative to `from`: against the requested spelling of
 * `from` first, then against the primary path of the file it names (an
 * alias directory need not hold every sibling skill). */
function findRelative(
  view: ContextView,
  path: string,
  from: string | undefined,
): { requested: string | null; file: ContextFile | undefined } {
  const requested = normalizePath(path, from)
  let file = requested === null || requested === '' ? undefined : findFile(view, requested)
  if (file === undefined && from !== undefined) {
    const base = normalizePath(from)
    const origin = base === null ? undefined : findFile(view, base)
    if (origin !== undefined && origin.path !== base) {
      const viaPrimary = normalizePath(path, origin.path)
      if (viaPrimary !== null && viaPrimary !== '') file = findFile(view, viaPrimary)
    }
  }
  return { requested, file }
}

/** Every relative markdown link in `text` that resolves to a file in the
 * view, relative to the requested path. */
function resolvedLinks(view: ContextView, text: string, requested: string) {
  const links: { href: string; path: string }[] = []
  const seen = new Set<string>()
  for (const match of text.matchAll(MARKDOWN_LINK)) {
    const href = match[1]!
    if (/^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith('#') || seen.has(href)) continue
    seen.add(href)
    const { file } = findRelative(view, href, requested)
    if (file !== undefined) links.push({ href, path: file.path })
  }
  return links
}

const PREAMBLE_HEAD = '[Autobuild context preamble — generated by the server; not part of the file]'

function short(commit: string): string {
  return commit.slice(0, 12)
}

function sourceLine(view: ContextView): string {
  return view.source === 'captured'
    ? `captured from the repository at commit ${short(view.commit ?? '')}${view.baseBranch !== undefined ? ` (${view.baseBranch})` : ''}`
    : `the canonical skill bundled with Autobuild ${view.version ?? 'unknown'}, served because this repository has no captured agent context`
}

function mappingLines(text: string): string[] {
  const commands = cliMentions(text)
  if (commands.length === 0) return []
  return [
    'The `ab` commands this file mentions, and what to use instead:',
    ...renderCliMapping(commands),
  ]
}

function skillPreamble(view: ContextView, file: ContextFile, text: string): string {
  const instructions = view.instructions.map((entry) => `\`${entry.path}\``)
  return [
    PREAMBLE_HEAD,
    `Skill \`${file.skill}\` (\`${file.path}\`): ${sourceLine(view)}.`,
    'You are connected over MCP. You have no shell and no `ab` CLI: act through the operator tools.',
    ...mappingLines(text),
    'A command marked for the sandbox runs there: `sandbox.open`, poll `sandbox.status` until ready, then `sandbox.exec`.',
    view.source === 'captured'
      ? `Where this repository's agent instructions conflict with this skill, the instructions win for this repository: ${instructions.length > 0 ? instructions.join(', ') : 'none captured'}.`
      : "Where this repository's agent instructions conflict with this skill, the instructions win for this repository: none captured.",
  ].join('\n')
}

function instructionsPreamble(view: ContextView, file: ContextFile, text: string): string {
  const own =
    file.kind === 'import'
      ? `\`${file.path}\` is this repository's own file, imported by ${(file.importedBy ?? []).map((path) => `\`${path}\``).join(', ')}`
      : `\`${file.path}\` is this repository's own agent instructions file (scope: ${file.scope === '' || file.scope === undefined ? 'the repository root' : `\`${file.scope}\``})`
  return [
    PREAMBLE_HEAD,
    `${own}, captured at commit ${short(view.commit ?? '')}.`,
    '- It was written for agents working in a checkout of the repository.',
    '- Its conventions and constraints apply to the tickets, specs and answers you write for this repository.',
    '- Its commands and its rules about local processes apply only inside the sandbox (`sandbox.open`, then `sandbox.exec`); you have no shell of your own.',
    '- It takes precedence over Autobuild skills for this repository.',
    ...mappingLines(text),
  ].join('\n')
}

/** Resolve and return one file with its preamble. */
export function readContextFile(
  view: ContextView,
  input: { path: string; from?: string },
): ContextReadOutcome {
  const { requested, file } = findRelative(view, input.path, input.from)
  if (file === undefined || requested === null) {
    const shown = requested ?? input.path
    const omission = view.omitted.find((entry) => entry.path === shown)
    return {
      kind: 'not-found',
      message:
        `no file "${shown}" in the ${view.source} agent context` +
        (omission !== undefined
          ? `: the capture omitted it (${omission.reason})`
          : '; call context.list'),
    }
  }
  const meta = {
    path: file.path,
    kind: file.kind,
    ...(file.skill !== undefined ? { skill: file.skill } : {}),
    ...(file.scope !== undefined ? { scope: file.scope } : {}),
    source: view.source,
    commit: view.commit,
  }
  if (file.text === undefined)
    return { kind: 'found', result: { ...meta, contentBase64: file.base64 ?? '', links: [] } }
  const raw = file.text
  const links = resolvedLinks(view, raw, requested)
  let preamble: string | undefined
  if (file.kind === 'skill') preamble = skillPreamble(view, file, raw)
  else if (file.kind === 'skill-file') {
    if (cliMentions(raw).length > 0) preamble = skillPreamble(view, file, raw)
  } else preamble = instructionsPreamble(view, file, raw)
  const text = preamble === undefined ? raw : `${preamble}\n---\n${raw}`
  return { kind: 'found', result: { ...meta, text, links } }
}

// ── Server instructions ─────────────────────────────────────────────────────

export type ContextEntry = { repo: string; index: ContextIndex } | { repo: string; error: string }

function code(value: string): string {
  return `\`${value}\``
}

function repositorySection(index: ContextIndex, scoped: boolean): string[] {
  const lines: string[] = []
  lines.push(
    index.source === 'captured'
      ? `Captured from the base branch${index.baseBranch !== undefined ? ` ${code(index.baseBranch)}` : ''} at commit ${short(index.commit ?? '')}.`
      : (index.notice ?? canonicalNotice(index.repo, index.version)),
  )
  lines.push('Skills:')
  for (const skill of index.skills)
    lines.push(`- ${skill.name}${skill.description !== null ? ` — ${skill.description}` : ''}`)
  if (index.skills.length === 0) lines.push('- none')
  lines.push(
    `Agent instructions: ${
      index.source === 'canonical'
        ? 'absent (no captured record).'
        : index.instructions.length === 0
          ? 'none.'
          : `${index.instructions
              .map(
                (entry) =>
                  `${code(entry.path)} (${entry.scope === '' ? 'repository root' : code(entry.scope)})`,
              )
              .join(', ')}.`
    }`,
  )
  const named = (path: string) => index.skills.find((skill) => skill.entry === path)?.name ?? path
  const operate = index.load.beforeOperating
  const ticketSkills = index.load.beforeTicketWork.filter((path) =>
    index.skills.some((skill) => skill.entry === path),
  )
  if (operate.length > 0)
    lines.push(
      `Before operating, load ${operate.map((path) => `${code(named(path))} (${code(path)})`).join(', ')}.`,
    )
  if (ticketSkills.length > 0 || index.instructions.length > 0)
    lines.push(
      `Before filing or revising tickets, load ${[
        ...ticketSkills.map((path) => `${code(named(path))} (${code(path)})`),
        ...(index.instructions.length > 0 ? ['the agent instructions above'] : []),
      ].join(', ')}.`,
    )
  lines.push(
    scoped
      ? 'Load any skill or instructions file with `context.read` and its path, or invoke the MCP prompt named for the skill.'
      : `Load any skill or instructions file with \`context.read\` (repo ${code(index.repo)}) and its path, or invoke the MCP prompt named for the skill.`,
  )
  return lines
}

/** The server-instruction section for one or more repositories. */
export function contextInstructions(
  entries: readonly ContextEntry[],
  options: { scoped: boolean },
): string {
  const lines = [
    '',
    '## Agent context',
    'Call `context.list` first: it indexes the skills and agent instructions to load. Every `context.read` result starts with a generated preamble that maps the `ab` commands the file mentions onto these tools. Agent instructions are the repository’s own files and win over Autobuild skills for that repository.',
  ]
  for (const entry of entries) {
    if (!options.scoped) lines.push('', `### ${entry.repo}`)
    else lines.push('')
    if ('error' in entry)
      lines.push(
        `Agent context is unavailable right now; call \`context.list\`${options.scoped ? '' : ` with repo ${code(entry.repo)}`} to retry.`,
      )
    else lines.push(...repositorySection(entry.index, options.scoped))
  }
  return lines.join('\n')
}

// ── Prompts ─────────────────────────────────────────────────────────────────

export interface ContextPrompt {
  name: string
  repo: string
  skill: string
  entry: string
  description: string
}

/** The readable label a deployment-wide prompt name starts with: the
 * identity without its scheme, every character outside [A-Za-z0-9_-] as `_`.
 * A label never contains `.`, so the first `.` of a name ends it. */
export function promptLabel(repo: string): string {
  return repo.replace(/^https?:\/\//, '').replace(/[^A-Za-z0-9_-]/g, '_')
}

function digest(repo: string, entry: string): string {
  return createHash('sha256').update(`${repo}\0${entry}`).digest('hex')
}

/** One prompt per skill across `entries`, with names unique in the listing:
 * the readable name (the skill on a scoped binding, `<label>.<skill>` on a
 * deployment binding), suffixed `~<hash>` only for colliding names. The
 * names depend only on the colliding group, so recomputing from the subset
 * of repositories that share a label yields the same names. */
export function contextPrompts(
  entries: readonly { repo: string; index: ContextIndex }[],
  options: { scoped: boolean },
): ContextPrompt[] {
  const candidates = entries.flatMap(({ repo, index }) =>
    index.skills.map((skill) => ({
      base: options.scoped ? skill.name : `${promptLabel(repo)}.${skill.name}`,
      repo,
      skill: skill.name,
      entry: skill.entry,
      description: options.scoped
        ? (skill.description ?? `The ${skill.name} skill.`)
        : `${repo} · ${skill.entry}${skill.description !== null ? ` — ${skill.description}` : ''}`,
    })),
  )
  const groups = new Map<string, typeof candidates>()
  for (const candidate of candidates) {
    const group = groups.get(candidate.base) ?? []
    group.push(candidate)
    groups.set(candidate.base, group)
  }
  const prompts: ContextPrompt[] = []
  for (const [base, group] of groups) {
    if (group.length === 1) {
      const { base: _base, ...rest } = group[0]!
      prompts.push({ name: base, ...rest })
      continue
    }
    const named = (length: number) =>
      group.map(({ base: _base, ...rest }) => ({
        name: `${base}~${digest(rest.repo, rest.entry).slice(0, length)}`,
        ...rest,
      }))
    let suffixed = named(12)
    if (new Set(suffixed.map((prompt) => prompt.name)).size !== suffixed.length)
      suffixed = named(64)
    prompts.push(...suffixed)
  }
  return prompts.sort((a, b) => compare(a.name, b.name))
}

/** The label a deployment-wide prompt name was built from. */
export function promptNameLabel(name: string): string {
  const dot = name.indexOf('.')
  return dot < 0 ? name : name.slice(0, dot)
}

/** A prompt's messages: one user message whose text is the read's text. */
export function contextPromptMessages(
  result: ContextReadResult,
): { role: 'user'; content: { type: 'text'; text: string } }[] {
  const text =
    'text' in result ? result.text : utf8.decode(Buffer.from(result.contentBase64, 'base64'))
  return [{ role: 'user', content: { type: 'text', text } }]
}
