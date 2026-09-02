import { get, put, type get as getType, type put as putType } from '@vercel/blob'
import { Buffer } from 'node:buffer'
import type { BlobStore } from 'autobuild/plugin-sdk'
import { blobPath } from './s3'

type Put = typeof putType
type Get = typeof getType

export interface VercelBlobStoreOptions {
  access: 'public' | 'private'
  prefix?: string
  token?: string
  oidcToken?: string
  storeId?: string
  put?: Put
  get?: Get
}

export class VercelBlobStore implements BlobStore {
  private readonly putFn: Put
  private readonly getFn: Get

  constructor(private readonly options: VercelBlobStoreOptions) {
    this.putFn = options.put ?? put
    this.getFn = options.get ?? get
  }

  private auth(): { token?: string; oidcToken?: string; storeId?: string } {
    return {
      ...(this.options.token ? { token: this.options.token } : {}),
      ...(this.options.oidcToken ? { oidcToken: this.options.oidcToken } : {}),
      ...(this.options.storeId ? { storeId: this.options.storeId } : {}),
    }
  }

  async put(hash: string, bytes: Uint8Array): Promise<void> {
    await this.putFn(blobPath(hash, this.options.prefix), Buffer.from(bytes), {
      access: this.options.access,
      addRandomSuffix: false,
      allowOverwrite: true,
      ...this.auth(),
    })
  }

  async get(hash: string): Promise<Uint8Array | null> {
    const result = await this.getFn(blobPath(hash, this.options.prefix), {
      access: this.options.access,
      ...this.auth(),
    })
    if (!result?.stream) return null
    return new Uint8Array(await new Response(result.stream).arrayBuffer())
  }
}
