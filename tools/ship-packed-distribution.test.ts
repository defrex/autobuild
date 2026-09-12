import { afterEach, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { createHash } from 'node:crypto'
import { ensureDistributionArchiveInTrace } from './ship-packed-distribution'

const temporary: string[] = []
afterEach(async () => {
  await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

const TRACE_DIRECTORY = join('.next', 'server', 'app', 'api', 'dispatch')

async function fixture(archives: string[], trace?: string[]): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'ab-ship-dist-'))
  temporary.push(root)
  await mkdir(join(root, '.autobuild-dist'), { recursive: true })
  for (const name of archives) {
    await writeFile(join(root, '.autobuild-dist', name), `archive ${name}`)
  }
  if (trace !== undefined) {
    await mkdir(join(root, TRACE_DIRECTORY), { recursive: true })
    await writeFile(
      join(root, TRACE_DIRECTORY, 'route.js.nft.json'),
      JSON.stringify({ version: 1, files: trace }),
    )
  }
  return root
}

describe('ship-packed-distribution', () => {
  test('appends the archive relative to the trace file and reports evidence', async () => {
    const root = await fixture(['autobuild-0.6.0.tgz'], ['/absolutely/not/real.js'])
    const lines: string[] = []
    const result = await ensureDistributionArchiveInTrace({
      root,
      log: (message) => lines.push(message),
    })
    const traceFile = join(root, TRACE_DIRECTORY, 'route.js.nft.json')
    const { files } = JSON.parse(await readFile(traceFile, 'utf8'))
    expect(files).toEqual([
      '/absolutely/not/real.js',
      relative(join(traceFile, '..'), result.archive),
    ])
    expect(result.appended).toBe(true)
    expect(result.bytes).toBe('archive autobuild-0.6.0.tgz'.length)
    expect(result.sha256).toBe(
      createHash('sha256').update('archive autobuild-0.6.0.tgz').digest('hex'),
    )
    expect(lines.join('\n')).toContain('appended to')
    expect(lines.join('\n')).toContain('sha256')
  })

  test('is a no-op when the entry is already present', async () => {
    const root = await fixture(['autobuild-0.6.0.tgz'], [])
    const traceFile = join(root, TRACE_DIRECTORY, 'route.js.nft.json')
    // Rewrite the trace with the entry the tool would have produced.
    const entry = relative(
      join(traceFile, '..'),
      join(root, '.autobuild-dist', 'autobuild-0.6.0.tgz'),
    )
    await writeFile(traceFile, JSON.stringify({ version: 1, files: [entry] }))
    const before = await readFile(traceFile, 'utf8')
    const lines: string[] = []
    const result = await ensureDistributionArchiveInTrace({ root, log: (m) => lines.push(m) })
    expect(result.appended).toBe(false)
    expect(await readFile(traceFile, 'utf8')).toBe(before)
    expect(lines.join('\n')).toContain('already present in')
  })

  test('throws when no archive has been packed', async () => {
    const root = await fixture([], ['/real.js'])
    await expect(ensureDistributionArchiveInTrace({ root })).rejects.toThrow('pack-distribution')
  })

  test('throws when more than one archive exists', async () => {
    const root = await fixture(['autobuild-0.6.0.tgz', 'autobuild-0.5.0.tgz'], ['/real.js'])
    await expect(ensureDistributionArchiveInTrace({ root })).rejects.toThrow(
      'expected exactly one archive',
    )
  })

  test('throws when the trace file is missing', async () => {
    const root = await fixture(['autobuild-0.6.0.tgz'])
    await expect(ensureDistributionArchiveInTrace({ root })).rejects.toThrow('after `next build`')
  })
})
