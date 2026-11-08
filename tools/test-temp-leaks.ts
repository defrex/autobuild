import { mkdtemp, readdir, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { createFailureCollector, formatFailureDigest } from './test-failure-digest'

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

/** Forward a child stream unchanged, feeding each decoded chunk to `observe`. */
async function forward(
  stream: ReadableStream<Uint8Array>,
  sink: NodeJS.WriteStream,
  observe?: (text: string) => void,
): Promise<void> {
  const decoder = new TextDecoder()
  for await (const chunk of stream) {
    sink.write(chunk)
    observe?.(decoder.decode(chunk, { stream: true }))
  }
  observe?.(decoder.decode())
}

/**
 * Run each command with an isolated external temporary root, reporting leaks
 * it leaves behind. Child output is piped and forwarded unchanged; stderr also
 * feeds a failure collector, because the kernel stores only the last 10,000
 * characters of a verify step's output. When a command fails, a bounded
 * failure digest (each failing test's message, diff and stack) is reported as
 * the runner's final write, so the stored report keeps every failure's detail.
 */
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
        stdout: 'pipe',
        stderr: 'pipe',
      })
      const collector = createFailureCollector()
      const interrupt = () => child.kill('SIGINT')
      const terminate = () => child.kill('SIGTERM')
      process.on('SIGINT', interrupt)
      process.on('SIGTERM', terminate)
      let code: number
      try {
        ;[code] = await Promise.all([
          child.exited,
          forward(child.stdout, process.stdout),
          forward(child.stderr, process.stderr, (text) => collector.push(text)),
        ])
      } finally {
        process.off('SIGINT', interrupt)
        process.off('SIGTERM', terminate)
      }
      const leaked = (await readdir(scratch)).filter((name) => !before.has(name))
      if (leaked.length)
        report(`Temporary entry leaks after ${command.join(' ')}: ${leaked.join(', ')}`)
      if (code !== 0) {
        report(
          formatFailureDigest(collector.failures(), { omitted: collector.omitted() }) ||
            `=== failure digest: no (fail) lines parsed from ${command.slice(0, 2).join(' ')} (exit ${code}); if bun tests failed, its reporter format may have changed ===`,
        )
        return code
      }
      if (leaked.length) return 1
    }
    return 0
  } finally {
    await rm(scratch, { recursive: true, force: true })
  }
}

export const UNIT_IO_GUARD_PRELOAD = './tools/unit-io-guard.ts'

export async function suiteCommands(
  mode: string,
  args: string[],
  options: { env?: Record<string, string | undefined>; report?: (message: string) => void } = {},
): Promise<string[][]> {
  if (mode === 'unit')
    return [
      [
        process.execPath,
        'test',
        `--preload=${UNIT_IO_GUARD_PRELOAD}`,
        '--path-ignore-patterns=**/*.integration.test.*',
        ...Array.from(
          new Bun.Glob('packages/*/src').scanSync({ cwd: checkoutRoot, onlyFiles: false }),
        ).sort(),
        'tools',
        'scripts',
        'bin',
        'packages/hosted-store-service/app',
        ...args,
      ],
    ]
  if (mode === 'integration') {
    const files = [
      ...new Set(
        ['packages', 'tools', 'scripts', 'bin'].flatMap((dir) =>
          Array.from(
            new Bun.Glob(`${dir}/**/*.integration.test.{ts,tsx}`).scanSync({ cwd: checkoutRoot }),
          ),
        ),
      ),
    ]
      .filter((path) => !path.includes('/node_modules/'))
      .sort()
    const commands = [[process.execPath, 'test', ...files, ...args]]
    if ((options.env ?? process.env).AB_POSTGRES_TEST_URL)
      commands.push([process.execPath, 'tools/hosted-service-packaging.ts'])
    else
      (options.report ?? console.error)(
        'skipping hosted-service deploy rehearsal: AB_POSTGRES_TEST_URL is unset',
      )
    return commands
  }
  throw new Error('Expected test-temp-leaks mode: unit or integration')
}

if (import.meta.main) {
  process.exitCode = await runInspected(
    await suiteCommands(process.argv[2] ?? '', process.argv.slice(3)),
  )
}
