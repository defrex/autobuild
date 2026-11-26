/**
 * Static value-import graph over `packages/core/src` for import-boundary
 * tests. It reads source files, so only integration tests use it. An edge is
 * a static value import, a side-effect import or a value re-export; type-only
 * imports, dynamic `import()` and `typeof import()` are not edges.
 */
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'

export const SRC = resolve(import.meta.dir, '..')

/** `path` relative to `packages/core/src`. */
export const rel = (path: string): string => relative(SRC, path)

function resolveSpecifier(from: string, specifier: string): string | undefined {
  if (!specifier.startsWith('.')) return undefined
  const base = resolve(dirname(from), specifier)
  const candidates = /\.(tsx?|json)$/.test(base)
    ? [base]
    : [`${base}.ts`, `${base}.tsx`, join(base, 'index.ts')]
  for (const candidate of candidates) if (existsSync(candidate)) return candidate
  throw new Error(`cannot resolve ${specifier} from ${rel(from)}`)
}

const edgeCache = new Map<string, string[]>()
const transpiler = new Bun.Transpiler({ loader: 'ts' })

/** Modules `path` evaluates at load. */
export function valueEdges(path: string): string[] {
  const cached = edgeCache.get(path)
  if (cached !== undefined) return cached
  if (path.endsWith('.json')) return []
  const edges = new Set<string>()
  for (const entry of transpiler.scanImports(readFileSync(path, 'utf8'))) {
    if (entry.kind !== 'import-statement') continue
    const target = resolveSpecifier(path, entry.path)
    if (target !== undefined) edges.add(target)
  }
  const result = [...edges]
  edgeCache.set(path, result)
  return result
}

/** Every module `entry` statically evaluates, each mapped to the module that
 * first reached it (breadth-first; the entry maps to `''`). */
export function staticGraph(entry: string): Map<string, string> {
  const predecessor = new Map<string, string>([[entry, '']])
  const queue = [entry]
  while (queue.length > 0) {
    const current = queue.shift() as string
    for (const next of valueEdges(current)) {
      if (predecessor.has(next)) continue
      predecessor.set(next, current)
      queue.push(next)
    }
  }
  return predecessor
}

/** The import chain from the graph's entry to `target`, for failure messages. */
export function importChain(graph: Map<string, string>, target: string): string {
  const chain: string[] = []
  for (let at = target; at !== ''; at = graph.get(at) ?? '') chain.unshift(rel(at))
  return chain.join(' → ')
}

/** Each excluded module (`src`-relative; a trailing `/` excludes a directory)
 * the entry statically reaches, named by its import chain. */
export function reachedExclusions(entry: string, excluded: readonly string[]): string[] {
  const graph = staticGraph(join(SRC, entry))
  return [...graph.keys()]
    .filter((path) =>
      excluded.some((name) =>
        name.endsWith('/') ? rel(path).startsWith(name) : rel(path) === name,
      ),
    )
    .map((path) => importChain(graph, path))
}
