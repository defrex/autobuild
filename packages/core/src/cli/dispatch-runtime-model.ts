import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { inside, type SnapshotWriter } from './dispatch-runtime-dependencies'

type ModelNode =
  | { kind: 'dir'; mode: number; children: Map<string, ModelNode> }
  | { kind: 'file'; mode: number; source?: string; bytes?: string }
  | { kind: 'link'; text: string }
type ModelDir = Extract<ModelNode, { kind: 'dir' }>

function failure(code: string, message: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`${code}: ${message}`), { code })
}

/**
 * The tree a snapshot staging would write to disk under `root`, recorded in
 * memory: files keep the source path they were copied from, so `digest()`
 * reads current source bytes without materializing a copy.
 *
 * The model must stay equivalent to staging onto disk followed by
 * `treeDigest(root, new Set(), undefined, { linkModes: false })`. It mirrors
 * POSIX outcomes for every operation staging performs (umask-derived modes,
 * overwrite keeping a file's mode, link following, EEXIST/ENOENT/ENOTDIR,
 * ELOOP), and never touches the filesystem except to read recorded sources.
 * `dispatch-runtime-cache.integration.test.ts` proves the equivalence.
 */
export class SnapshotModel implements SnapshotWriter {
  private readonly tree: ModelDir

  constructor(
    private readonly root: string,
    private readonly umask = process.umask(),
    private readonly read: (path: string) => Promise<Uint8Array | string> = (path) =>
      readFile(path),
  ) {
    this.tree = { kind: 'dir', mode: 0o777 & ~umask, children: new Map() }
  }

  /** Resolve `path` component by component through recorded links. A missing
   * final name returns its parent; `create` makes missing directories named by
   * the original path, as `mkdir -p` would. */
  private locate(
    path: string,
    follow: boolean,
    create = false,
  ): { parents: ModelDir[]; parts: string[]; name?: string; node?: ModelNode } {
    const rel = relative(this.root, resolve(path))
    if (!inside(this.root, resolve(path))) throw failure('EACCES', `outside snapshot: ${path}`)
    let pending = (rel === '' ? [] : rel.split(sep)).map((name) => ({ name, linked: false }))
    const parts: string[] = []
    const parents: ModelDir[] = []
    let current: ModelDir = this.tree
    let hops = 0
    while (pending.length > 0) {
      const { name, linked } = pending.shift()!
      if (name === '' || name === '.') continue
      if (name === '..') {
        if (parents.length === 0) throw failure('EACCES', `outside snapshot: ${path}`)
        parts.pop()
        current = parents.pop()!
        continue
      }
      let child = current.children.get(name)
      if (!child) {
        if (create && !linked) {
          child = { kind: 'dir', mode: 0o777 & ~this.umask, children: new Map() }
          current.children.set(name, child)
        } else if (pending.length === 0) return { parents: [...parents, current], parts, name }
        else throw failure('ENOENT', path)
      }
      if (child.kind === 'link' && (pending.length > 0 || follow)) {
        if (++hops > 40) throw failure('ELOOP', path)
        let text = child.text
        if (isAbsolute(text)) {
          if (!inside(this.root, text)) throw failure('EACCES', `outside snapshot: ${path}`)
          text = relative(this.root, text)
          parts.length = 0
          parents.length = 0
          current = this.tree
        }
        pending = [...text.split(sep).map((part) => ({ name: part, linked: true })), ...pending]
        continue
      }
      if (pending.length === 0) return { parents: [...parents, current], parts, name, node: child }
      if (child.kind !== 'dir') throw failure('ENOTDIR', path)
      parents.push(current)
      parts.push(name)
      current = child
    }
    return { parents, parts, node: current }
  }

  private place(path: string, existing: (file: ModelNode) => void, fresh: () => ModelNode) {
    const found = this.locate(path, true)
    if (found.node) return existing(found.node)
    found.parents.at(-1)!.children.set(found.name!, fresh())
  }

  async mkdirp(path: string): Promise<void> {
    const found = this.locate(path, true, true)
    if (found.node?.kind !== 'dir') throw failure(found.node ? 'EEXIST' : 'ENOENT', path)
  }

  async copyFile(from: string, to: string): Promise<void> {
    this.place(
      to,
      (node) => {
        if (node.kind !== 'file') throw failure('EISDIR', to)
        node.source = from
        node.bytes = undefined
      },
      () => ({ kind: 'file', mode: 0o666 & ~this.umask, source: from }),
    )
  }

  async writeFile(path: string, data: string): Promise<void> {
    this.place(
      path,
      (node) => {
        if (node.kind !== 'file') throw failure('EISDIR', path)
        node.bytes = data
        node.source = undefined
      },
      () => ({ kind: 'file', mode: 0o666 & ~this.umask, bytes: data }),
    )
  }

  async chmod(path: string, mode: number): Promise<void> {
    const { node } = this.locate(path, true)
    if (!node || node.kind === 'link') throw failure('ENOENT', path)
    node.mode = mode & 0o777
  }

  async symlink(text: string, path: string): Promise<void> {
    const found = this.locate(path, false)
    if (found.node) throw failure('EEXIST', path)
    found.parents.at(-1)!.children.set(found.name!, { kind: 'link', text })
  }

  /** Equal to `treeDigest(root, new Set(), undefined, { linkModes: false })`
   * over the tree this model records, reading each copied file's source now. */
  async digest(): Promise<string> {
    const hash = createHash('sha256')
    const walk = async (path: string, node: ModelNode): Promise<void> => {
      const rel = relative(this.root, path)
      hash.update(JSON.stringify([rel, node.kind === 'link' ? 0 : node.mode & 0o111]))
      if (node.kind === 'link') {
        if (!inside(this.root, resolve(dirname(path), node.text)))
          throw new Error(`snapshot link escapes runtime: ${path}`)
        let actual: string
        try {
          const found = this.locate(path, true)
          if (!found.node) throw failure('ENOENT', path)
          actual = join(this.root, ...found.parts, found.name ?? '')
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'EACCES')
            throw new Error(`snapshot link escapes runtime: ${path}`)
          throw error
        }
        hash.update(`link:${relative(dirname(path), actual)}`)
      } else if (node.kind === 'dir') {
        hash.update('directory')
        for (const name of [...node.children.keys()].sort())
          await walk(join(path, name), node.children.get(name)!)
      } else {
        hash.update('file')
        hash.update(node.bytes ?? (await this.read(node.source!)))
      }
    }
    await walk(this.root, this.tree)
    return hash.digest('hex')
  }
}
