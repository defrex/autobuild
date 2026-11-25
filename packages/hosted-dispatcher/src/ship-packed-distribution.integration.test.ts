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
const MCP_TRACE_DIRECTORIES = [
  join('.next', 'server', 'app', 'mcp'),
  join('.next', 'server', 'app', 'mcp', '[...repo]'),
]

async function fixture(
  archives: string[],
  trace?: string[],
  opts: {
    operatorTrace?: string[]
    withSkill?: boolean
    /** Omit the operator route's trace file entirely (the missing-trace test). */
    skipOperatorTrace?: boolean
    skipMcpTraces?: boolean
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
  // The context-serving MCP routes carry the canonical skills tree.
  if (trace !== undefined && opts.skipMcpTraces !== true)
    for (const directory of MCP_TRACE_DIRECTORIES) {
      await mkdir(join(root, directory), { recursive: true })
      await writeFile(
        join(root, directory, 'route.js.nft.json'),
        JSON.stringify({ version: 1, files: [] }),
      )
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
const skillsOf = (root: string) => join(root, 'skills')

const manifestOf = (root: string) => join(root, 'package.json')

describe('ship-packed-distribution', () => {
  test('appends the archive relative to the trace file and reports evidence', async () => {
    const root = await fixture(['autobuild-0.6.0.tgz'], ['/absolutely/not/real.js'], {
      operatorTrace: [],
    })
    const lines: string[] = []
    const result = await ensureDistributionArchiveInTrace({
      root,
      manifest: manifestOf(root),
      skill: skillOf(root),
      skills: skillsOf(root),
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
    const operatorTraceFile = join(root, OPERATOR_TRACE_DIRECTORY, 'route.js.nft.json')
    expect(JSON.parse(await readFile(operatorTraceFile, 'utf8')).files).toEqual([
      relative(join(operatorTraceFile, '..'), skillOf(root)),
    ])
    expect(result.skillAppended).toEqual(['dispatch', 'operator'])
    const before = await Promise.all(
      [traceFile, operatorTraceFile].map((path) => readFile(path, 'utf8')),
    )
    lines.length = 0
    const rerun = await ensureDistributionArchiveInTrace({
      root,
      manifest: manifestOf(root),
      skill: skillOf(root),
      skills: skillsOf(root),
      log: (message) => lines.push(message),
    })
    expect(rerun.appended).toBe(false)
    expect(rerun.manifestAppended).toBe(false)
    expect(rerun.skillAppended).toEqual([])
    expect(
      await Promise.all([traceFile, operatorTraceFile].map((path) => readFile(path, 'utf8'))),
    ).toEqual(before)
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
        skills: skillsOf(root),
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
      skills: skillsOf(root),
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
        skills: skillsOf(root),
      }),
    ).rejects.toThrow('missing distribution manifest')
  })

  test('defaults the manifest to the file provisioning reads', async () => {
    const root = await fixture(['autobuild-0.6.0.tgz'], [])
    const result = await ensureDistributionArchiveInTrace({
      root,
      skill: skillOf(root),
      skills: skillsOf(root),
      log: () => {},
    })
    const traceFile = join(root, TRACE_DIRECTORY, 'route.js.nft.json')
    const { files } = JSON.parse(await readFile(traceFile, 'utf8'))
    expect(result.manifestAppended).toBe(true)
    expect(files).toContain(relative(join(traceFile, '..'), distributionManifestPath()))
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
      skills: skillsOf(root),
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
  test('throws loudly when the operate skill file is missing', async () => {
    const root = await fixture(['autobuild-0.6.0.tgz'], [], { withSkill: false, operatorTrace: [] })
    await expect(
      ensureDistributionArchiveInTrace({
        root,
        manifest: manifestOf(root),
        skill: skillOf(root),
        skills: skillsOf(root),
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
        skills: skillsOf(root),
      }),
    ).rejects.toThrow('operator/[[...path]]/route.js.nft.json')
  })
})

describe('ship-packed-distribution — canonical skills tree (#1225)', () => {
  test('appends every skills file to the operator and both MCP traces, idempotently', async () => {
    const root = await fixture(['autobuild-0.6.0.tgz'], [], { operatorTrace: [] })
    await mkdir(join(root, 'skills', 'guide', 'references'), { recursive: true })
    const reference = join(root, 'skills', 'guide', 'references', 'spec-standard.md')
    await writeFile(reference, '# standard\n')
    const options = {
      root,
      manifest: manifestOf(root),
      skill: skillOf(root),
      skills: skillsOf(root),
      log: () => {},
    }
    const result = await ensureDistributionArchiveInTrace(options)
    expect(result.skillsAppended).toEqual(['operator', 'mcp', 'mcp-repository'])
    for (const directory of [OPERATOR_TRACE_DIRECTORY, ...MCP_TRACE_DIRECTORIES]) {
      const trace = join(root, directory, 'route.js.nft.json')
      const { files } = JSON.parse(await readFile(trace, 'utf8'))
      for (const file of [skillOf(root), reference])
        expect(
          files.filter((entry: string) => entry === relative(join(trace, '..'), file)),
        ).toHaveLength(1)
    }
    const dispatch = JSON.parse(
      await readFile(join(root, TRACE_DIRECTORY, 'route.js.nft.json'), 'utf8'),
    )
    expect(dispatch.files).not.toContain(relative(join(root, TRACE_DIRECTORY), reference))
    expect((await ensureDistributionArchiveInTrace(options)).skillsAppended).toEqual([])
  })

  test('throws loudly when an MCP route trace file is missing', async () => {
    const root = await fixture(['autobuild-0.6.0.tgz'], [], {
      operatorTrace: [],
      skipMcpTraces: true,
    })
    await expect(
      ensureDistributionArchiveInTrace({
        root,
        manifest: manifestOf(root),
        skill: skillOf(root),
        skills: skillsOf(root),
        log: () => {},
      }),
    ).rejects.toThrow('mcp/route.js.nft.json')
  })
})
