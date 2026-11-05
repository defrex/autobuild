/**
 * Stage a self-contained Git into the hosted dispatcher's `/api/dispatch`
 * function bundle.
 *
 * Origin-mode node work (snapshot, restack, presence, landing) runs `git` on a
 * bare clone, and the Vercel Function runtime has no `git`. This step runs in
 * the deployment's build (a `linux-x64` host with Git, as Vercel's build image
 * is) and copies that Git into `<project>/.autobuild-git/`:
 *
 * - `bin/git`, and `libexec/git-core/` with every non-builtin helper (the
 *   HTTPS remote helpers among them) plus plain copies of the git binary for
 *   the names Git re-executes (`git`, `git-upload-pack`, `git-receive-pack`,
 *   `git-upload-archive`);
 * - `lib/`: the complete shared-library closure, glibc included, and `ld`, the
 *   build host's dynamic loader;
 * - `ssl/ca-bundle.crt`, optional `share/git-core/templates/`, and
 *   `manifest.json` (see `ShippedGitManifest`).
 *
 * Nothing in the tree depends on the runtime's own libraries: every staged
 * executable's program interpreter is rewritten in place to `<root>/ld`, a
 * fixed `/tmp` path derived from the tree's content that the runtime copies the
 * tree to (`shipped-git.ts`). The build then proves it: a static ELF check of
 * every staged object, and a run of the copied tree with an empty `PATH` that
 * clones over HTTP on loopback with `LD_DEBUG=libs`, failing on any program or
 * library loaded from outside the tree. Every staged file is appended to the
 * dispatch route's `route.js.nft.json`, like the distribution archive.
 */
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { ElfError, isElf, readElf, rewriteInterpreter } from './elf'
import { dispatchTracePath, readTrace } from './ship-packed-distribution'
import {
  materializeShippedGit,
  SHIPPED_GIT_DIRECTORY,
  SHIPPED_GIT_PLATFORM,
  shippedGitEnv,
  type ShippedGitManifest,
} from './shipped-git'

export interface HostExecResult {
  stdout: string
  stderr: string
  exitCode: number
}

/** The build host, injectable for tests. */
export interface StageGitHost {
  platform: string
  arch: string
  which(name: string): string | null
  /** Run a command; `env` replaces the environment entirely when given. */
  exec(
    cmd: string[],
    opts?: { cwd?: string; env?: Record<string, string> },
  ): Promise<HostExecResult>
  /** CA bundle locations, first existing wins. */
  caCandidates: string[]
  templateCandidates: string[]
  /** Prefix of the runtime root; the content hash's first 8 hex follow it. */
  materializeBase: string
  /** The dynamic proof; defaults to `proveShippedGit`. */
  prove?: (directory: string, manifest: ShippedGitManifest) => Promise<{ programs: string[] }>
}

async function hostExec(
  cmd: string[],
  opts: { cwd?: string; env?: Record<string, string> } = {},
): Promise<HostExecResult> {
  const proc = Bun.spawn(cmd, {
    ...(opts.cwd !== undefined ? { cwd: opts.cwd } : {}),
    env: opts.env ?? (process.env as Record<string, string>),
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  return { stdout, stderr, exitCode }
}

export function defaultStageGitHost(
  env: Record<string, string | undefined> = process.env,
): StageGitHost {
  return {
    platform: process.platform,
    arch: process.arch,
    which: (name) => Bun.which(name),
    exec: hostExec,
    caCandidates: [
      ...(env.SSL_CERT_FILE ? [env.SSL_CERT_FILE] : []),
      '/etc/pki/tls/certs/ca-bundle.crt',
      '/etc/ssl/certs/ca-certificates.crt',
      '/etc/ssl/cert.pem',
    ],
    templateCandidates: ['/usr/share/git-core/templates'],
    materializeBase: '/tmp/abg',
  }
}

/** Library names glibc `dlopen`s for name resolution without `ldd` listing
 * them; staged when they sit beside the host's `libc.so.6`. */
const NSS_LIBRARIES = ['libnss_files.so.2', 'libnss_dns.so.2', 'libresolv.so.2']
/** Names Git executes as the git binary itself. */
const GIT_COPIES = ['git', 'git-upload-pack', 'git-receive-pack', 'git-upload-archive']
/** glibc ≥ 2.26 supports Linux 3.2 and newer on x86_64. */
const GLIBC_KERNEL_FLOOR = '3.2.0'

export class StageGitError extends Error {}

function fail(message: string): never {
  throw new StageGitError(`cannot stage Git for the hosted dispatcher: ${message}`)
}

async function sha256File(path: string): Promise<string> {
  return createHash('sha256')
    .update(await readFile(path))
    .digest('hex')
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

async function filesUnder(directory: string): Promise<string[]> {
  const out: string[] = []
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    const info = await stat(path)
    if (info.isDirectory()) out.push(...(await filesUnder(path)))
    else if (info.isFile()) out.push(path)
  }
  return out
}

export interface LddEntry {
  soname: string
  path: string
}

/** Parse `ldd` output: the resolved libraries, the loader, and anything
 * `not found`. The vDSO is skipped. */
export function parseLdd(output: string): {
  libraries: LddEntry[]
  loader?: string
  missing: string[]
} {
  const libraries: LddEntry[] = []
  const missing: string[] = []
  let loader: string | undefined
  for (const raw of output.split('\n')) {
    const line = raw.trim()
    if (line === '' || line.startsWith('linux-vdso') || line.startsWith('linux-gate')) continue
    const arrow = /^(\S+)\s+=>\s+(.*)$/.exec(line)
    if (arrow) {
      const [, soname, rest] = arrow
      if (/^not found/.test(rest!)) missing.push(soname!)
      else {
        const path = /^(\/\S+)/.exec(rest!)?.[1]
        if (path) libraries.push({ soname: soname!, path })
      }
      continue
    }
    const direct = /^(\/\S+)\s+\(0x[0-9a-f]+\)$/.exec(line)
    if (direct && /\/ld-linux[^/]*\.so/.test(direct[1]!)) loader = direct[1]
  }
  return { libraries, ...(loader !== undefined ? { loader } : {}), missing }
}

/** Parse glibc `LD_DEBUG=libs` traces: every program initialized and every
 * object tried or initialized, and those outside `root`. */
export function parseLdDebug(
  text: string,
  root: string,
): { programs: string[]; objects: string[]; foreign: string[] } {
  const programs: string[] = []
  const objects: string[] = []
  for (const line of text.split('\n')) {
    const program = /initialize program: (\S+)/.exec(line)?.[1]
    if (program !== undefined) programs.push(program)
    const object = /(?:calling init|trying file)[:=]\s*(\S+)/.exec(line)?.[1]
    if (object !== undefined) objects.push(object)
  }
  const inside = (path: string) => !isAbsolute(path) || path.startsWith(`${root}/`)
  const foreign = [...new Set([...programs, ...objects].filter((path) => !inside(path)))]
  return { programs, objects, foreign }
}

export interface StagedGit {
  directory: string
  manifest: ShippedGitManifest
  /** Bytes of the staged tree. */
  bytes: number
  trace: string
  /** Total bytes of the dispatch trace's distinct files after the append. */
  traceBytes: number
  appended: number
}

interface PlannedFile {
  relative: string
  source: string
  executable: boolean
}

/** Stage, validate and prove the shipped Git, then append it to the dispatch
 * route's trace. Every failure names the missing or incompatible piece. */
export async function stageGitForDeployment({
  root,
  distDir = '.next',
  host = defaultStageGitHost(),
  log = (message) => console.log(message),
}: {
  root: string
  distDir?: string
  host?: StageGitHost
  log?: (message: string) => void
}): Promise<StagedGit> {
  const platform = `${host.platform}-${host.arch}`
  if (platform !== SHIPPED_GIT_PLATFORM)
    fail(
      `this build host is ${platform}, but the /api/dispatch function runs on ` +
        `${SHIPPED_GIT_PLATFORM} — run ship-deployment on a ${SHIPPED_GIT_PLATFORM} host ` +
        '(Vercel builds stage it automatically)',
    )
  const git = host.which('git')
  if (!git) fail('no `git` on the build host PATH')
  const ldd = host.which('ldd')
  if (!ldd) fail('no `ldd` on the build host PATH (it lists the libraries Git needs)')
  const run = async (cmd: string[]) => {
    const result = await host.exec(cmd)
    if (result.exitCode !== 0)
      fail(`\`${cmd.join(' ')}\` exited ${result.exitCode}: ${result.stderr.trim()}`)
    return result.stdout.trim()
  }
  const gitVersion = (await run([git, '--version'])).replace(/^git version\s+/, '')
  const execPath = await run([git, '--exec-path'])
  const glibcVersion =
    /(\d+\.\d+(?:\.\d+)?)\s*$/.exec((await run([ldd, '--version'])).split('\n')[0] ?? '')?.[1] ??
    'unknown'

  // ── Plan the tree ─────────────────────────────────────────────────────────
  const gitBinary = await realpath(git)
  const gitInfo = await stat(gitBinary)
  const gitHash = await sha256File(gitBinary)
  const builtins = new Set([`${gitInfo.dev}:${gitInfo.ino}`])
  try {
    const dashed = await stat(join(execPath, 'git'))
    builtins.add(`${dashed.dev}:${dashed.ino}`)
  } catch {
    // Some layouts keep the git binary only on PATH.
  }
  const planned: PlannedFile[] = [{ relative: 'bin/git', source: gitBinary, executable: true }]
  const helpers = new Set<string>()
  for (const name of (await readdir(execPath)).sort()) {
    if (GIT_COPIES.includes(name)) continue
    const path = join(execPath, name)
    let info: Awaited<ReturnType<typeof stat>>
    try {
      info = await stat(path)
    } catch {
      continue
    }
    if (!info.isFile()) continue
    // A builtin is the git binary under another name: a link, or a copy.
    if (builtins.has(`${info.dev}:${info.ino}`)) continue
    if (info.size === gitInfo.size && (await sha256File(path)) === gitHash) continue
    planned.push({ relative: `libexec/git-core/${name}`, source: path, executable: true })
    helpers.add(name)
  }
  if (!helpers.has('git-remote-https'))
    fail(`no git-remote-https in ${execPath} — install Git's HTTPS transport on the build host`)
  for (const name of GIT_COPIES)
    planned.push({ relative: `libexec/git-core/${name}`, source: gitBinary, executable: true })

  // Shared-library closure of every ELF executable, glibc and loader included.
  const libraries = new Map<string, string>()
  let loader: string | undefined
  for (const file of planned) {
    const bytes = new Uint8Array(await readFile(file.source))
    if (!isElf(bytes)) continue
    const result = await host.exec([ldd, file.source])
    const parsed = parseLdd(result.stdout)
    if (parsed.missing.length > 0)
      fail(`ldd reports ${parsed.missing.join(', ')} not found for ${file.source}`)
    for (const entry of parsed.libraries)
      if (!libraries.has(entry.soname)) libraries.set(entry.soname, entry.path)
    loader ??= parsed.loader
  }
  if (!loader) fail('ldd reported no dynamic loader for git')
  const libc = libraries.get('libc.so.6')
  if (libc) {
    const libcDirectory = dirname(await realpath(libc))
    for (const name of NSS_LIBRARIES) {
      const candidate = join(libcDirectory, name)
      if (!libraries.has(name) && (await exists(candidate))) libraries.set(name, candidate)
    }
  }
  for (const [soname, path] of [...libraries].sort(([a], [b]) => a.localeCompare(b)))
    planned.push({ relative: `lib/${soname}`, source: await realpath(path), executable: false })
  planned.push({ relative: 'ld', source: await realpath(loader), executable: true })

  let caBundle: string | undefined
  for (const candidate of host.caCandidates)
    if (await exists(candidate)) {
      caBundle = candidate
      break
    }
  if (!caBundle) fail(`no CA bundle found (looked in ${host.caCandidates.join(', ')})`)
  planned.push({
    relative: 'ssl/ca-bundle.crt',
    source: await realpath(caBundle),
    executable: false,
  })
  let templates: string | undefined
  for (const candidate of host.templateCandidates) {
    if (!(await exists(candidate))) continue
    templates = 'share/git-core/templates'
    for (const file of await filesUnder(candidate))
      planned.push({
        relative: `${templates}/${relative(candidate, file).split(sep).join('/')}`,
        source: await realpath(file),
        executable: false,
      })
    break
  }

  // ── Fixed runtime root from the tree's content ────────────────────────────
  const digest = createHash('sha256')
  for (const file of [...planned].sort((a, b) => a.relative.localeCompare(b.relative)))
    digest.update(`${file.relative}\0${await sha256File(file.source)}\n`)
  const runtimeRoot = `${host.materializeBase}${digest.digest('hex').slice(0, 8)}`
  const interpreter = `${runtimeRoot}/ld`

  // ── Write it, rewriting every program interpreter ─────────────────────────
  const directory = join(root, SHIPPED_GIT_DIRECTORY)
  await rm(directory, { recursive: true, force: true })
  let bytes = 0
  for (const file of planned) {
    const content = new Uint8Array(await readFile(file.source))
    if (isElf(content)) {
      try {
        rewriteInterpreter(content, interpreter)
      } catch (error) {
        if (error instanceof ElfError)
          fail(`${file.relative} (from ${file.source}): ${error.message}`)
        throw error
      }
    }
    const target = join(directory, file.relative)
    await mkdir(dirname(target), { recursive: true })
    await writeFile(target, content, { mode: file.executable ? 0o755 : 0o644 })
    bytes += content.length
  }
  const staticCheck = await validateStagedTree(directory, interpreter, basename(loader))
  const manifest: ShippedGitManifest = {
    schema: 1,
    platform: SHIPPED_GIT_PLATFORM,
    gitVersion,
    glibcVersion,
    minimumKernel: staticCheck.minimumKernel ?? GLIBC_KERNEL_FLOOR,
    root: runtimeRoot,
    git: 'bin/git',
    execPath: 'libexec/git-core',
    lib: 'lib',
    caBundle: 'ssl/ca-bundle.crt',
    ...(templates !== undefined ? { templates } : {}),
    files: planned.map((file) => file.relative),
    executables: planned.filter((file) => file.executable).map((file) => file.relative),
    bytes,
  }
  const rawManifest = `${JSON.stringify(manifest, null, 2)}\n`
  await writeFile(join(directory, 'manifest.json'), rawManifest)
  bytes += Buffer.byteLength(rawManifest)

  const proof = await (host.prove ?? ((dir, m) => proveShippedGit(dir, m, host)))(
    directory,
    manifest,
  )
  log(
    `shipped Git proof: ${proof.programs.map((program) => relative(runtimeRoot, program)).join(', ')} ` +
      `ran from ${runtimeRoot} with nothing loaded from the build host`,
  )

  // ── Carry it into the dispatch function ───────────────────────────────────
  const trace = dispatchTracePath(root, distDir)
  const files = await readTrace(trace)
  const entries = [...manifest.files, 'manifest.json'].map((file) =>
    relative(dirname(trace), join(directory, file)),
  )
  const added = entries.filter((entry) => !files.includes(entry))
  if (added.length > 0) {
    const parsed = JSON.parse(await readFile(trace, 'utf8'))
    await writeFile(
      trace,
      `${JSON.stringify({ ...parsed, files: [...files, ...added] }, null, 2)}\n`,
    )
  }
  let traceBytes = 0
  for (const entry of new Set([...files, ...added].map((file) => resolve(dirname(trace), file)))) {
    try {
      const info = await stat(entry)
      if (info.isFile()) traceBytes += info.size
    } catch {
      // Next may list optional files it did not emit.
    }
  }
  const megabytes = (value: number) => (value / 1024 / 1024).toFixed(1)
  log(
    `git ${gitVersion} (glibc ${glibcVersion}) for ${SHIPPED_GIT_PLATFORM} staged at ${directory}: ` +
      `${entries.length} files, ${megabytes(bytes)} MB added to ${trace}`,
  )
  log(`dispatch function trace now totals ${megabytes(traceBytes)} MB`)
  return { directory, manifest, bytes, trace, traceBytes, appended: added.length }
}

/** The static half of the target-compatibility gate: every staged ELF is
 * x86_64 ELF64, names `interpreter` as its loader if it names one, finds
 * every needed library in `lib/`, and searches no absolute path outside the
 * tree. Returns the bundled glibc's kernel floor from its ABI note. */
export async function validateStagedTree(
  directory: string,
  interpreter: string,
  loaderSoname: string,
): Promise<{ minimumKernel?: string }> {
  const libraries = new Set(await readdir(join(directory, 'lib')))
  const runtimeRoot = dirname(interpreter)
  let minimumKernel: string | undefined
  for (const path of await filesUnder(directory)) {
    const name = relative(directory, path).split(sep).join('/')
    const bytes = new Uint8Array(await readFile(path))
    if (!isElf(bytes)) continue
    let info: ReturnType<typeof readElf>
    try {
      info = readElf(bytes)
    } catch (error) {
      fail(`${name}: ${error instanceof Error ? error.message : String(error)}`)
    }
    if (info.interpreter !== undefined && info.interpreter.path !== interpreter)
      fail(`${name} still names the program loader ${info.interpreter.path}, not ${interpreter}`)
    for (const needed of info.needed)
      if (!libraries.has(needed) && needed !== loaderSoname)
        fail(`${name} needs ${needed}, which is not in lib/`)
    for (const entry of [...info.rpath, ...info.runpath])
      if (isAbsolute(entry) && !entry.startsWith(`${runtimeRoot}/`))
        fail(`${name} searches ${entry} outside the shipped tree`)
    if (name === 'lib/libc.so.6' && info.abiTag?.os === 0) minimumKernel = info.abiTag.kernel
  }
  return minimumKernel !== undefined ? { minimumKernel } : {}
}

/** The dynamic half: copy the tree to its runtime root exactly as the function
 * does, then with an empty `PATH` and `LD_DEBUG=libs` run Git end to end —
 * `--version`, a bare repository built from builtins, and a dumb-HTTP clone of
 * it from an in-process loopback server through the shipped `git-remote-http`.
 * Fails on any program or library loaded from outside the tree. */
export async function proveShippedGit(
  directory: string,
  manifest: ShippedGitManifest,
  host: Pick<StageGitHost, 'exec'>,
): Promise<{ programs: string[] }> {
  const raw = await readFile(join(directory, 'manifest.json'), 'utf8')
  const root = manifest.root
  const scratch = await mkdtemp(join(tmpdir(), 'ab-git-proof-'))
  let server: ReturnType<typeof Bun.serve> | undefined
  try {
    await materializeShippedGit(directory, manifest, raw)
    await mkdir(join(scratch, 'ld'))
    const env: Record<string, string> = {
      ...shippedGitEnv({ root, manifest }),
      PATH: '/nonexistent',
      GIT_ALLOW_PROTOCOL: 'http:https',
      HOME: scratch,
      LD_DEBUG: 'libs',
      LD_DEBUG_OUTPUT: join(scratch, 'ld', 'trace'),
    }
    const gitPath = join(root, manifest.git)
    const git = async (args: string[], expectSuccess = true) => {
      const result = await host.exec([gitPath, ...args], { cwd: scratch, env })
      if (expectSuccess && result.exitCode !== 0)
        fail(
          `the shipped Git failed \`git ${args.join(' ')}\` (exit ${result.exitCode}): ${result.stderr.trim()}`,
        )
      return result
    }
    await git(['--version'])
    const source = join(scratch, 'src.git')
    await git(['init', '--bare', '--quiet', source])
    const tree = (await git(['-C', source, 'mktree'])).stdout.trim()
    const commit = (
      await git([
        '-C',
        source,
        '-c',
        'user.name=ab',
        '-c',
        'user.email=ab@invalid',
        'commit-tree',
        tree,
        '-m',
        'shipped Git proof',
      ])
    ).stdout.trim()
    await git(['-C', source, 'update-ref', 'refs/heads/main', commit])
    await git(['-C', source, 'symbolic-ref', 'HEAD', 'refs/heads/main'])
    await git(['-C', source, 'update-server-info'])
    server = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      async fetch(request) {
        const path = resolve(scratch, `.${decodeURIComponent(new URL(request.url).pathname)}`)
        if (!path.startsWith(`${scratch}/`)) return new Response('not found', { status: 404 })
        const file = Bun.file(path)
        return (await file.exists())
          ? new Response(file)
          : new Response('not found', { status: 404 })
      },
    })
    const clone = join(scratch, 'out.git')
    await git(['clone', '--bare', '--quiet', `http://127.0.0.1:${server.port}/src.git`, clone])
    const cloned = (await git(['-C', clone, 'rev-parse', 'refs/heads/main'])).stdout.trim()
    if (cloned !== commit)
      fail(`the shipped Git's loopback clone resolved main to ${cloned}, not ${commit}`)
    const helper = await host.exec([join(root, manifest.execPath, 'git-remote-https')], {
      cwd: scratch,
      env,
    })
    if (
      helper.exitCode === 126 ||
      helper.exitCode === 127 ||
      helper.stderr.includes('error while loading shared libraries')
    )
      fail(
        `the shipped git-remote-https cannot run (exit ${helper.exitCode}): ${helper.stderr.trim()}`,
      )
    let traces = ''
    for (const name of await readdir(join(scratch, 'ld')))
      traces += await readFile(join(scratch, 'ld', name), 'utf8')
    const parsed = parseLdDebug(traces, root)
    if (parsed.programs.length === 0) fail('LD_DEBUG recorded no programs for the shipped Git')
    if (parsed.foreign.length > 0)
      fail(`the shipped Git loaded from outside ${root}: ${parsed.foreign.join(', ')}`)
    return { programs: [...new Set(parsed.programs)] }
  } finally {
    await server?.stop(true)
    await rm(scratch, { recursive: true, force: true })
    await rm(root, { recursive: true, force: true })
  }
}
