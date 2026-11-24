/**
 * Pure assembly of a repository's agent context (`store/agent-context.ts`)
 * from one commit's tree listing and a synchronous blob lookup.
 *
 * The assembler never fetches. Each pass reports the blob ids it needed but
 * could not see (`missing`); the capture stage fetches them and runs the pass
 * again, until nothing is missing. Each pass is deterministic over its
 * inputs, so a checkout dispatcher and an origin-mode dispatcher that list
 * the same commit produce byte-identical records.
 *
 * Selection:
 * - Skills: each direct child directory of `.agents/skills` and
 *   `.claude/skills` (resolved through symlinks, dot-names skipped) that holds
 *   a `SKILL.md`. One entry per real directory, then per identical content;
 *   merged entries keep every install path.
 * - Agent instructions: every `AGENTS.md` and `CLAUDE.md`, root and nested,
 *   outside captured skills. Within a directory the two collapse into one
 *   entry when they are the same blob.
 * - Imports: `@path` tokens in instruction text, and transitively in imported
 *   text, resolved relative to the importing file. A token is an import only
 *   when it resolves to a blob; imports are separate entries, never inlined.
 */
import { createHash } from 'node:crypto'
import type { ForgeTreeEntry } from '../ports/types'
import {
  contentFields,
  type AgentContextImport,
  type AgentContextInstruction,
  type AgentContextOmission,
  type AgentContextRecord,
  type AgentContextSkill,
} from '../store/agent-context'

export const AGENT_CONTEXT_SKILL_ROOTS = ['.agents/skills', '.claude/skills'] as const
export const AGENT_CONTEXT_INSTRUCTION_NAMES = ['AGENTS.md', 'CLAUDE.md'] as const
const INSTRUCTION_NAMES: ReadonlySet<string> = new Set(AGENT_CONTEXT_INSTRUCTION_NAMES)
const FINGERPRINT_ROOTS: ReadonlySet<string> = new Set([
  '.agents',
  '.claude',
  ...AGENT_CONTEXT_SKILL_ROOTS,
])
const LINK_DEPTH = 40
const KEY_VERSION = 'agent-context-key/v1'

type OmissionReason = AgentContextOmission['reason']
type Resolved =
  | { kind: 'tree'; path: string }
  | { kind: 'blob'; path: string; entry: ForgeTreeEntry }
  | { kind: 'fail'; reason: OmissionReason }
  | { kind: 'missing' }

export interface AgentContextContributor {
  path: string
  bytes: number
}

export interface AssembleResult {
  /** Blob ids the pass needed and could not see, in first-need order. */
  missing: string[]
  /** Every blob id the pass consulted, seen or not. */
  wanted: Set<string>
  /** Captured blob bytes of everything selected so far (exact tree sizes). */
  rawBytes: number
  /** Selected skills, instruction files and imports by raw bytes, largest first. */
  contributors: AgentContextContributor[]
  /** Probed paths outside the fingerprint's fixed set, sorted. */
  dependencies: string[]
  /** The finished record; present only when nothing is missing. */
  record?: AgentContextRecord
}

function basename(path: string): string {
  const at = path.lastIndexOf('/')
  return at < 0 ? path : path.slice(at + 1)
}

function dirname(path: string): string {
  const at = path.lastIndexOf('/')
  return at < 0 ? '' : path.slice(0, at)
}

function join(base: string, rest: string): string {
  if (base === '') return rest
  if (rest === '') return base
  return `${base}/${rest}`
}

/** Normalize `rel` against directory `base`; null when it escapes the root. */
export function normalizeRepoPath(base: string, rel: string): string | null {
  const parts = base === '' ? [] : base.split('/')
  for (const part of rel.split('/')) {
    if (part === '' || part === '.') continue
    if (part === '..') {
      if (parts.length === 0) return null
      parts.pop()
    } else parts.push(part)
  }
  return parts.join('/')
}

function covered(path: string): boolean {
  return (
    FINGERPRINT_ROOTS.has(path) ||
    AGENT_CONTEXT_SKILL_ROOTS.some((root) => path.startsWith(`${root}/`)) ||
    INSTRUCTION_NAMES.has(basename(path))
  )
}

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex')
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

/**
 * Fingerprint of everything an assembly can read: every tree entry at or
 * below the skill roots (and `.agents` / `.claude` themselves), every
 * `AGENTS.md` / `CLAUDE.md`, and the current entry (or absence) at each path
 * the previous assembly probed outside that set. Equal key ⇒ equal record.
 */
export function contextKey(
  entries: readonly ForgeTreeEntry[],
  dependencies: readonly string[],
): string {
  const byPath = new Map(entries.map((entry) => [entry.path, entry]))
  const fixed = entries
    .filter((entry) => covered(entry.path))
    .map((entry) => `${entry.path}\0${entry.mode}\0${entry.oid}`)
    .sort(compare)
  const probed = [...new Set(dependencies)].sort(compare).map((path) => {
    const entry = byPath.get(path)
    return entry ? `${path}\0${entry.mode}\0${entry.oid}` : `${path}\0null`
  })
  return sha256(`${KEY_VERSION}\n${fixed.join('\n')}\n--\n${probed.join('\n')}`)
}

const FENCE = /^ {0,3}(`{3,}|~{3,})/
const CODE_SPAN = /(`+)[\s\S]*?\1/g
const TOKEN = /(^|\s)@(\S+)/g
const TRAILING = /[.,;:!?)\]}>'"]+$/

/** `@path` tokens outside fenced code blocks and inline code spans. */
export function importTokens(text: string): string[] {
  const tokens: string[] = []
  let fence: string | undefined
  for (const line of text.split(/\r?\n/)) {
    const marker = FENCE.exec(line)?.[1]
    if (fence !== undefined) {
      if (marker !== undefined && marker[0] === fence[0] && marker.length >= fence.length)
        fence = undefined
      continue
    }
    if (marker !== undefined) {
      fence = marker
      continue
    }
    for (const match of line.replace(CODE_SPAN, ' ').matchAll(TOKEN)) {
      const token = (match[2] ?? '').replace(TRAILING, '')
      if (token !== '') tokens.push(token)
    }
  }
  return tokens
}

class Assembly {
  private readonly byPath = new Map<string, ForgeTreeEntry>()
  private readonly children = new Map<string, ForgeTreeEntry[]>()
  readonly missing: string[] = []
  private readonly missingSet = new Set<string>()
  readonly wanted = new Set<string>()
  readonly probes = new Set<string>()
  readonly links = new Map<string, string>()
  private readonly omitted = new Map<string, OmissionReason>()

  constructor(
    entries: readonly ForgeTreeEntry[],
    private readonly blob: (oid: string) => Uint8Array | undefined,
  ) {
    for (const entry of entries) {
      this.byPath.set(entry.path, entry)
      const parent = dirname(entry.path)
      const list = this.children.get(parent) ?? []
      list.push(entry)
      this.children.set(parent, list)
    }
    for (const list of this.children.values()) list.sort((a, b) => compare(a.path, b.path))
  }

  load(oid: string): Uint8Array | undefined {
    this.wanted.add(oid)
    const bytes = this.blob(oid)
    if (bytes === undefined && !this.missingSet.has(oid)) {
      this.missingSet.add(oid)
      this.missing.push(oid)
    }
    return bytes
  }

  omit(path: string, reason: OmissionReason): void {
    if (!this.omitted.has(path)) this.omitted.set(path, reason)
  }

  omissions(): AgentContextOmission[] {
    return [...this.omitted]
      .map(([path, reason]) => ({ path, reason }))
      .sort((a, b) => compare(a.path, b.path))
  }

  entry(path: string): ForgeTreeEntry | undefined {
    return this.byPath.get(path)
  }

  /** Directory listing; records the directory as a dependency (its tree id
   * covers everything below it). */
  list(dir: string): ForgeTreeEntry[] {
    if (dir !== '') this.probes.add(dir)
    return this.children.get(dir) ?? []
  }

  resolve(path: string, depth = 0): Resolved {
    this.probes.add(path)
    if (path === '') return { kind: 'tree', path: '' }
    const parts = path.split('/')
    let prefix = ''
    for (let i = 0; i < parts.length; i++) {
      const candidate = join(prefix, parts[i]!)
      const entry = this.byPath.get(candidate)
      const last = i === parts.length - 1
      if (entry === undefined) {
        this.probes.add(candidate)
        return { kind: 'fail', reason: 'dangling' }
      }
      if (entry.type === 'tree') {
        prefix = candidate
        if (last) return { kind: 'tree', path: candidate }
        continue
      }
      this.probes.add(candidate)
      if (entry.mode === '160000' || entry.type === 'commit')
        return { kind: 'fail', reason: 'submodule' }
      if (entry.mode === '120000') {
        if (depth >= LINK_DEPTH) return { kind: 'fail', reason: 'link-depth' }
        const bytes = this.load(entry.oid)
        if (bytes === undefined) return { kind: 'missing' }
        const target = new TextDecoder().decode(bytes)
        if (target.startsWith('/')) return { kind: 'fail', reason: 'outside-repository' }
        const joined = normalizeRepoPath(dirname(candidate), target)
        if (joined === null) return { kind: 'fail', reason: 'outside-repository' }
        this.links.set(candidate, target)
        return this.resolve(join(joined, parts.slice(i + 1).join('/')), depth + 1)
      }
      if (!last) return { kind: 'fail', reason: 'dangling' }
      return { kind: 'blob', path: candidate, entry }
    }
    return { kind: 'tree', path: prefix }
  }
}

interface FileSelection {
  path: string
  oid: string
  bytes: number
  content?: Uint8Array
}

function selectionFields(file: FileSelection): {
  oid: string
  bytes: number
  text?: string
  base64?: string
} {
  const content = file.content ?? new Uint8Array()
  return { oid: file.oid, bytes: content.byteLength, ...contentFields(content) }
}

function sizeOf(entry: ForgeTreeEntry): number {
  return entry.size ?? 0
}

/** Every file of one skill directory, following symlinks inside it. */
function skillFiles(assembly: Assembly, realDir: string): FileSelection[] {
  const files: FileSelection[] = []
  const walk = (dir: string, rel: string, stack: Set<string>): void => {
    for (const child of assembly.list(dir)) {
      const name = basename(child.path)
      const childRel = join(rel, name)
      if (child.type === 'tree') {
        walk(child.path, childRel, new Set([...stack, child.path]))
        continue
      }
      if (child.mode === '160000' || child.type === 'commit') {
        assembly.omit(child.path, 'submodule')
        continue
      }
      if (child.mode !== '120000') {
        files.push({
          path: childRel,
          oid: child.oid,
          bytes: sizeOf(child),
          content: assembly.load(child.oid),
        })
        continue
      }
      const resolved = assembly.resolve(child.path)
      if (resolved.kind === 'missing') continue
      if (resolved.kind === 'fail') assembly.omit(child.path, resolved.reason)
      else if (resolved.kind === 'blob')
        files.push({
          path: childRel,
          oid: resolved.entry.oid,
          bytes: sizeOf(resolved.entry),
          content: assembly.load(resolved.entry.oid),
        })
      else if (stack.has(resolved.path)) assembly.omit(child.path, 'link-depth')
      else walk(resolved.path, childRel, new Set([...stack, resolved.path]))
    }
  }
  walk(realDir, '', new Set([realDir]))
  return files.sort((a, b) => compare(a.path, b.path))
}

interface SkillSelection {
  paths: string[]
  realDirs: string[]
  files: FileSelection[]
}

function selectSkills(assembly: Assembly): SkillSelection[] {
  const byReal = new Map<string, SkillSelection>()
  for (const root of AGENT_CONTEXT_SKILL_ROOTS) {
    const resolved = assembly.resolve(root)
    if (resolved.kind === 'fail' && assembly.entry(root) !== undefined)
      assembly.omit(root, resolved.reason)
    if (resolved.kind !== 'tree') continue
    for (const child of assembly.list(resolved.path)) {
      const name = basename(child.path)
      if (name.startsWith('.')) continue
      const install = `${root}/${name}`
      const dir = assembly.resolve(install)
      if (dir.kind === 'fail' && child.mode === '120000') assembly.omit(install, dir.reason)
      if (dir.kind !== 'tree') continue
      const marker = assembly.resolve(`${dir.path}/SKILL.md`)
      if (marker.kind !== 'blob') continue
      const existing = byReal.get(dir.path)
      if (existing) existing.paths.push(install)
      else
        byReal.set(dir.path, {
          paths: [install],
          realDirs: [dir.path],
          files: skillFiles(assembly, dir.path),
        })
    }
  }
  // Byte-identical copies in separate directories collapse too.
  const bySignature = new Map<string, SkillSelection>()
  for (const skill of byReal.values()) {
    const signature = JSON.stringify(skill.files.map((file) => [file.path, file.oid]))
    const existing = bySignature.get(signature)
    if (existing) {
      existing.paths.push(...skill.paths)
      existing.realDirs.push(...skill.realDirs)
    } else bySignature.set(signature, skill)
  }
  const rootIndex = (path: string) =>
    AGENT_CONTEXT_SKILL_ROOTS.findIndex((root) => path.startsWith(`${root}/`))
  const skills = [...bySignature.values()]
  for (const skill of skills)
    skill.paths.sort((a, b) => rootIndex(a) - rootIndex(b) || compare(a, b))
  return skills.sort((a, b) => compare(a.paths[0]!, b.paths[0]!))
}

interface InstructionSelection {
  paths: string[]
  directory: string
  realPath: string
  file: FileSelection
  imports: Set<string>
}

function selectInstructions(
  assembly: Assembly,
  entries: readonly ForgeTreeEntry[],
  skillDirs: readonly string[],
): InstructionSelection[] {
  const underSkill = (path: string) => skillDirs.some((dir) => path.startsWith(`${dir}/`))
  const byDirectory = new Map<string, string[]>()
  for (const entry of entries) {
    if (!INSTRUCTION_NAMES.has(basename(entry.path)) || entry.type !== 'blob') continue
    if (underSkill(entry.path)) continue
    const dir = dirname(entry.path)
    byDirectory.set(dir, [...(byDirectory.get(dir) ?? []), entry.path])
  }
  const selected: InstructionSelection[] = []
  for (const [directory, paths] of byDirectory) {
    const groups = new Map<string, InstructionSelection>()
    for (const path of paths.sort(compare)) {
      const resolved = assembly.resolve(path)
      if (resolved.kind === 'fail') assembly.omit(path, resolved.reason)
      if (resolved.kind !== 'blob') continue
      const existing = groups.get(resolved.entry.oid)
      if (existing) {
        existing.paths.push(path)
        continue
      }
      groups.set(resolved.entry.oid, {
        paths: [path],
        directory,
        realPath: resolved.path,
        file: {
          path,
          oid: resolved.entry.oid,
          bytes: sizeOf(resolved.entry),
          content: assembly.load(resolved.entry.oid),
        },
        imports: new Set(),
      })
    }
    selected.push(...groups.values())
  }
  return selected.sort((a, b) => compare(a.paths[0]!, b.paths[0]!))
}

interface ImportSelection {
  path: string
  realPath: string
  importedBy: Set<string>
  file: FileSelection
  imports: Set<string>
}

function selectImports(
  assembly: Assembly,
  instructions: readonly InstructionSelection[],
): ImportSelection[] {
  // Every entry, instruction or import, is keyed by (resolved file, real
  // directory its imports resolve from). Two aliases of one file in different
  // directories resolve their own relative imports differently, so each is
  // traversed; an alias of an instruction file from another directory is an
  // import entry of its own for the same reason. The key set is finite (real
  // blobs × real directories), so cycles and looping directory links still
  // terminate.
  const traversalKey = (realPath: string, directory: string) => `${realPath}\0${directory}`
  const instructionAt = new Map<string, string>()
  for (const instruction of instructions)
    instructionAt.set(
      traversalKey(instruction.realPath, instruction.directory),
      instruction.paths[0]!,
    )
  const byKey = new Map<string, ImportSelection>()
  const queue: { id: string; directory: string; file: FileSelection; imports: Set<string> }[] =
    instructions.map((instruction) => ({
      id: instruction.paths[0]!,
      directory: instruction.directory,
      file: instruction.file,
      imports: instruction.imports,
    }))
  while (queue.length > 0) {
    const importer = queue.shift()!
    if (importer.file.content === undefined) continue
    const text = new TextDecoder().decode(importer.file.content)
    for (const token of importTokens(text)) {
      if (token.startsWith('~') || token.startsWith('/')) {
        assembly.omit(token, 'outside-repository')
        continue
      }
      const path = normalizeRepoPath(importer.directory, token)
      if (path === null || path === '') {
        if (path === null) assembly.omit(token, 'outside-repository')
        continue
      }
      const resolved = assembly.resolve(path)
      if (resolved.kind !== 'blob') continue
      const parent = assembly.resolve(dirname(path))
      if (parent.kind !== 'tree') continue
      const key = traversalKey(resolved.path, parent.path)
      const instruction = instructionAt.get(key)
      if (instruction !== undefined) {
        if (instruction !== importer.id) importer.imports.add(instruction)
        continue
      }
      const existing = byKey.get(key)
      if (existing) {
        existing.importedBy.add(importer.id)
        if (existing.path !== importer.id) importer.imports.add(existing.path)
        continue
      }
      const selection: ImportSelection = {
        path,
        realPath: resolved.path,
        importedBy: new Set([importer.id]),
        file: {
          path,
          oid: resolved.entry.oid,
          bytes: sizeOf(resolved.entry),
          content: assembly.load(resolved.entry.oid),
        },
        imports: new Set(),
      }
      byKey.set(key, selection)
      importer.imports.add(path)
      queue.push({
        id: path,
        directory: parent.path,
        file: selection.file,
        imports: selection.imports,
      })
    }
  }
  return [...byKey.values()].sort((a, b) => compare(a.path, b.path))
}

/** One assembly pass over `entries`; see the module comment. */
export function assembleAgentContext(input: {
  commit: string
  baseBranch: string
  entries: readonly ForgeTreeEntry[]
  blob: (oid: string) => Uint8Array | undefined
}): AssembleResult {
  const assembly = new Assembly(input.entries, input.blob)
  const skills = selectSkills(assembly)
  const skillDirs = skills.flatMap((skill) => [...skill.paths, ...skill.realDirs])
  const instructions = selectInstructions(assembly, input.entries, skillDirs)
  const imports = selectImports(assembly, instructions)

  const contributors: AgentContextContributor[] = [
    ...skills.map((skill) => ({
      path: skill.paths[0]!,
      bytes: skill.files.reduce((total, file) => total + file.bytes, 0),
    })),
    ...instructions.map((entry) => ({ path: entry.paths[0]!, bytes: entry.file.bytes })),
    ...imports.map((entry) => ({ path: entry.path, bytes: entry.file.bytes })),
  ].sort((a, b) => b.bytes - a.bytes || compare(a.path, b.path))
  const rawBytes = contributors.reduce((total, entry) => total + entry.bytes, 0)
  const dependencies = [...assembly.probes].filter((path) => !covered(path)).sort(compare)
  const result: AssembleResult = {
    missing: assembly.missing,
    wanted: assembly.wanted,
    rawBytes,
    contributors,
    dependencies,
  }
  if (assembly.missing.length > 0) return result

  const recordSkills: AgentContextSkill[] = skills.map((skill) => ({
    name: basename(skill.paths[0]!),
    paths: skill.paths,
    files: skill.files.map((file) => ({ path: file.path, ...selectionFields(file) })),
  }))
  const recordInstructions: AgentContextInstruction[] = instructions.map((entry) => ({
    paths: entry.paths,
    directory: entry.directory,
    ...selectionFields(entry.file),
    imports: [...entry.imports].sort(compare),
  }))
  const recordImports: AgentContextImport[] = imports.map((entry) => ({
    path: entry.path,
    importedBy: [...entry.importedBy].sort(compare),
    ...selectionFields(entry.file),
    imports: [...entry.imports].sort(compare),
  }))
  result.record = {
    version: 1,
    commit: input.commit,
    baseBranch: input.baseBranch,
    skills: recordSkills,
    instructions: recordInstructions,
    imports: recordImports,
    links: [...assembly.links]
      .map(([path, target]) => ({ path, target }))
      .sort((a, b) => compare(a.path, b.path)),
    omitted: assembly.omissions(),
  }
  return result
}
