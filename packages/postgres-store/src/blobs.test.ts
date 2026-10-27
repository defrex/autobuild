import { describe, expect, test } from 'bun:test'
import { GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3'
import { describeBlobStoreContract } from '@defrex/autobuild/plugin-sdk'
import { Buffer } from 'node:buffer'
import { S3BlobStore } from './s3'
import { VercelBlobStore } from './vercel'

function s3Harness(): S3BlobStore {
  const data = new Map<string, Uint8Array>()
  const client = {
    async send(command: unknown): Promise<unknown> {
      if (command instanceof PutObjectCommand) {
        data.set(String(command.input.Key), new Uint8Array(command.input.Body as Uint8Array))
        return {}
      }
      if (command instanceof GetObjectCommand) {
        const value = data.get(String(command.input.Key))
        if (!value) {
          const error = new Error('not found') as Error & { $metadata: { httpStatusCode: number } }
          error.$metadata = { httpStatusCode: 404 }
          throw error
        }
        return { Body: { transformToByteArray: async () => value.slice() } }
      }
      throw new Error('unexpected command')
    },
  }
  return new S3BlobStore({ client: client as never, bucket: 'builds', prefix: '/ab//blobs/' })
}

function vercelHarness(): VercelBlobStore {
  const data = new Map<string, Uint8Array>()
  return new VercelBlobStore({
    access: 'private',
    prefix: 'ab/blobs',
    put: (async (pathname: string, body: unknown) => {
      if (!Buffer.isBuffer(body)) throw new TypeError('Vercel PutBody must be a Buffer')
      data.set(pathname, Uint8Array.from(body))
      return {
        url: pathname,
        downloadUrl: pathname,
        pathname,
        contentType: 'application/octet-stream',
        contentDisposition: '',
        size: 0,
        uploadedAt: new Date(),
      }
    }) as never,
    get: (async (pathname: string) => {
      const value = data.get(pathname)
      if (!value) return null
      return {
        statusCode: 200,
        stream: new Blob([Uint8Array.from(value)]).stream(),
        headers: new Headers(),
        blob: {
          url: pathname,
          downloadUrl: pathname,
          pathname,
          contentType: 'application/octet-stream',
          contentDisposition: '',
          size: value.length,
          uploadedAt: new Date(),
          etag: 'x',
          cacheControl: 'public',
        },
      }
    }) as never,
  })
}

describeBlobStoreContract('S3-compatible', async () => ({ blobs: s3Harness() }))
describeBlobStoreContract('Vercel Blob', async () => ({ blobs: vercelHarness() }))

describe('provider request mapping', () => {
  test('S3 uses the configured bucket and normalized deterministic key', async () => {
    let seen: PutObjectCommand | undefined
    const blobs = new S3BlobStore({
      bucket: 'bucket',
      prefix: '//prefix//',
      client: {
        send: async (command: unknown) => {
          seen = command as PutObjectCommand
          return {}
        },
      } as never,
    })
    await blobs.put('abc', new Uint8Array([1]))
    expect(seen?.input).toMatchObject({ Bucket: 'bucket', Key: 'prefix/abc' })
  })

  test('Vercel uploads binary bytes as a supported Buffer with deterministic options', async () => {
    let pathname: string | undefined
    let body: Buffer | undefined
    let options: Record<string, unknown> | undefined
    const blobs = new VercelBlobStore({
      access: 'public',
      prefix: '//prefix//',
      token: 'secret',
      put: (async (seenPath: string, seenBody: unknown, opts: Record<string, unknown>) => {
        if (!Buffer.isBuffer(seenBody)) throw new TypeError('Vercel PutBody must be a Buffer')
        pathname = seenPath
        body = seenBody
        options = opts
        return {}
      }) as never,
      get: (async () => null) as never,
    })
    const bytes = new Uint8Array([0x00, 0x80, 0xff, 0x41])
    await blobs.put('abc', bytes)
    expect(pathname).toBe('prefix/abc')
    expect(Buffer.isBuffer(body)).toBe(true)
    expect([...body!]).toEqual([...bytes])
    expect(options).toMatchObject({
      access: 'public',
      token: 'secret',
      addRandomSuffix: false,
      allowOverwrite: true,
    })
  })
})

describe('physical blob maintenance', () => {
  test('Vercel deletes the exact pathname with the configured authentication', async () => {
    const calls: unknown[][] = []
    const blobs = new VercelBlobStore({
      access: 'private',
      prefix: '//project//',
      oidcToken: 'oidc',
      storeId: 'store',
      del: (async (...args: unknown[]) => {
        calls.push(args)
      }) as never,
    })
    await blobs.delete('abc')
    await blobs.delete('abc')
    expect(calls).toEqual([
      ['project/abc', { oidcToken: 'oidc', storeId: 'store' }],
      ['project/abc', { oidcToken: 'oidc', storeId: 'store' }],
    ])
  })

  test('Vercel propagates deletion failure', async () => {
    const blobs = new VercelBlobStore({
      access: 'private',
      token: 'token',
      del: (async () => {
        throw new Error('denied')
      }) as never,
    })
    await expect(blobs.delete('abc')).rejects.toThrow('denied')
  })

  test('S3 removes all exact-key versions and markers across pages', async () => {
    const { DeleteObjectCommand, ListObjectVersionsCommand } = await import('@aws-sdk/client-s3')
    const calls: unknown[] = []
    let page = 0
    const blobs = new S3BlobStore({
      bucket: 'bucket',
      prefix: '//prefix//',
      client: {
        send: async (command: unknown) => {
          if (command instanceof DeleteObjectCommand) {
            calls.push(command.input)
            return {}
          }
          if (!(command instanceof ListObjectVersionsCommand)) throw new Error('unexpected')
          calls.push(command.input)
          return page++ === 0
            ? {
                Versions: [
                  { Key: 'prefix/abc', VersionId: 'v1' },
                  { Key: 'prefix/abcd', VersionId: 'other' },
                ],
                DeleteMarkers: [{ Key: 'prefix/abc', VersionId: 'marker' }],
                IsTruncated: true,
                NextKeyMarker: 'prefix/abc',
                NextVersionIdMarker: 'marker',
              }
            : { Versions: [{ Key: 'prefix/abc', VersionId: 'null' }], IsTruncated: false }
        },
      } as never,
    })
    await blobs.delete('abc')
    expect(calls).toEqual([
      { Bucket: 'bucket', Key: 'prefix/abc' },
      { Bucket: 'bucket', Prefix: 'prefix/abc', KeyMarker: undefined, VersionIdMarker: undefined },
      { Bucket: 'bucket', Key: 'prefix/abc', VersionId: 'v1' },
      { Bucket: 'bucket', Key: 'prefix/abc', VersionId: 'marker' },
      {
        Bucket: 'bucket',
        Prefix: 'prefix/abc',
        KeyMarker: 'prefix/abc',
        VersionIdMarker: 'marker',
      },
      { Bucket: 'bucket', Key: 'prefix/abc', VersionId: 'null' },
    ])
  })

  test('S3 missing objects are idempotent and permission failures propagate', async () => {
    const { ListObjectVersionsCommand } = await import('@aws-sdk/client-s3')
    let denied = false
    const blobs = new S3BlobStore({
      bucket: 'bucket',
      client: {
        send: async (command: unknown) => {
          if (denied) throw new Error('AccessDenied')
          return command instanceof ListObjectVersionsCommand ? { IsTruncated: false } : {}
        },
      } as never,
    })
    await blobs.delete('absent')
    await blobs.delete('absent')
    denied = true
    await expect(blobs.delete('absent')).rejects.toThrow('AccessDenied')
  })
})
