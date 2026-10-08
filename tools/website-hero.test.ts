import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { heroFrameBytes, runWebsiteHero, type WebsiteHeroEnvironment } from './website-hero'

let tmp: string

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'ab-website-hero-'))
  await mkdir(join(tmp, 'packages', 'website', 'src'), { recursive: true })
})

afterEach(async () => {
  await rm(tmp, { recursive: true, force: true })
})

const LINES = [' > \x1b[1mAutobuild\x1b[0m  origin', '   \x1b[32mintake ON\x1b[0m']

function harness(frames = [{ id: 'website-hero', lines: LINES, textPath: '/scratch/hero.txt' }]) {
  const stdout: string[] = []
  const stderr: string[] = []
  const writes: string[] = []
  const env: WebsiteHeroEnvironment = {
    repoRoot: tmp,
    captureFrames: async () => ({ frames }),
    readFile,
    writeFile: async (path, contents) => {
      writes.push(path)
      await writeFile(path, contents)
    },
  }
  const output = {
    stdout: (message: string) => stdout.push(message),
    stderr: (message: string) => stderr.push(message),
  }
  return { env, output, stdout, stderr, writes }
}

const assetPath = () => join(tmp, 'packages', 'website', 'src', 'hero-frame.txt')

describe('heroFrameBytes', () => {
  test('keeps the escapes, one row per line, with a final newline', () => {
    expect(new TextDecoder().decode(heroFrameBytes(LINES))).toBe(
      ' > \x1b[1mAutobuild\x1b[0m  origin\n   \x1b[32mintake ON\x1b[0m\n',
    )
  })
})

describe('runWebsiteHero', () => {
  test('regenerates the tracked frame from the website-hero capture', async () => {
    const stub = harness()

    expect(await runWebsiteHero([], stub.env, stub.output)).toBe(0)
    expect(await readFile(assetPath(), 'utf8')).toBe(
      new TextDecoder().decode(heroFrameBytes(LINES)),
    )
    expect(stub.stdout.join('')).toContain('dashboard frame "website-hero"')
    expect(stub.stdout.join('')).toContain('packages/website/src/hero-frame.txt')
  })

  test('check passes only on identical bytes and names the regeneration command when stale', async () => {
    await writeFile(assetPath(), heroFrameBytes(LINES))
    const same = harness()
    expect(await runWebsiteHero(['--check'], same.env, same.output)).toBe(0)
    expect(same.writes).toEqual([])
    expect(same.stdout.join('')).toContain('byte for byte')

    await writeFile(assetPath(), heroFrameBytes([' > stale']))
    const stale = harness()
    expect(await runWebsiteHero(['--check'], stale.env, stale.output)).toBe(1)
    expect(stale.writes).toEqual([])
    expect(stale.stderr.join('')).toContain('website hero frame is stale')
    expect(stale.stderr.join('')).toContain('bun run capture:website-hero')
  })

  test('a missing tracked frame fails without creating it', async () => {
    const stub = harness()

    expect(await runWebsiteHero(['--check'], stub.env, stub.output)).toBe(1)
    expect(await Bun.file(assetPath()).exists()).toBe(false)
    expect(stub.stderr.join('')).toContain('website hero frame is missing')
  })

  test('a capture without exactly one website-hero frame fails clearly', async () => {
    const stub = harness([{ id: 'headline-happy-wide', lines: LINES, textPath: '/scratch/h.txt' }])

    expect(await runWebsiteHero([], stub.env, stub.output)).toBe(1)
    expect(stub.writes).toEqual([])
    expect(stub.stderr.join('')).toContain('expected exactly one dashboard frame named')
  })
})
