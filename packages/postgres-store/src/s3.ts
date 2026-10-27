import {
  DeleteObjectCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  ListObjectVersionsCommand,
  NoSuchKey,
  PutObjectCommand,
  type S3Client,
} from '@aws-sdk/client-s3'
import type { BlobStore } from '@defrex/autobuild/plugin-sdk'
import type { BlobMaintenance } from './blob-maintenance'

export interface S3BlobStoreOptions {
  client: Pick<S3Client, 'send'>
  bucket: string
  prefix?: string
}

export function blobPath(hash: string, prefix = ''): string {
  const clean = prefix.split('/').filter(Boolean).join('/')
  return clean ? `${clean}/${hash}` : hash
}

export class S3BlobStore implements BlobStore, BlobMaintenance {
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

  async delete(hash: string): Promise<void> {
    const Bucket = this.options.bucket
    const Key = blobPath(hash, this.options.prefix)
    // Delete the unversioned/null current object first. In versioned buckets
    // this creates a marker, which the exact-key version pass removes too.
    await this.options.client.send(new DeleteObjectCommand({ Bucket, Key }))
    let KeyMarker: string | undefined
    let VersionIdMarker: string | undefined
    do {
      const page = await this.options.client.send(
        new ListObjectVersionsCommand({ Bucket, Prefix: Key, KeyMarker, VersionIdMarker }),
      )
      for (const version of [...(page.Versions ?? []), ...(page.DeleteMarkers ?? [])]) {
        if (version.Key !== Key) continue
        if (!version.VersionId) throw new Error('S3 returned a version without an identity')
        await this.options.client.send(
          new DeleteObjectCommand({ Bucket, Key, VersionId: version.VersionId }),
        )
      }
      if (!page.IsTruncated) return
      if (
        !page.NextKeyMarker ||
        (page.NextKeyMarker === KeyMarker && page.NextVersionIdMarker === VersionIdMarker)
      )
        throw new Error('S3 version pagination did not advance')
      KeyMarker = page.NextKeyMarker
      VersionIdMarker = page.NextVersionIdMarker
    } while (KeyMarker !== undefined)
  }

  async deleteMany(hashes: string[]): Promise<void> {
    const Bucket = this.options.bucket
    const remove = async (Objects: Array<{ Key: string; VersionId?: string }>) => {
      if (!Objects.length) return
      const result = await this.options.client.send(
        new DeleteObjectsCommand({
          Bucket,
          Delete: { Objects, Quiet: true },
        }),
      )
      // S3 may return HTTP success with per-object retention/permission errors.
      if (result.Errors?.length) throw new Error('S3 physical batch deletion failed')
    }
    // Bound concurrency and request sizes even for maintenance callers outside cleanup.
    for (let start = 0; start < hashes.length; start += 32) {
      const keys = [
        ...new Set(
          hashes.slice(start, start + 32).map((hash) => blobPath(hash, this.options.prefix)),
        ),
      ]
      await remove(keys.map((Key) => ({ Key })))
      for (let offset = 0; offset < keys.length; offset += 4) {
        const outcomes = await Promise.allSettled(
          keys.slice(offset, offset + 4).map(async (Key) => {
            let KeyMarker: string | undefined
            let VersionIdMarker: string | undefined
            for (;;) {
              const page = await this.options.client.send(
                new ListObjectVersionsCommand({
                  Bucket,
                  Prefix: Key,
                  KeyMarker,
                  VersionIdMarker,
                }),
              )
              const versions = [...(page.Versions ?? []), ...(page.DeleteMarkers ?? [])]
                .filter((version) => version.Key === Key)
                .map((version) => {
                  if (!version.VersionId)
                    throw new Error('S3 returned a version without an identity')
                  return { Key, VersionId: version.VersionId }
                })
              for (let i = 0; i < versions.length; i += 1000)
                await remove(versions.slice(i, i + 1000))
              if (!page.IsTruncated) return
              if (
                !page.NextKeyMarker ||
                (page.NextKeyMarker === KeyMarker && page.NextVersionIdMarker === VersionIdMarker)
              )
                throw new Error('S3 version pagination did not advance')
              KeyMarker = page.NextKeyMarker
              VersionIdMarker = page.NextVersionIdMarker
            }
          }),
        )
        const failed = outcomes.find((outcome) => outcome.status === 'rejected')
        if (failed?.status === 'rejected') throw failed.reason
      }
    }
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
