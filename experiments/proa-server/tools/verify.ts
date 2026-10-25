import { createHash } from 'node:crypto'
import { realpathSync } from 'node:fs'
import { mkdir, mkdtemp } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'

export const project = resolve(import.meta.dir, '..')
export const root = resolve(project, '../..')
export async function run(
  args: string[],
  cwd = project,
  env = process.env,
  logPath?: string,
): Promise<void> {
  console.log(`> ${args.join(' ')}`)
  const child = Bun.spawn(args, {
    cwd,
    env,
    stdout: logPath ? 'pipe' : 'inherit',
    stderr: logPath ? 'pipe' : 'inherit',
  })
  const stop = () => child.kill()
  process.once('SIGTERM', stop)
  process.once('SIGINT', stop)
  const writer = logPath ? Bun.file(logPath).writer() : undefined
  const copy = async (
    stream: ReadableStream<Uint8Array> | undefined,
    output: { write(chunk: Uint8Array): unknown },
  ) => {
    if (!stream) return
    for await (const chunk of stream) {
      writer?.write(chunk)
      output.write(chunk)
    }
  }
  let code: number
  try {
    await Promise.all([
      copy(child.stdout ?? undefined, process.stdout),
      copy(child.stderr ?? undefined, process.stderr),
    ])
    code = await child.exited
  } finally {
    await writer?.end()
    process.removeListener('SIGTERM', stop)
    process.removeListener('SIGINT', stop)
  }
  if (code !== 0) throw new Error(`${args.join(' ')} exited ${code}`)
}
export function cachePath(
  common: string,
  base = process.env.XDG_CACHE_HOME || join(homedir(), '.cache'),
) {
  return join(
    base,
    'autobuild',
    createHash('sha256').update(common).digest('hex').slice(0, 20),
    'proa-server-rust-1.99.1-proa-0.1.3',
  )
}
export async function build(capture = false): Promise<string> {
  const common = Bun.spawnSync(['git', 'rev-parse', '--git-common-dir'], {
    cwd: root,
  })
  if (common.exitCode) throw new Error('Cannot resolve Git common directory')
  const requestedCache =
    process.env.PROA_VERIFY_CACHE ||
    cachePath(realpathSync(resolve(root, common.stdout.toString().trim())))
  if (!isAbsolute(requestedCache))
    throw new Error('PROA_VERIFY_CACHE must be absolute and outside worktrees')
  await mkdir(requestedCache, { recursive: true })
  const cache = realpathSync(requestedCache)
  const trees = Bun.spawnSync(['git', 'worktree', 'list', '--porcelain'], {
    cwd: root,
  }).stdout.toString()
  for (const match of trees.matchAll(/^worktree (.+)$/gm)) {
    if (cache === match[1] || cache.startsWith(`${match[1]}/`))
      throw new Error('Cargo cache must be outside every worktree')
  }
  for (const [command, version] of [
    ['rustc', '1.99.1'],
    ['proa', '0.1.3'],
  ]) {
    const result = Bun.spawnSync([command!, '--version'], { cwd: project })
    if (result.exitCode || !result.stdout.toString().includes(version!))
      throw new Error(`Install pinned ${command} ${version}; see experiment README`)
  }
  await mkdir(cache, { recursive: true })
  await mkdir(join(root, '.ab'), { recursive: true })
  const scratch = await mkdtemp(join(root, '.ab/proa-build-'))
  const executable = join(scratch, 'proa-server')
  // flock owns the lock through the entire child process; the OS releases it on death.
  const env = {
    ...process.env,
    // Development capture/corpus overrides must never replace gate evidence.
    PROA_PARITY_CORPUS: undefined,
    PROA_CAPTURE_FILE: undefined,
    CARGO_TARGET_DIR: cache,
    PATH: `${project}/node_modules/.bin:${process.env.PATH}`,
  }
  await run(
    ['bun', 'install', '--frozen-lockfile', ...(capture ? ['--offline'] : [])],
    project,
    env,
  )
  const commands = capture
    ? []
    : [
        ['bun', 'test', 'tools'],
        ['bun', join(root, 'node_modules/typescript/bin/tsc'), '--noEmit', '-p', 'tsconfig.json'],
        ['bun', 'tools/check-fixtures.ts'],
        ['bun', 'tools/operator-fixtures.ts'],
        ['bun', 'tools/request-fixtures.ts'],
        ['bun', 'tools/config-fixtures.ts'],
        ['bun', 'tools/api-read-fixtures.ts'],
        ['bun', 'tools/advanced-control-fixtures.ts'],
        ['bun', 'tools/registry-fixtures.ts'],
        ['bun', 'tools/control-fixtures.ts'],
        ['bun', 'tools/delegation-fixtures.ts'],
        ['bun', 'tools/query-fixtures.ts'],
        ['bun', 'tools/writer-fixtures.ts'],
        ['bun', 'tools/projection-fixtures.ts'],
        ['bun', 'tools/protocol-identity-check.ts'],
        ['bun', 'tools/check-protocol-fixtures.ts'],
        ['bun', 'tools/protocol-event-reads.ts'],
        ['bun', 'tools/protocol-write-preparation-fixtures.ts'],
        ['bun', 'tools/protocol-artifact-preparation-fixtures.ts'],
        ['bun', 'tools/protocol-tick-fixtures.ts'],
        ['bun', 'tools/protocol-blob-fixtures.ts'],
        ['bun', 'tools/protocol-json-number-fixtures.ts'],
        ['bun', 'tools/protocol-numeric-fixtures.ts'],
        ['bun', 'tools/protocol-asset-fixtures.ts'],
        ['bun', 'tools/protocol-stream-document-fixtures.ts'],
        ['bun', 'tools/protocol-reducer-fixtures.ts'],
        ['bun', 'tools/protocol-restack-fixtures.ts'],
        ['bun', 'tools/protocol-token-fixtures.ts'],
        ['bun', 'tools/protocol-delegation-fixtures.ts'],
        ['bun', 'tools/protocol-delegation-authority-fixtures.ts'],
        ['bun', 'tools/protocol-unicode-fixtures.ts'],
        ['bun', 'tools/protocol-token-unicode-fixtures.ts'],
        ['bun', 'tools/protocol-unicode-validation-fixtures.ts'],
        ['bun', 'tools/protocol-reducer-unicode-fixtures.ts'],
        ['bun', 'tools/protocol-persisted-unicode-fixtures.ts'],
        ['bun', 'tools/protocol-persisted-reducer-fixtures.ts'],
        ['bun', 'tools/protocol-read-json-fixtures.ts'],
        ['bun', 'tools/protocol-lease-dates-fixtures.ts'],
        ['proa', 'fmt', '--check', '--verify', 'src'],
        ['cargo', 'fmt', '--check'],
        ['proa', 'lint', 'src', '--deny', 'warnings'],
        ['cargo', 'clippy', '--locked', '--all-targets', '--', '-D', 'warnings'],
        ['cargo', 'test', '--locked'],
        ['proa', 'test', '--locked'],
        ['bun', 'tools/data-integration.ts'],
        ['bun', 'tools/data-dashboard-integration.ts'],
        ['bun', 'tools/operator-integration.ts'],
        [
          'bun',
          'tools/operator-coverage.ts',
          '--evidence',
          join(root, '.ab/proa-operator-evidence/coverage.json'),
        ],
        ['bun', 'tools/dispatcher-integration.ts'],
        ['bun', 'tools/protocol-contract.ts', '--caller-holds-lock'],
        ['bun', 'tools/protocol-integration.ts', '--caller-holds-lock'],
      ]
  commands.push([
    'proa',
    'build',
    '--locked',
    ...(capture ? ['--offline'] : []),
    '--artifact-out',
    executable,
  ])
  // One flock process runs all commands, preserving failure propagation without shell interpolation.
  const script = join(scratch, 'commands.json')
  await Bun.write(script, JSON.stringify(commands))
  await run(
    ['flock', join(cache, '.verify.lock'), 'bun', import.meta.filename, '--execute', script],
    project,
    env,
  )
  return executable
}
if (import.meta.main) {
  if (process.argv[2] === '--execute') {
    const script = process.argv[3]!
    const timings = []
    let index = 0
    for (const command of await Bun.file(script).json()) {
      const started = performance.now()
      await run(command, project, process.env, join(dirname(script), `step-${index++}.log`))
      timings.push({ command, seconds: (performance.now() - started) / 1000 })
      await Bun.write(join(dirname(script), 'timings.json'), JSON.stringify(timings, null, 2))
    }
  } else console.log(await build(process.argv.includes('--capture-build')))
}
