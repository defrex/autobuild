import { describe, expect, test } from 'bun:test'
import { ElfError, isElf, readElf, rewriteInterpreter } from './elf'
import { elf } from './testing/elf'

describe('readElf', () => {
  test('reads the interpreter, needed libraries, search paths and ABI tag', () => {
    const info = readElf(
      elf({
        interpreter: { path: '/lib64/ld-linux-x86-64.so.2', size: 28 },
        needed: ['libz.so.1', 'libc.so.6'],
        runpath: '$ORIGIN/../lib:/opt/lib',
        rpath: '/usr/local/lib',
        abiTag: [3, 2, 0],
      }),
    )
    expect(info.interpreter).toMatchObject({ path: '/lib64/ld-linux-x86-64.so.2', size: 28 })
    expect(info.needed).toEqual(['libz.so.1', 'libc.so.6'])
    expect(info.runpath).toEqual(['$ORIGIN/../lib', '/opt/lib'])
    expect(info.rpath).toEqual(['/usr/local/lib'])
    expect(info.abiTag).toEqual({ os: 0, kernel: '3.2.0' })
  })

  test('a shared library without an interpreter reads cleanly', () => {
    const info = readElf(elf({ needed: ['libc.so.6'] }))
    expect(info.interpreter).toBeUndefined()
    expect(info.needed).toEqual(['libc.so.6'])
  })

  test('rejects anything but x86_64 ELF64 little-endian', () => {
    expect(() => readElf(new TextEncoder().encode('#!/bin/sh\n'))).toThrow(ElfError)
    expect(() => readElf(elf({ cls: 1 }))).toThrow('not a 64-bit ELF object')
    expect(() => readElf(elf({ data: 2 }))).toThrow('not a little-endian ELF object')
    expect(() => readElf(elf({ machine: 183 }))).toThrow('ELF machine 183 is not x86_64')
    expect(isElf(new TextEncoder().encode('#!/bin/sh'))).toBe(false)
  })
})

describe('rewriteInterpreter', () => {
  test('writes the new loader and NUL-pads the rest of the segment', () => {
    const bytes = elf({ interpreter: { path: '/lib64/ld-linux-x86-64.so.2', size: 28 } })
    expect(rewriteInterpreter(bytes, '/tmp/abg0123abcd/ld')).toBe(true)
    const interpreter = readElf(bytes).interpreter!
    expect(interpreter.path).toBe('/tmp/abg0123abcd/ld')
    expect([...bytes.subarray(interpreter.offset + 19, interpreter.offset + 28)]).toEqual(
      Array(9).fill(0),
    )
  })

  test('leaves objects without an interpreter alone', () => {
    const bytes = elf({ needed: ['libc.so.6'] })
    const before = bytes.slice()
    expect(rewriteInterpreter(bytes, '/tmp/abg0123abcd/ld')).toBe(false)
    expect(bytes).toEqual(before)
  })

  test('refuses a loader path that does not fit the segment', () => {
    const bytes = elf({ interpreter: { path: '/l', size: 12 } })
    expect(() => rewriteInterpreter(bytes, '/tmp/abg0123abcd/ld')).toThrow(
      'needs 20 bytes but the segment holds 12',
    )
  })

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
