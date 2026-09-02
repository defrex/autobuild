import { describe, expect, test } from 'bun:test'
import { GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3'
import { describeBlobStoreContract } from 'autobuild/plugin-sdk'
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
        stream: new Blob([value]).stream(),
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
