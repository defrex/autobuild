import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  type ReadmeHeadlineEnvironment,
  type ReadmeHeadlineOutput,
  runReadmeHeadline,
} from './readme-headline'

let tmp: string

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'ab-readme-headline-'))
  await mkdir(join(tmp, 'docs', 'assets'), { recursive: true })
})

afterEach(async () => {
  await rm(tmp, { recursive: true, force: true })
})

const generated = new Uint8Array([137, 80, 78, 71, 1, 2, 3])

function harness(
  overrides: Partial<ReadmeHeadlineEnvironment> = {},
  frames: { id: string; png: Uint8Array; pngPath: string }[] = [
    { id: 'mixed-wide', png: new Uint8Array([9]), pngPath: '/scratch/mixed-wide.png' },
    { id: 'headline-happy-wide', png: generated, pngPath: '/scratch/headline-happy-wide.png' },
  ],
) {
  const stdout: string[] = []
  const stderr: string[] = []
  const captureOptions: unknown[] = []
  const writes: string[] = []
  const env: ReadmeHeadlineEnvironment = {
    repoRoot: tmp,
    captureFrames: async (options) => {
      captureOptions.push(options)
      return { frames }
    },
    readFile,
    writeFile: async (path, contents) => {
      writes.push(path)
      await writeFile(path, contents)
    },
    ...overrides,
  }
  const output: ReadmeHeadlineOutput = {
    stdout: (message) => stdout.push(message),
    stderr: (message) => stderr.push(message),
  }
  return { env, output, stdout, stderr, captureOptions, writes }
}

const headlinePath = () => join(tmp, 'docs', 'assets', 'headline-wide.png')

describe('runReadmeHeadline', () => {
  test('regenerates exact bytes from the uniquely named frame rather than array position', async () => {
    const stub = harness()

    expect(await runReadmeHeadline([], stub.env, stub.output)).toBe(0)
    expect([...(await readFile(headlinePath()))]).toEqual([...generated])
    expect(stub.captureOptions).toEqual([{ workspacePath: tmp }])
    expect(stub.stdout.join('')).toContain('dashboard frame "headline-happy-wide"')
    expect(stub.stdout.join('')).toContain('docs/assets/headline-wide.png')
  })

  test('check passes only when the tracked bytes are unchanged', async () => {
    await writeFile(headlinePath(), generated)
    const stub = harness()

    expect(await runReadmeHeadline(['--check'], stub.env, stub.output)).toBe(0)
    expect(stub.writes).toEqual([])
    expect(stub.stdout.join('')).toContain('byte for byte')
    expect(stub.stderr).toEqual([])
  })

  test('a stale check fails actionably without mutating the tracked file', async () => {
    const stale = new Uint8Array([4, 5, 6])
    await writeFile(headlinePath(), stale)
    const stub = harness()

    expect(await runReadmeHeadline(['--check'], stub.env, stub.output)).toBe(1)
    expect([...(await readFile(headlinePath()))]).toEqual([...stale])
    expect(stub.writes).toEqual([])
    expect(stub.stderr.join('')).toContain('README headline is stale')
    expect(stub.stderr.join('')).toContain('bun run capture:readme-headline')
  })

  test('a missing tracked image fails actionably without creating it', async () => {
    const stub = harness()

    expect(await runReadmeHeadline(['--check'], stub.env, stub.output)).toBe(1)
    expect(Bun.file(headlinePath()).exists()).resolves.toBe(false)
    expect(stub.writes).toEqual([])
    expect(stub.stderr.join('')).toContain('README headline is missing')
    expect(stub.stderr.join('')).toContain('bun run capture:readme-headline')
  })

  test('missing and duplicate source frames fail clearly', async () => {
    for (const frames of [
      [{ id: 'mixed-wide', png: generated, pngPath: '/scratch/mixed-wide.png' }],
      [
        {
          id: 'headline-happy-wide',
          png: generated,
          pngPath: '/scratch/happy-wide-1.png',
        },
        {
          id: 'headline-happy-wide',
          png: generated,
          pngPath: '/scratch/happy-wide-2.png',
        },
      ],
    ]) {
      const stub = harness({}, frames)

      expect(await runReadmeHeadline([], stub.env, stub.output)).toBe(1)
      expect(stub.writes).toEqual([])
      expect(stub.stderr.join('')).toContain('expected exactly one dashboard frame named')
    }
  })

  test('unsupported arguments fail before capture', async () => {
    const stub = harness()

    expect(await runReadmeHeadline(['--write'], stub.env, stub.output)).toBe(1)
    expect(stub.captureOptions).toEqual([])
    expect(stub.stderr.join('')).toContain('usage: bun run capture:readme-headline [--check]')
  })

  test('capture and unreadable-asset errors fail closed', async () => {
    const captureFailure = harness({
      captureFrames: async () => {
        throw new Error('scripted capture failed')
      },
    })
    expect(await runReadmeHeadline(['--check'], captureFailure.env, captureFailure.output)).toBe(1)
    expect(captureFailure.stderr.join('')).toContain('scripted capture failed')

    const readFailure = harness({
      readFile: async () => {
        throw Object.assign(new Error('permission denied'), { code: 'EACCES' })
      },
    })
    expect(await runReadmeHeadline(['--check'], readFailure.env, readFailure.output)).toBe(1)
    expect(readFailure.stderr.join('')).toContain('could not read docs/assets/headline-wide.png')
  })
})
