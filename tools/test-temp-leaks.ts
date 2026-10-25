import { mkdtemp, readdir, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { isAbsolute, join, relative, resolve } from 'node:path'

export const checkoutRoot = resolve(import.meta.dir, '..')

function contains(parent: string, path: string): boolean {
  const rel = relative(parent, path)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

/** Probe only external paths: temporary cwd must not discover checkout config. */
export async function inspectionRoot(root = checkoutRoot): Promise<string> {
  const checkout = await realpath(root)
  for (const candidate of [...new Set([tmpdir(), '/tmp', '/var/tmp'])]) {
    let parent: string
    try {
      parent = await realpath(candidate)
    } catch {
      continue
    }
    if (contains(checkout, parent)) continue
    const probe = Bun.spawnSync(['git', 'rev-parse', '--show-toplevel'], {
      cwd: parent,
      stdout: 'pipe',
      stderr: 'pipe',
    })
    if (probe.exitCode === 0) continue
    const scratch = await mkdtemp(join(parent, 'ab-test-inspection-'))
    const check = Bun.spawnSync(['git', 'rev-parse', '--show-toplevel'], {
      cwd: scratch,
      stdout: 'pipe',
      stderr: 'pipe',
    })
    if (check.exitCode !== 0) return scratch
    await rm(scratch, { recursive: true, force: true })
  }
  throw new Error('No external OS temporary directory outside a Git worktree is available')
}

export async function runInspected(
  commands: readonly (readonly string[])[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv; report?: (message: string) => void } = {},
): Promise<number> {
  const scratch = await inspectionRoot()
  const report = options.report ?? console.error
  try {
    for (const command of commands) {
      const before = new Set(await readdir(scratch))
      const child = Bun.spawn([...command], {
        cwd: options.cwd ?? checkoutRoot,
        env: { ...process.env, ...options.env, TMPDIR: scratch, TMP: scratch, TEMP: scratch },
        stdin: 'inherit',
        stdout: 'inherit',
        stderr: 'inherit',
      })
      const interrupt = () => child.kill('SIGINT')
      const terminate = () => child.kill('SIGTERM')
      process.on('SIGINT', interrupt)
      process.on('SIGTERM', terminate)
      let code: number
      try {
        code = await child.exited
      } finally {
        process.off('SIGINT', interrupt)
        process.off('SIGTERM', terminate)
      }
      const leaked = (await readdir(scratch, { withFileTypes: true }))
        .filter((entry) => entry.isDirectory() && !before.has(entry.name))
        .map((entry) => entry.name)
      if (leaked.length)
        report(`Temporary directory leaks after ${command.join(' ')}: ${leaked.join(', ')}`)
      if (code !== 0) return code
      if (leaked.length) return 1
    }
    return 0
  } finally {
    await rm(scratch, { recursive: true, force: true })
  }
}

export async function suiteCommands(mode: string, args: string[]): Promise<string[][]> {
  if (mode === 'unit')
    return [
      [
        process.execPath,
        'test',
        '--path-ignore-patterns=**/*.integration.test.ts',
        ...Array.from(
          new Bun.Glob('packages/*/src').scanSync({ cwd: checkoutRoot, onlyFiles: false }),
        ).sort(),
        'tools',
        'bin',
        'packages/hosted-store-service/app',
        ...args,
      ],
    ]
  if (mode === 'integration') {
    const files = Array.from(
      new Bun.Glob('packages/**/*.integration.test.ts').scanSync({ cwd: checkoutRoot }),
    )
      .filter((path) => !path.includes('/node_modules/'))
      .sort()
    return [
      [process.execPath, 'test', ...files, ...args],
      [process.execPath, 'tools/hosted-service-packaging.ts'],
    ]
  }
  throw new Error('Expected test-temp-leaks mode: unit or integration')
}

if (import.meta.main) {
  process.exitCode = await runInspected(
    await suiteCommands(process.argv[2] ?? '', process.argv.slice(3)),
  )
}
