import { createCipheriv, createDecipheriv, createHmac, randomBytes } from 'node:crypto'
import { ProjectSecretError } from '@defrex/autobuild/project-secrets'
export class SecretCipher {
  private readonly key: Buffer
  constructor(raw: string | undefined) {
    if (!raw || !/^[A-Za-z0-9+/]{43}=$/.test(raw) || Buffer.from(raw, 'base64').length !== 32)
      throw new ProjectSecretError('key-unavailable')
    this.key = Buffer.from(raw, 'base64')
  }
  encrypt(context: string, value: unknown): string {
    const nonce = randomBytes(12)
    const cipher = createCipheriv('aes-256-gcm', this.key, nonce)
    cipher.setAAD(Buffer.from(context))
    const data = Buffer.concat([cipher.update(JSON.stringify(value)), cipher.final()])
    return Buffer.concat([nonce, cipher.getAuthTag(), data]).toString('base64')
  }
  decrypt(context: string, envelope: string): unknown {
    try {
      const data = Buffer.from(envelope, 'base64')
      if (data.length < 29) throw new Error()
      const cipher = createDecipheriv('aes-256-gcm', this.key, data.subarray(0, 12))
      cipher.setAAD(Buffer.from(context))
      cipher.setAuthTag(data.subarray(12, 28))
      return JSON.parse(
        Buffer.concat([cipher.update(data.subarray(28)), cipher.final()]).toString(),
      )
    } catch {
      throw new ProjectSecretError('key-unavailable')
    }
  }
  fingerprint(value: unknown): string {
    return createHmac('sha256', this.key)
      .update('project-secret-fingerprint-v1\0')
      .update(JSON.stringify(value))
      .digest('hex')
      .slice(0, 16)
  }
}
