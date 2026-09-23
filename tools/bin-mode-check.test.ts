import { afterEach, describe, expect, test } from 'bun:test'
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  collectBinEntries,
  evaluateBinModes,
  runBinModeCheck,
  trackedModes,
  worktreeExecutability,
} from './bin-mode-check'

const temporary: string[] = []
afterEach(async () => {
  await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

interface GitFixture {
  root: string
  rootBin: string
  workspaceBin: string
}

async function git(
  root: string,
  args: readonly string[],
): Promise<{ stdout: string; code: number }> {
  const processHandle = Bun.spawn(['git', ...args], {
    cwd: root,
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [stdout, stderr, code] = await Promise.all([
    new Response(processHandle.stdout).text(),
    new Response(processHandle.stderr).text(),
    processHandle.exited,
  ])
  if (code !== 0) throw new Error(`git ${args.join(' ')} failed: ${stderr.trim()}`)
  return { stdout, code }
}

/**
 * A hermetic two-package git repository: a root manifest with its own bin
 * entry plus one workspace package with a nested bin target, mirroring the
 * real repository's `bin/ab.ts` and nested `src/bin.ts` workspace targets.
 */
async function fixture(options?: {
  rootBinMode?: number
  workspaceBinMode?: number
  /** Working-tree chmod for the bin sources, applied after the commit (the
   * `*BinMode` options above are applied before it). */
  worktreeRootBinMode?: number
  worktreeWorkspaceBinMode?: number
  trackRootBin?: boolean
  trackWorkspaceBin?: boolean
  extraWorkspaceBins?: Record<string, { content: string; mode?: number; track?: boolean }>
}): Promise<GitFixture> {
  const root = await mkdtemp(join(tmpdir(), 'ab-bin-mode-'))
  temporary.push(root)
  const rootBin = join(root, 'bin', 'ab.ts')
  const workspaceBin = join(root, 'packages', 'svc', 'src', 'bin.ts')
  await mkdir(join(root, 'bin'), { recursive: true })
  await mkdir(join(root, 'packages', 'svc', 'src'), { recursive: true })
  await writeFile(
    join(root, 'package.json'),
    JSON.stringify({
      name: 'fixture',
      version: '1.0.0',
      workspaces: ['packages/*'],
      bin: { ab: 'bin/ab.ts' },
    }),
  )
  await writeFile(
    join(root, 'packages', 'svc', 'package.json'),
    JSON.stringify({
      name: '@fixture/svc',
      version: '1.0.0',
      bin: {
        'svc-cli': './src/bin.ts',
        ...Object.fromEntries(
          Object.keys(options?.extraWorkspaceBins ?? {}).map((name) => [name, `./src/${name}.ts`]),
        ),
      },
    }),
  )
  await writeFile(rootBin, '#!/usr/bin/env bun\n')
  await writeFile(workspaceBin, '#!/usr/bin/env bun\n')
  await chmod(rootBin, options?.rootBinMode ?? 0o755)
  await chmod(workspaceBin, options?.workspaceBinMode ?? 0o755)
  const extraSources: string[] = []
  for (const [name, spec] of Object.entries(options?.extraWorkspaceBins ?? {})) {
    const source = join(root, 'packages', 'svc', 'src', `${name}.ts`)
    await writeFile(source, spec.content)
    await chmod(source, spec.mode ?? 0o755)
    extraSources.push(source)
  }
  await git(root, ['init'])
  const tracked = [join(root, 'package.json'), join(root, 'packages', 'svc', 'package.json')]
  if (options?.trackRootBin ?? true) tracked.push(rootBin)
  if (options?.trackWorkspaceBin ?? true) tracked.push(workspaceBin)
  tracked.push(
    ...extraSources.filter((_, index) => {
      const name = Object.keys(options?.extraWorkspaceBins ?? {})[index]
      if (name === undefined) return true
      return options?.extraWorkspaceBins?.[name]?.track ?? true
    }),
  )
  await git(root, ['add', ...tracked])
  await git(root, ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init'])
  if (options && options.trackRootBin === false) await writeFile(rootBin, '#!/usr/bin/env bun\n')
  if (options && options.trackWorkspaceBin === false) {
    await writeFile(workspaceBin, '#!/usr/bin/env bun\n')
  }
  if (options?.worktreeRootBinMode !== undefined) await chmod(rootBin, options.worktreeRootBinMode)
  if (options?.worktreeWorkspaceBinMode !== undefined) {
    await chmod(workspaceBin, options.worktreeWorkspaceBinMode)
  }
  return { root, rootBin, workspaceBin }
}

function relative(fixtureResult: GitFixture, path: string): string {
  return path.slice(fixtureResult.root.length + 1)
}

interface Captured {
  stdout: string[]
  stderr: string[]
}

function capture(): { output: Captured; run: (root: string) => Promise<number> } {
  const output: Captured = { stdout: [], stderr: [] }
  return {
    output,
    run: (root) =>
      runBinModeCheck(root, {
        stdout: (message) => output.stdout.push(message),
        stderr: (message) => output.stderr.push(message),
      }),
  }
}

describe('bin mode invariants', () => {
  test('passes when every bin entry is tracked at 100755', async () => {
    const fixtureResult = await fixture()
    const { output, run } = capture()
    expect(await run(fixtureResult.root)).toBe(0)
    expect(output.stderr).toEqual([])
    expect(output.stdout.join('')).toContain(relative(fixtureResult, fixtureResult.rootBin))
    expect(output.stdout.join('')).toContain(relative(fixtureResult, fixtureResult.workspaceBin))
    expect(output.stdout.join('')).toContain('executable working-tree files')
    // The success message must terminate its line like the failure paths do,
    // so terminal output stops concatenating with the next shell output.
    expect(output.stdout.join('').endsWith('\n')).toBe(true)
  })

  test('fails with the mechanism message when a bin source is committed 100644', async () => {
    const fixtureResult = await fixture({ workspaceBinMode: 0o644 })
    const { output, run } = capture()
    expect(await run(fixtureResult.root)).toBe(1)
    const message = output.stdout.join('')
    expect(message).toContain('committed 100644')
    expect(message).toContain('@fixture/svc#svc-cli')
    expect(message).toContain('bun install marks bin-entry sources executable')
    expect(message).toContain('finalize preflight')
    expect(message).toContain('Commit the executable bit')
    // Failure paths already ended with a newline; pin that convention too.
    expect(output.stderr.join('').endsWith('\n')).toBe(true)
  })

  test('fails with the tracking message when a bin source is untracked', async () => {
    const fixtureResult = await fixture({ trackWorkspaceBin: false })
    const { output, run } = capture()
    expect(await run(fixtureResult.root)).toBe(1)
    const message = output.stdout.join('')
    expect(message).toContain('is not tracked by git')
    expect(message).toContain('@fixture/svc#svc-cli')
  })

  test('flags only the offending entry among several in one manifest', async () => {
    const fixtureResult = await fixture({
      extraWorkspaceBins: { other: { content: '#!/usr/bin/env bun\n', mode: 0o644 } },
    })
    const { output, run } = capture()
    expect(await run(fixtureResult.root)).toBe(1)
    const message = output.stdout.join('')
    expect(message).toContain('@fixture/svc#other')
    expect(message).toContain('committed 100644')
    expect(message).not.toContain('@fixture/svc#svc-cli')
  })

  test('fails with the mechanism message when the root manifest bin is committed 100644', async () => {
    const fixtureResult = await fixture({ rootBinMode: 0o644 })
    const { output, run } = capture()
    expect(await run(fixtureResult.root)).toBe(1)
    const message = output.stdout.join('')
    expect(message).toContain('fixture#ab')
    expect(message).toContain('committed 100644')
  })

  test('fails when the index is 100755 but the working tree lost the executable bit', async () => {
    const fixtureResult = await fixture({ worktreeWorkspaceBinMode: 0o644 })
    const { output, run } = capture()
    expect(await run(fixtureResult.root)).toBe(1)
    const message = output.stdout.join('')
    expect(message).toContain('@fixture/svc#svc-cli')
    expect(message).toContain('100755')
    expect(message).toContain('working-tree file is missing or has lost the owner execute bit')
    expect(message).toContain('chmod +x')
    expect(message).toContain('do not stage the mode change')
  })

  test('fails when only group and other execute bits remain (owner bit cleared)', async () => {
    // A 0655 worktree file maps to index mode 100644 in git's accounting even
    // though some execute bits are set: git tracks only the owner bit, so git
    // status reports a 100755→100644 mode change. An any-execute-bit (0o111)
    // predicate would call this clean and miss the dirty state.
    const fixtureResult = await fixture({ worktreeWorkspaceBinMode: 0o0655 })
    const { output, run } = capture()
    expect(await run(fixtureResult.root)).toBe(1)
    const message = output.stdout.join('')
    expect(message).toContain('@fixture/svc#svc-cli')
    expect(message).toContain('owner execute bit')
  })

  test('maps working-tree executability by the owner execute bit', async () => {
    const fixtureResult = await fixture({ worktreeWorkspaceBinMode: 0o0655 })
    const rootBin = relative(fixtureResult, fixtureResult.rootBin)
    const workspaceBin = relative(fixtureResult, fixtureResult.workspaceBin)
    const absent = 'packages/svc/src/absent.ts'
    const executability = await worktreeExecutability(fixtureResult.root, [
      rootBin,
      workspaceBin,
      absent,
    ])
    expect(executability.get(rootBin)).toBe(true)
    expect(executability.get(workspaceBin)).toBe(false)
    expect(executability.get(absent)).toBe(false)
    await chmod(fixtureResult.workspaceBin, 0o644)
    const cleared = await worktreeExecutability(fixtureResult.root, [workspaceBin])
    expect(cleared.get(workspaceBin)).toBe(false)
  })

  test('fails closed when a bin target escapes the repository root', async () => {
    const fixtureResult = await fixture()
    await writeFile(
      join(fixtureResult.root, 'packages', 'svc', 'package.json'),
      JSON.stringify({
        name: '@fixture/svc',
        version: '1.0.0',
        bin: { 'svc-cli': '../../../outside.ts' },
      }),
    )
    await expect(collectBinEntries(fixtureResult.root)).rejects.toThrow('escapes the repository')
  })

  test('reads index stages, including conflicted entries, from the fixture repository', async () => {
    const fixtureResult = await fixture()
    const target = relative(fixtureResult, fixtureResult.workspaceBin)
    const modes = await trackedModes(fixtureResult.root, [target])
    expect(modes.get(target)).toEqual(['100755'])
    expect(
      evaluateBinModes(
        [{ manifestPath: 'p', packageName: 'p', name: 'n', target }],
        modes,
        new Map([[target, true]]),
      ),
    ).toEqual([])
    expect(
      evaluateBinModes(
        [{ manifestPath: 'p', packageName: 'p', name: 'n', target }],
        new Map(),
        new Map(),
      ),
    ).toEqual([
      { kind: 'untracked', entry: { manifestPath: 'p', packageName: 'p', name: 'n', target } },
    ])
    expect(
      evaluateBinModes(
        [{ manifestPath: 'p', packageName: 'p', name: 'n', target }],
        new Map([[target, ['100644', '100755']]]),
        new Map(),
      ),
    ).toEqual([
      {
        kind: 'conflict',
        entry: { manifestPath: 'p', packageName: 'p', name: 'n', target },
        modes: ['100644', '100755'],
      },
    ])
    expect(
      evaluateBinModes(
        [{ manifestPath: 'p', packageName: 'p', name: 'n', target }],
        modes,
        new Map([[target, false]]),
      ),
    ).toEqual([
      {
        kind: 'worktree-mode',
        entry: { manifestPath: 'p', packageName: 'p', name: 'n', target },
        indexMode: '100755',
      },
    ])
  })

  test('fails closed when the workspace cannot be enumerated', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ab-bin-mode-empty-'))
    temporary.push(root)
    const { output, run } = capture()
    expect(await run(root)).toBe(1)
    expect(output.stdout).toEqual([])
    expect(output.stderr.join('')).toContain('Could not check bin entry modes')
  })
})
