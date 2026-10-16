import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { TicketAssetStore } from '../types'
import type { Frontmatter } from './file-codec'
import { decodePortableAsset, encodePortableAsset, type PortableAsset } from './portable-assets'
import { contentHash } from '../../store/types'
import {
  DEFAULT_TICKET_ASSET_LIMITS,
  summarizeTicketAsset,
  validateTicketAssetInput,
  type TicketAsset,
  type TicketAssetInput,
} from '../../store/ticket-assets'

type History = Record<string, Array<{ asset: PortableAsset | null; createdAt: string }>>
// Native revisions occupy a separate range so legacy recorded pins remain unambiguous.
const FIRST_REVISION = 1_000_000_000
export class FileTicketAssets implements TicketAssetStore {
  constructor(
    private dir: string,
    private load: (
      id: string,
    ) => Promise<{ front: Frontmatter; exists?: boolean; save(front: Frontmatter): Promise<void> }>,
  ) {}
  async ticketAssetLimits() {
    return { ...DEFAULT_TICKET_ASSET_LIMITS }
  }
  private key(kind: string, name: string) {
    return `${kind}/${name}`
  }
  private path(id: string) {
    return join(this.dir, '.ab-assets', `${Buffer.from(id).toString('hex')}.json`)
  }
  private async history(id: string, front: Frontmatter): Promise<History> {
    try {
      return JSON.parse(await readFile(this.path(id), 'utf8')) as History
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    return Object.fromEntries(
      (front.attachments ?? []).map((asset) => [
        this.key(asset.kind, asset.name),
        [{ asset, createdAt: '1970-01-01T00:00:00.000Z' }],
      ]),
    )
  }
  async hasTicketAssetHistory(_repo: string, id: string, kind: string, name: string) {
    const { front } = await this.load(id)
    return this.key(kind, name) in (await this.history(id, front))
  }
  private materialize(
    repo: string,
    id: string,
    asset: PortableAsset,
    revision: number,
    createdAt: string,
  ): TicketAsset {
    const input = decodePortableAsset(asset)
    const size = validateTicketAssetInput(input)
    return {
      meta: {
        repo,
        ticketId: id,
        kind: asset.kind,
        name: asset.name,
        layout: asset.layout,
        revision,
        createdAt,
        size,
        entries: input.entries.map((e) =>
          e.type === 'dir'
            ? e
            : {
                type: 'file',
                path: e.path,
                size: e.content.byteLength,
                blobRef: contentHash(e.content),
              },
        ),
      },
      entries: input.entries,
    }
  }
  async getTicketAsset(repo: string, id: string, kind: string, name: string, revision?: number) {
    const { front } = await this.load(id)
    const history = (await this.history(id, front))[this.key(kind, name)]
    if (!history) return null
    const index = revision === undefined ? history.length - 1 : revision - FIRST_REVISION
    const item = history[index]
    return item?.asset
      ? this.materialize(repo, id, item.asset, FIRST_REVISION + index, item.createdAt)
      : null
  }
  async listTicketAssets(repo: string, id: string) {
    const { front } = await this.load(id)
    const history = await this.history(id, front)
    return Object.values(history).flatMap((items) => {
      const item = items.at(-1)!
      return item.asset
        ? [
            summarizeTicketAsset(
              this.materialize(
                repo,
                id,
                item.asset,
                FIRST_REVISION + items.length - 1,
                item.createdAt,
              ).meta,
            ),
          ]
        : []
    })
  }
  private async persist(
    id: string,
    history: History,
    loaded: Awaited<ReturnType<FileTicketAssets['load']>>,
  ) {
    const path = this.path(id)
    await mkdir(join(this.dir, '.ab-assets'), { recursive: true })
    const temp = `${path}.${crypto.randomUUID()}.tmp`
    await writeFile(temp, JSON.stringify(history))
    await rename(temp, path)
    // The journal is authoritative after interruption; repair the portable projection on retry.
    loaded.front.attachments = Object.values(history).flatMap((items) =>
      items.at(-1)!.asset ? [items.at(-1)!.asset!] : [],
    )
    await loaded.save(loaded.front)
  }
  async putTicketAsset(repo: string, id: string, input: TicketAssetInput) {
    validateTicketAssetInput(input)
    const loaded = await this.load(id)
    if (loaded.exists === false)
      throw new Error(`file ticket source: asset on unknown ticket "${id}"`)
    const history = await this.history(id, loaded.front)
    const key = this.key(input.kind, input.name)
    const items = history[key] ?? []
    history[key] = items
    const asset = encodePortableAsset(input)
    const createdAt = new Date().toISOString()
    items.push({ asset, createdAt })
    await this.persist(id, history, loaded)
    return this.materialize(repo, id, asset, FIRST_REVISION + items.length - 1, createdAt).meta
  }
  async removeTicketAsset(repo: string, id: string, kind: string, name: string) {
    const current = await this.getTicketAsset(repo, id, kind, name)
    const loaded = await this.load(id)
    if (loaded.exists === false)
      throw new Error(`file ticket source: asset on unknown ticket "${id}"`)
    const history = await this.history(id, loaded.front)
    const key = this.key(kind, name)
    const items = history[key] ?? []
    history[key] = items
    items.push({ asset: null, createdAt: new Date().toISOString() })
    await this.persist(id, history, loaded)
    return current?.meta ?? null
  }
}
