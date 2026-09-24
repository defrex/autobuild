import { afterEach, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { createHash } from 'node:crypto'
import { distributionManifestPath } from '@defrex/autobuild/distribution'
import { ensureDistributionArchiveInTrace } from './ship-packed-distribution'

const temporary: string[] = []
afterEach(async () => {
  await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

const TRACE_DIRECTORY = join('.next', 'server', 'app', 'api', 'dispatch')
const OPERATOR_TRACE_DIRECTORY = join('.next', 'server', 'app', 'operator', '[[...path]]')

async function fixture(
  archives: string[],
  trace?: string[],
  opts: {
    operatorTrace?: string[]
    withSkill?: boolean
    /** Omit the operator route's trace file entirely (the missing-trace test). */
    skipOperatorTrace?: boolean
  } = {},
): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'ab-ship-dist-'))
  temporary.push(root)
  await writeFile(join(root, 'package.json'), '{"name":"@defrex/autobuild","version":"0.6.0"}')
  await mkdir(join(root, '.autobuild-dist'), { recursive: true })
  for (const name of archives) {
    await writeFile(join(root, '.autobuild-dist', name), `archive ${name}`)
  }
  // The canonical operate skill the ship step carries into both turn bundles.
  if (opts.withSkill !== false) {
    await mkdir(join(root, 'skills', 'operate'), { recursive: true })
    await writeFile(join(root, 'skills', 'operate', 'SKILL.md'), '# operate skill\n')
  }
  if (trace !== undefined) {
    // Both turn-executing routes ship trace files; the tool requires both.
    for (const directory of [
      TRACE_DIRECTORY,
      opts.operatorTrace === undefined && opts.skipOperatorTrace !== true
        ? OPERATOR_TRACE_DIRECTORY
        : null,
    ]) {
      if (directory === null) continue
      await mkdir(join(root, directory), { recursive: true })
      await writeFile(
        join(root, directory, 'route.js.nft.json'),
        JSON.stringify({ version: 1, files: trace }),
      )
    }
  }
  if (opts.operatorTrace !== undefined) {
    await mkdir(join(root, OPERATOR_TRACE_DIRECTORY), { recursive: true })
    await writeFile(
      join(root, OPERATOR_TRACE_DIRECTORY, 'route.js.nft.json'),
      JSON.stringify({ version: 1, files: opts.operatorTrace }),
    )
  }
  return root
}

const skillOf = (root: string) => join(root, 'skills', 'operate', 'SKILL.md')

const manifestOf = (root: string) => join(root, 'package.json')

describe('ship-packed-distribution', () => {
  test('appends the archive relative to the trace file and reports evidence', async () => {
    const root = await fixture(['autobuild-0.6.0.tgz'], ['/absolutely/not/real.js'])
    const lines: string[] = []
    const result = await ensureDistributionArchiveInTrace({
      root,
      manifest: manifestOf(root),
      skill: skillOf(root),
      log: (message) => lines.push(message),
    })
    const traceFile = join(root, TRACE_DIRECTORY, 'route.js.nft.json')
    const { files } = JSON.parse(await readFile(traceFile, 'utf8'))
    expect(files).toEqual([
      '/absolutely/not/real.js',
      relative(join(traceFile, '..'), result.archive),
      relative(join(traceFile, '..'), manifestOf(root)),
      relative(join(traceFile, '..'), skillOf(root)),
    ])
    expect(result.appended).toBe(true)
    expect(result.manifestAppended).toBe(true)
    expect(result.bytes).toBe('archive autobuild-0.6.0.tgz'.length)
    expect(result.sha256).toBe(
      createHash('sha256').update('archive autobuild-0.6.0.tgz').digest('hex'),
    )
    expect(lines.join('\n')).toContain('appended to')
    expect(lines.join('\n')).toContain('sha256')
  })

  test('is a no-op when the entries are already present', async () => {
    const root = await fixture(['autobuild-0.6.0.tgz'], [])
    const traceFile = join(root, TRACE_DIRECTORY, 'route.js.nft.json')
    // Rewrite the trace with the entries the tool would have produced.
    const entry = relative(
      join(traceFile, '..'),
      join(root, '.autobuild-dist', 'autobuild-0.6.0.tgz'),
    )
    const manifestEntry = relative(join(traceFile, '..'), manifestOf(root))
    await writeFile(
      traceFile,
      JSON.stringify({
        version: 1,
        files: [entry, manifestEntry, relative(join(traceFile, '..'), skillOf(root))],
      }),
    )
    const before = await readFile(traceFile, 'utf8')
    const lines: string[] = []
    const result = await ensureDistributionArchiveInTrace({
      root,
      manifest: manifestOf(root),
      skill: skillOf(root),
      log: (m) => lines.push(m),
    })
    expect(result.appended).toBe(false)
    expect(result.manifestAppended).toBe(false)
    expect(await readFile(traceFile, 'utf8')).toBe(before)
    expect(lines.join('\n')).toContain('already present in')
  })

  test('throws when no archive has been packed', async () => {
    const root = await fixture([], ['/real.js'])
    await expect(
      ensureDistributionArchiveInTrace({ root, manifest: manifestOf(root), skill: skillOf(root) }),
    ).rejects.toThrow('pack-distribution')
  })

  test('throws when more than one archive exists', async () => {
    const root = await fixture(['autobuild-0.6.0.tgz', 'autobuild-0.5.0.tgz'], ['/real.js'])
    await expect(
      ensureDistributionArchiveInTrace({
        root,
        manifest: manifestOf(root),
        skill: skillOf(root),
      }),
    ).rejects.toThrow('expected exactly one archive')
  })

  test('throws when the trace file is missing', async () => {
    const root = await fixture(['autobuild-0.6.0.tgz'])
    await expect(
      ensureDistributionArchiveInTrace({ root, manifest: manifestOf(root), skill: skillOf(root) }),
    ).rejects.toThrow('after `next build`')
  })

  test('appends only the manifest when the archive is already traced', async () => {
    const root = await fixture(['autobuild-0.6.0.tgz'], [])
    const traceFile = join(root, TRACE_DIRECTORY, 'route.js.nft.json')
    const entry = relative(
      join(traceFile, '..'),
      join(root, '.autobuild-dist', 'autobuild-0.6.0.tgz'),
    )
    await writeFile(
      traceFile,
      JSON.stringify({
        version: 1,
        files: [entry, relative(join(traceFile, '..'), skillOf(root))],
      }),
    )
    const result = await ensureDistributionArchiveInTrace({
      root,
      manifest: manifestOf(root),
      skill: skillOf(root),
      log: () => {},
    })
    const { files } = JSON.parse(await readFile(traceFile, 'utf8'))
    expect(files).toEqual([
      entry,
      relative(join(traceFile, '..'), skillOf(root)),
      relative(join(traceFile, '..'), manifestOf(root)),
    ])
    expect(result.appended).toBe(false)
    expect(result.manifestAppended).toBe(true)
  })

  test('throws when the distribution manifest is missing', async () => {
    const root = await fixture(['autobuild-0.6.0.tgz'], [])
    await expect(
      ensureDistributionArchiveInTrace({
        root,
        manifest: join(root, 'absent.json'),
        skill: skillOf(root),
      }),
    ).rejects.toThrow('missing distribution manifest')
  })

  test('defaults the manifest to the file provisioning reads', async () => {
    const root = await fixture(['autobuild-0.6.0.tgz'], [])
    const result = await ensureDistributionArchiveInTrace({
      root,
      skill: skillOf(root),
      log: () => {},
    })
    const traceFile = join(root, TRACE_DIRECTORY, 'route.js.nft.json')
    const { files } = JSON.parse(await readFile(traceFile, 'utf8'))
    expect(result.manifestAppended).toBe(true)
    expect(files).toContain(relative(join(traceFile, '..'), distributionManifestPath()))
  })

  test('splits the appendage per route: archive and manifest only on dispatch (AUT-589)', async () => {
    const root = await fixture(['autobuild-0.6.0.tgz'], [], { operatorTrace: [] })
    const result = await ensureDistributionArchiveInTrace({
      root,
      manifest: manifestOf(root),
      skill: skillOf(root),
      log: () => {},
    })
    const dispatchTraceFile = join(root, TRACE_DIRECTORY, 'route.js.nft.json')
    const dispatchFiles = JSON.parse(await readFile(dispatchTraceFile, 'utf8')).files as string[]
    // The dispatch route carries all three: archive, manifest, and skill.
    expect(dispatchFiles).toEqual([
      relative(join(dispatchTraceFile, '..'), result.archive),
      relative(join(dispatchTraceFile, '..'), manifestOf(root)),
      relative(join(dispatchTraceFile, '..'), skillOf(root)),
    ])
    const operatorTraceFile = join(root, OPERATOR_TRACE_DIRECTORY, 'route.js.nft.json')
    const operatorFiles = JSON.parse(await readFile(operatorTraceFile, 'utf8')).files as string[]
    // The operator route carries only the skill — never the multi-megabyte
    // archive or the manifest it does not read.
    expect(operatorFiles).toEqual([relative(join(operatorTraceFile, '..'), skillOf(root))])
    expect(result.skillAppended).toEqual(['dispatch', 'operator'])
  })

  test('leaves the operator trace byte-for-byte intact when it already carries the skill', async () => {
    const root = await fixture(['autobuild-0.6.0.tgz'], [], { operatorTrace: [] })
    const operatorTraceFile = join(root, OPERATOR_TRACE_DIRECTORY, 'route.js.nft.json')
    const parsed = JSON.parse(await readFile(operatorTraceFile, 'utf8'))
    await writeFile(
      operatorTraceFile,
      JSON.stringify({
        ...parsed,
        files: [relative(join(operatorTraceFile, '..'), skillOf(root))],
      }),
    )
    const before = await readFile(operatorTraceFile, 'utf8')
    const result = await ensureDistributionArchiveInTrace({
      root,
      manifest: manifestOf(root),
      skill: skillOf(root),
      log: () => {},
    })
    // Per-route idempotence: the operator trace is untouched; the dispatch
    // trace gains all three entries.
    expect(await readFile(operatorTraceFile, 'utf8')).toBe(before)
    const dispatchTraceFile = join(root, TRACE_DIRECTORY, 'route.js.nft.json')
    const dispatchFiles = JSON.parse(await readFile(dispatchTraceFile, 'utf8')).files as string[]
    expect(dispatchFiles).toContain(relative(join(dispatchTraceFile, '..'), result.archive))
    expect(dispatchFiles).toContain(relative(join(dispatchTraceFile, '..'), manifestOf(root)))
    expect(dispatchFiles).toContain(relative(join(dispatchTraceFile, '..'), skillOf(root)))
    expect(result.appended).toBe(true)
    expect(result.manifestAppended).toBe(true)
    expect(result.skillAppended).toEqual(['dispatch'])
  })
})

describe('ship-packed-distribution — operate skill (AUT-342)', () => {
  test('appends the operate skill to both turn-executing trace files', async () => {
    const root = await fixture(['autobuild-0.6.0.tgz'], [], {
      operatorTrace: [],
    })
    const result = await ensureDistributionArchiveInTrace({
      root,
      manifest: manifestOf(root),
      skill: skillOf(root),
      log: () => {},
    })
    expect(result.skillAppended).toEqual(['dispatch', 'operator'])
    for (const directory of [TRACE_DIRECTORY, OPERATOR_TRACE_DIRECTORY]) {
      const traceFile = join(root, directory, 'route.js.nft.json')
      const { files } = JSON.parse(await readFile(traceFile, 'utf8'))
      expect(files).toContain(relative(join(traceFile, '..'), skillOf(root)))
    }
  })

  test('is a no-op for the skill when both traces already carry it', async () => {
    const root = await fixture(['autobuild-0.6.0.tgz'], [], { operatorTrace: [] })
    for (const directory of [TRACE_DIRECTORY, OPERATOR_TRACE_DIRECTORY]) {
      const traceFile = join(root, directory, 'route.js.nft.json')
      const parsed = JSON.parse(await readFile(traceFile, 'utf8'))
      await writeFile(
        traceFile,
        JSON.stringify({
          ...parsed,
          files: [...parsed.files, relative(join(traceFile, '..'), skillOf(root))],
        }),
      )
    }
    const result = await ensureDistributionArchiveInTrace({
      root,
      manifest: manifestOf(root),
      skill: skillOf(root),
      log: () => {},
    })
    expect(result.skillAppended).toEqual([])
  })

  test('throws loudly when the operate skill file is missing', async () => {
    const root = await fixture(['autobuild-0.6.0.tgz'], [], { withSkill: false, operatorTrace: [] })
    await expect(
      ensureDistributionArchiveInTrace({
        root,
        manifest: manifestOf(root),
        skill: skillOf(root),
      }),
    ).rejects.toThrow('missing canonical operate skill')
  })

  test('throws loudly when the operator route trace file is missing', async () => {
    const root = await fixture(['autobuild-0.6.0.tgz'], [], { skipOperatorTrace: true })
    await expect(
      ensureDistributionArchiveInTrace({
        root,
        manifest: manifestOf(root),
        skill: skillOf(root),
      }),
    ).rejects.toThrow('operator/[[...path]]/route.js.nft.json')
  })
})
