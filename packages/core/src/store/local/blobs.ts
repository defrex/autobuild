/**
 * Content-addressed blobs as a plain directory (SPEC §7.1, §7.2.1): files
 * sharded `root/<hash[0:2]>/<hash>`. Put is idempotent — the hash *is* the
 * identity, so an existing file is already the requested content.
 */
import { randomUUID } from 'node:crypto'
import { mkdir, rename } from 'node:fs/promises'
import { join } from 'node:path'
import type { BlobStore } from '../types'

export class DirBlobStore implements BlobStore {
  constructor(readonly root: string) {}

  private pathFor(hash: string): string {
    return join(this.root, hash.slice(0, 2), hash)
  }

  async put(hash: string, bytes: Uint8Array): Promise<void> {
    const path = this.pathFor(hash)
    if (await Bun.file(path).exists()) return
    await mkdir(join(this.root, hash.slice(0, 2)), { recursive: true })
    // Write-then-rename so a crashed write never leaves a truncated blob
    // wearing a valid content address. The temp name is unique per call
    // (pid + uuid): concurrent puts of the same hash — separate processes
    // sharing one local store (§7.1) — must never share a temp path, or one
    // writer's O_TRUNC reopen could truncate the bytes another is about to
    // rename into the final content address.
    const partial = `${path}.${process.pid}.${randomUUID()}.partial`
    await Bun.write(partial, bytes)
    await rename(partial, path)
  }

  async get(hash: string): Promise<Uint8Array | null> {
    const file = Bun.file(this.pathFor(hash))
    if (!(await file.exists())) return null
    return new Uint8Array(await file.arrayBuffer())
  }
}
