import { GetObjectCommand, NoSuchKey, PutObjectCommand, type S3Client } from '@aws-sdk/client-s3'
import type { BlobStore } from 'autobuild/plugin-sdk'

export interface S3BlobStoreOptions {
  client: Pick<S3Client, 'send'>
  bucket: string
  prefix?: string
}

export function blobPath(hash: string, prefix = ''): string {
  const clean = prefix.split('/').filter(Boolean).join('/')
  return clean ? `${clean}/${hash}` : hash
}

export class S3BlobStore implements BlobStore {
  constructor(private readonly options: S3BlobStoreOptions) {}

  async put(hash: string, bytes: Uint8Array): Promise<void> {
    await this.options.client.send(
      new PutObjectCommand({
        Bucket: this.options.bucket,
        Key: blobPath(hash, this.options.prefix),
        Body: bytes,
      }),
    )
  }

  async get(hash: string): Promise<Uint8Array | null> {
    try {
      const result = await this.options.client.send(
        new GetObjectCommand({
          Bucket: this.options.bucket,
          Key: blobPath(hash, this.options.prefix),
        }),
      )
      if (!result.Body) return new Uint8Array()
      return await result.Body.transformToByteArray()
    } catch (error) {
      const status = (error as { $metadata?: { httpStatusCode?: number } }).$metadata
        ?.httpStatusCode
      if (error instanceof NoSuchKey || status === 404) return null
      throw error
    }
  }
}
