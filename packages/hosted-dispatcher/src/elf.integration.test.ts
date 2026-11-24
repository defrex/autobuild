import { describe, expect, test } from 'bun:test'
import { readElf, rewriteInterpreter } from './elf'

describe('rewriteInterpreter', () => {
  test.skipIf(!(process.platform === 'linux' && process.arch === 'x64' && Bun.which('git')))(
    'rewrites a real git binary',
    async () => {
      const { realpath } = await import('node:fs/promises')
      const bytes = new Uint8Array(await Bun.file(await realpath(Bun.which('git')!)).arrayBuffer())
      const before = readElf(bytes)
      expect(before.interpreter?.path).toMatch(/ld-linux-x86-64\.so\.2$/)
      expect(before.needed).toContain('libc.so.6')
      rewriteInterpreter(bytes, '/tmp/abg0123abcd/ld')
      expect(readElf(bytes).interpreter?.path).toBe('/tmp/abg0123abcd/ld')
      expect(readElf(bytes).needed).toEqual(before.needed)
    },
  )
})
