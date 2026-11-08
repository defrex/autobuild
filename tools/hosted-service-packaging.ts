import assert from 'node:assert/strict'
import { valid, prerelease, lt, minVersion } from 'semver'
import { createHash } from 'node:crypto'
import {
  cp,
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join, resolve } from 'node:path'
import { SQL } from 'bun'
import { installPackedDistribution } from '../packages/core/src/testing/packed-install'
import {
  SCHEMA_VERSION,
  SCHEMA_V9_CHECKSUM,
  TICKET_SCHEMA_VERSION,
  TICKET_SCHEMA_V1_DDL,
  TICKET_SCHEMA_V1_CHECKSUM,
  migratePostgres,
} from '../packages/postgres-store/src/schema'
import { openPostgresBuildStore } from '../packages/postgres-store/src/store'
import { MemoryBlobStore } from '../packages/core/src/plugin-sdk'
import { parseConfig } from '../packages/core/src/config/load'
import { DISPATCHER } from '../packages/core/src/testing'
import { AUTH_SCHEMA_VERSION } from '../packages/postgres-store/src/auth-schema'
import { repoRoot } from './git-tracked'
import { spawnExec } from '../packages/core/src/ports/workspace/git-worktree'
import { parseLdDebug } from '../packages/hosted-dispatcher/src/ship-git'
import {
  locateShippedGit,
  shippedGitExec,
  type ShippedGitManifest,
} from '../packages/hosted-dispatcher/src/shipped-git'

export const deploymentTemplatePaths = [
  'templates/hosted-service',
  'packages/hosted-store-service/deployment',
]
export async function checkDeploymentTemplates(root = repoRoot) {
  for (const file of ['package.json', 'vercel.json']) {
    const text = await readFile(join(root, deploymentTemplatePaths[0]!, file), 'utf8')
    assert.equal(text, await readFile(join(root, deploymentTemplatePaths[1]!, file), 'utf8'))
  }
  const manifest = JSON.parse(
    await readFile(join(root, deploymentTemplatePaths[0]!, 'package.json'), 'utf8'),
  )
  const version = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')).version
  assert(
    typeof version === 'string' && valid(version) === version,
    'Root version must be exact semver',
  )
  const pin = manifest.dependencies?.['@defrex/autobuild']
  assert(typeof pin === 'string' && valid(pin) === pin, 'Deployment pin must be exact semver')
  assert.equal(
    pin,
    manifest.dependencies?.['@defrex/autobuild-hosted-store-service'],
    'Deployment pins must match',
  )
  if (prerelease(version) === null) {
    assert.equal(pin, version, 'Stable deployment pin must equal root version')
  } else {
    assert(
      prerelease(pin) === null && lt(pin, version),
      'Prerelease root requires a lower stable deployment pin',
    )
  }
}

async function command(
  args: string[],
  cwd: string,
  env: Record<string, string | undefined>,
  success = true,
) {
  const child = Bun.spawn(args, { cwd, env, stdout: 'pipe', stderr: 'pipe' })
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  if (success && code !== 0)
    throw new Error(`${args.join(' ')} failed (${code})\n${stdout}\n${stderr}`)
  if (!success) assert.notEqual(code, 0, 'Expected command to fail')
  return stdout + stderr
}
async function paths(root: string): Promise<string[]> {
  const result: string[] = []
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name)
    result.push(path)
    if (entry.isDirectory()) result.push(...(await paths(path)))
  }
  return result
}

/** A local Build Output API build: project settings are fixtures, no account
 * connection or deployment occurs. Vercel validates vercel.json itself. */
async function vercelBuild(
  cwd: string,
  env: Record<string, string | undefined>,
  settings: Record<string, string> = {},
) {
  await mkdir(join(cwd, '.vercel'), { recursive: true })
  await writeFile(
    join(cwd, '.vercel/project.json'),
    JSON.stringify({
      projectId: 'prj_packaging',
      orgId: 'team_packaging',
      projectName: 'packaging-check',
      settings: {
        framework: 'nextjs',
        buildCommand: 'bun run build',
        installCommand: 'bun install --frozen-lockfile',
        nodeVersion: '22.x',
        ...settings,
      },
    }),
  )
  const vercel = join(repoRoot, 'packages/hosted-store-service/node_modules/vercel/dist/index.js')
  await command(['bun', vercel, 'build', '--yes'], cwd, {
    ...env,
    VERCEL_TELEMETRY_DISABLED: '1',
    VERCEL_TOKEN: undefined,
  })
}

const sha256 = async (path: string) =>
  createHash('sha256')
    .update(await readFile(path))
    .digest('hex')

const STAGED_PLUGIN = 'node_modules/@defrex/autobuild-vercel-sandbox'

/** The dispatch trace entries this build ships: the archive, the distribution
 * manifest, the staged plugin and the shipped Git, resolved to absolute paths. */
async function shippedTraceEntries(project: string): Promise<string[]> {
  const trace = join(project, '.next/server/app/api/dispatch/route.js.nft.json')
  const files = JSON.parse(await readFile(trace, 'utf8')).files as string[]
  return files
    .map((entry) => resolve(dirname(trace), entry))
    .filter(
      (path) =>
        path.includes('/.autobuild-dist/') ||
        path.includes('/.autobuild-git/') ||
        path.endsWith('/@defrex/autobuild/package.json') ||
        path.includes(`/@defrex/autobuild/${STAGED_PLUGIN}/`),
    )
    .sort()
}

/** Copy the dispatch function out of the Build Output, resolving the local
 * build's `filePathMap` against `base`, into a standalone directory: exactly
 * the files the deployed function would hold. */
async function materializeDispatchFunction(base: string, into: string): Promise<string[]> {
  const func = join(base, '.vercel/output/functions/api/dispatch.func')
  await cp(func, into, { recursive: true })
  const config = JSON.parse(await readFile(join(func, '.vc-config.json'), 'utf8')) as {
    filePathMap?: Record<string, string>
  }
  for (const [target, source] of Object.entries(config.filePathMap ?? {})) {
    await mkdir(dirname(join(into, target)), { recursive: true })
    // Next links external packages under .next/node_modules; keep links.
    await cp(resolve(base, source), join(into, target), { recursive: true, verbatimSymlinks: true })
  }
  return (await paths(into)).map((path) => path.slice(into.length + 1))
}

/** Assert the shipped dispatch function carries the guest archive, the
 * distribution manifest and a runtime-resolvable provider plugin, and that
 * both are found from the function's own files alone. */
async function checkDispatchFunction(
  base: string,
  projectRel: string,
  version: string,
  probeRoot: string,
  env: Record<string, string | undefined>,
): Promise<{ archiveSha: string }> {
  const func = join(probeRoot, 'func')
  const files = await materializeDispatchFunction(base, func)
  const archive = join(projectRel, `.autobuild-dist/autobuild-${version}.tgz`)
  assert(files.includes(archive), `dispatch function lacks ${archive}`)
  const packed = JSON.parse(
    await command(['tar', '-xzOf', join(func, archive), 'package/package.json'], probeRoot, env),
  )
  assert.equal(packed.version, version)
  const manifests = files.filter(
    (path) =>
      path.endsWith('@defrex/autobuild/package.json') &&
      !path.includes('/@defrex/autobuild/node_modules/'),
  )
  assert.equal(manifests.length, 1, `expected one distribution manifest: ${manifests.join(', ')}`)
  const distRel = dirname(manifests[0]!)
  assert.equal(JSON.parse(await readFile(join(func, manifests[0]!), 'utf8')).version, version)
  for (const file of ['package.json', 'dist/index.js'])
    assert(files.includes(join(distRel, STAGED_PLUGIN, file)), `dispatch function lacks ${file}`)
  // The compiled distributionRoot() is this same shipped directory: Turbopack
  // embeds the inlined module's path relative to the tracing root.
  const chunkReference = `${distRel}/packages/core/src/distribution.ts`
  let embedded = false
  for (const path of files.filter((file) => file.includes('.next/server/') && file.endsWith('.js')))
    if ((await readFile(join(func, path), 'utf8')).includes(chunkReference)) embedded = true
  assert(embedded, `no dispatch chunk embeds ${chunkReference}`)
  // Resolve inside the function with no bun on PATH, no VERCEL_TOKEN and the
  // installer disabled: only the shipped files can satisfy either lookup.
  const probe = join(probeRoot, 'probe.ts')
  const empty = join(probeRoot, 'empty')
  await mkdir(empty)
  await writeFile(
    probe,
    `import { diagnosePlugins } from ${JSON.stringify(join(repoRoot, 'packages/core/src/plugins/load.ts'))}
import { findPrebuiltDistributionArchive } from ${JSON.stringify(join(repoRoot, 'packages/core/src/ports/workspace/distribution-archive.ts'))}
const [installationRoot, projectRoot, empty] = process.argv.slice(2)
const { reports } = await diagnosePlugins(['@defrex/autobuild-vercel-sandbox'], empty!, {
  packageRoot: empty,
  installationRoot,
})
const archive = await findPrebuiltDistributionArchive({}, [installationRoot!, projectRoot!])
console.log(JSON.stringify({ reports, archive }))
`,
  )
  const bunDirectory = dirname(process.execPath)
  const PATH = (env.PATH ?? '')
    .split(delimiter)
    .filter((entry) => entry !== '' && entry !== bunDirectory && !Bun.which('bun', { PATH: entry }))
    .join(delimiter)
  const output = await command(
    [process.execPath, '--no-install', probe, join(func, distRel), join(func, projectRel), empty],
    empty,
    { PATH, HOME: env.HOME, TMPDIR: env.TMPDIR },
  )
  const line = output.split('\n').find((text) => text.startsWith('{"reports"'))
  assert(line, output)
  const result = JSON.parse(line) as {
    reports: { status: string; resolved?: string; notice?: string }[]
    archive: string | null
  }
  assert.equal(result.reports.length, 1)
  const [report] = result.reports
  assert.equal(report?.status, 'skipped', JSON.stringify(report))
  assert.equal(report?.resolved, join(func, distRel, STAGED_PLUGIN, 'dist/index.js'))
  assert(report?.notice?.includes('builtin workspace-provider registration'), report?.notice)
  assert.equal(result.archive, join(func, archive))
  await checkShippedGit(func, files, projectRel, probeRoot, PATH)
  return { archiveSha: await sha256(join(func, archive)) }
}

/** Vercel's documented uncompressed function size limit. */
const FUNCTION_SIZE_LIMIT = 250 * 1024 * 1024

/** The materialized function carries the shipped Git, stays inside the size
 * limit, and its Git runs from a PATH without git while loading nothing from
 * the host — exactly as the runtime locator unpacks it. */
async function checkShippedGit(
  func: string,
  files: string[],
  projectRel: string,
  probeRoot: string,
  PATH: string,
) {
  const tree = join(projectRel, '.autobuild-git')
  assert(files.includes(join(tree, 'manifest.json')), `dispatch function lacks ${tree}`)
  const manifest = JSON.parse(
    await readFile(join(func, tree, 'manifest.json'), 'utf8'),
  ) as ShippedGitManifest
  for (const file of manifest.files)
    assert(files.includes(join(tree, file)), `dispatch function lacks ${join(tree, file)}`)
  let total = 0
  for (const file of files) {
    const info = await stat(join(func, file))
    if (info.isFile()) total += info.size
  }
  assert(total < FUNCTION_SIZE_LIMIT, `dispatch function is ${total} bytes, over 250 MB`)
  console.log(
    `dispatch function ${(total / 1024 / 1024).toFixed(1)} MB, of which shipped Git ` +
      `${(manifest.bytes / 1024 / 1024).toFixed(1)} MB (${manifest.gitVersion}, glibc ${manifest.glibcVersion})`,
  )
  const noGit = PATH.split(delimiter)
    .filter((entry) => entry !== '' && !Bun.which('git', { PATH: entry }))
    .join(delimiter)
  try {
    const located = await locateShippedGit({ roots: [join(func, projectRel)] })
    assert(located.ok, located.ok ? '' : located.reason)
    const exec = shippedGitExec(spawnExec, located.git, { PATH: noGit })
    const trace = join(probeRoot, 'git-ld')
    await mkdir(trace)
    const env = { LD_DEBUG: 'libs', LD_DEBUG_OUTPUT: join(trace, 'trace'), HOME: probeRoot }
    const version = await exec(['git', '--version'], { cwd: probeRoot, env })
    assert.equal(version.exitCode, 0, version.stderr)
    assert.equal(version.stdout.trim(), `git version ${manifest.gitVersion}`)
    const init = await exec(['git', 'init', '--bare', '--quiet', join(probeRoot, 'kernel.git')], {
      cwd: probeRoot,
      env,
    })
    assert.equal(init.exitCode, 0, init.stderr)
    let traces = ''
    for (const name of await readdir(trace)) traces += await readFile(join(trace, name), 'utf8')
    const loaded = parseLdDebug(traces, manifest.root)
    assert(loaded.programs.length > 0, 'LD_DEBUG recorded no shipped Git programs')
    assert.deepEqual(loaded.foreign, [], 'the shipped Git loaded host objects')
  } finally {
    await rm(manifest.root, { recursive: true, force: true })
  }
}

/** Installed deployments with the dispatcher: a standalone template folder,
 * and a template folder that is a Bun workspace member built twice. */
async function checkDispatcherDeployments(
  root: string,
  template: Record<string, unknown> & { dependencies: Record<string, string> },
  archives: Record<string, string>,
  env: Record<string, string | undefined>,
) {
  const version = JSON.parse(await readFile(join(repoRoot, 'package.json'), 'utf8')).version
  const pin = template.dependencies['@defrex/autobuild']!
  const { overrides: _overrides, ...documented } = template
  const dispatcherManifest = {
    ...documented,
    dependencies: {
      ...template.dependencies,
      '@defrex/autobuild-hosted-dispatcher': pin,
      '@defrex/autobuild-vercel-sandbox': pin,
    },
  }
  const vercelJson = await readFile(join(repoRoot, deploymentTemplatePaths[0]!, 'vercel.json'))

  // Standalone: `vercel build` runs the build with VERCEL set, so the staged
  // plugin persists into the function bundle.
  const standalone = join(root, 'dispatcher-consumer')
  await mkdir(standalone)
  await writeFile(
    join(standalone, 'package.json'),
    JSON.stringify({ ...dispatcherManifest, overrides: archives }, null, 2),
  )
  await writeFile(join(standalone, 'vercel.json'), vercelJson)
  await installPackedDistribution([], standalone)
  await vercelBuild(standalone, env)
  await mkdir(join(root, 'standalone-probe'))
  await checkDispatchFunction(standalone, '', version, join(root, 'standalone-probe'), env)
  console.log('Packed standalone dispatcher deployment passed')

  // Workspace member at apps/autobuild, installed from the workspace root.
  // Bun's isolated linker does not hoist the service's type tooling, so a
  // member also declares what next build itself loads from the folder.
  //
  // The host then adds a second member, apps/web, exact-pinning the floor of
  // core's zod range, with the same pin at the workspace root (#824). Adding
  // them after the first install keeps core's locked newer zod, while the
  // copy the isolated linker shares becomes the floor: a service that does
  // not declare zod falls back to that shared copy, and next build fails its
  // type check inside the service's own source. A fresh install of the whole
  // workspace would dedupe core down to the floor and exercise no conflict.
  const service = JSON.parse(
    await readFile(join(repoRoot, 'packages/hosted-store-service/package.json'), 'utf8'),
  ).dependencies as Record<string, string>
  const zodRange = JSON.parse(await readFile(join(repoRoot, 'package.json'), 'utf8')).dependencies
    .zod as string
  const zodFloor = minVersion(zodRange)?.version
  assert(zodFloor !== undefined, `@defrex/autobuild's zod range ${zodRange} has no floor`)
  const workspace = join(root, 'workspace-consumer')
  const member = join(workspace, 'apps/autobuild')
  await mkdir(member, { recursive: true })
  const workspaceManifest = { private: true, workspaces: ['apps/*'], overrides: archives }
  await writeFile(join(workspace, 'package.json'), JSON.stringify(workspaceManifest, null, 2))
  await writeFile(join(workspace, 'bunfig.toml'), '[install]\nlinker = "isolated"\n')
  const tooling = ['typescript', '@types/bun', '@types/node', '@types/react', '@types/react-dom']
  await writeFile(
    join(member, 'package.json'),
    JSON.stringify(
      {
        name: 'autobuild-service',
        ...dispatcherManifest,
        dependencies: {
          ...dispatcherManifest.dependencies,
          ...Object.fromEntries(tooling.map((name) => [name, service[name]!])),
        },
      },
      null,
      2,
    ),
  )
  await writeFile(join(member, 'vercel.json'), vercelJson)
  await installPackedDistribution([], workspace)
  await mkdir(join(workspace, 'apps/web'))
  await writeFile(
    join(workspace, 'apps/web/package.json'),
    JSON.stringify({ name: 'web', private: true, dependencies: { zod: zodFloor } }, null, 2),
  )
  await writeFile(
    join(workspace, 'package.json'),
    JSON.stringify({ ...workspaceManifest, dependencies: { zod: zodFloor } }, null, 2),
  )
  await installPackedDistribution([], workspace)
  const lock = await readFile(join(workspace, 'bun.lock'))
  const distributionRoot = await realpath(join(member, 'node_modules/@defrex/autobuild'))
  assert(distributionRoot.startsWith(join(workspace, 'node_modules/')), distributionRoot)
  const serviceZod = await resolvedPackage(
    'zod',
    await realpath(join(member, 'node_modules/@defrex/autobuild-hosted-store-service')),
  )
  const coreZod = await resolvedPackage('zod', distributionRoot)
  const webZod = await resolvedPackage('zod', await realpath(join(workspace, 'apps/web')))
  const sharedZod = await resolvedPackage('zod', join(workspace, 'node_modules/.bun'))
  assert.equal(webZod.version, zodFloor)
  assert.equal(
    sharedZod.version,
    zodFloor,
    `the isolated linker shares zod ${sharedZod.version}, not the host's pin; an undeclared ` +
      'zod import would not fall back to a conflicting copy',
  )
  assert.notEqual(
    coreZod.version,
    zodFloor,
    `@defrex/autobuild resolved zod ${coreZod.version}, the host's pin; the workspace ` +
      'case no longer exercises a conflicting shared copy',
  )
  assert.equal(
    serviceZod.path,
    coreZod.path,
    `the hosted store service must resolve the zod copy @defrex/autobuild uses: service ` +
      `${serviceZod.path} (${serviceZod.version}), core ${coreZod.path} (${coreZod.version})`,
  )

  // Run 1: a local build (no VERCEL) from the folder.
  const local = { ...env, VERCEL: undefined }
  await command(['bun', 'run', 'build'], member, local)
  const archive = join(member, `.autobuild-dist/autobuild-${version}.tgz`)
  const staged = join(distributionRoot, STAGED_PLUGIN)
  const shipped = await shippedTraceEntries(member)
  const gitManifest = JSON.parse(
    await readFile(join(member, '.autobuild-git/manifest.json'), 'utf8'),
  ) as ShippedGitManifest
  assert.deepEqual(
    shipped,
    [
      archive,
      join(distributionRoot, 'package.json'),
      join(staged, 'dist/index.js'),
      join(staged, 'package.json'),
      ...[...gitManifest.files, 'manifest.json'].map((file) =>
        join(member, '.autobuild-git', file),
      ),
    ].sort(),
  )
  await stat(archive)
  await stat(join(distributionRoot, 'package.json'))
  await assert.rejects(stat(staged), 'a local run removes the staged plugin')
  const firstArchive = await sha256(archive)
  await command(['bun', 'install', '--frozen-lockfile'], workspace, env)
  assert((await readFile(join(workspace, 'bun.lock'))).equals(lock), 'bun.lock changed')

  // Run 2: `vercel build` at the workspace root, Root Directory the folder,
  // in the same checkout as a Vercel build cache would leave it.
  await vercelBuild(workspace, env, { rootDirectory: 'apps/autobuild' })
  assert.deepEqual(await shippedTraceEntries(member), shipped)
  await mkdir(join(root, 'workspace-probe'))
  const { archiveSha } = await checkDispatchFunction(
    workspace,
    'apps/autobuild',
    version,
    join(root, 'workspace-probe'),
    env,
  )
  assert.equal(archiveSha, firstArchive)
  console.log(
    `Packed workspace-member dispatcher deployment passed beside a member pinning zod ${zodFloor}`,
  )
}

/** Where `name` resolves from `fromDirectory`, as a realpath, with the
 * version of the package that owns the resolved file. */
async function resolvedPackage(
  name: string,
  fromDirectory: string,
): Promise<{ path: string; version: string }> {
  const path = await realpath(Bun.resolveSync(name, fromDirectory))
  for (let directory = dirname(path); directory !== dirname(directory); ) {
    const manifest = await readFile(join(directory, 'package.json'), 'utf8').then(
      (text) => JSON.parse(text) as { name?: unknown; version?: unknown },
      () => undefined,
    )
    if (manifest?.name === name && typeof manifest.version === 'string') {
      return { path, version: manifest.version }
    }
    directory = dirname(directory)
  }
  throw new Error(`no ${name} package.json above ${path}`)
}

/** Real packed consumer, outside workspace resolution. This is intentionally a
 * live command rather than another expensive build in the unit test suite. */
export async function checkHostedServicePackaging() {
  await checkDeploymentTemplates()
  const url = process.env.AB_POSTGRES_TEST_URL
  assert(url, 'AB_POSTGRES_TEST_URL is required')
  const root = await mkdtemp(join(tmpdir(), 'ab-service-packaging-'))
  const schema = `ab_pack_${crypto.randomUUID().replaceAll('-', '')}`
  const admin = new SQL(url)
  let server: ReturnType<typeof Bun.spawn> | undefined
  let blobServer: ReturnType<typeof Bun.serve> | undefined
  try {
    await admin.unsafe(`CREATE SCHEMA ${schema}`)
    const scoped = new URL(url)
    scoped.searchParams.set('options', `-csearch_path=${schema}`)
    const env: Record<string, string | undefined> = {
      ...process.env,
      NODE_PATH: undefined,
      BUN_INSTALL: undefined,
      // Next/Vercel child processes use Node's compile cache. Keep it inside
      // this rehearsal's owned directory so the final cleanup removes it.
      NODE_COMPILE_CACHE: join(root, 'node-compile-cache'),
      AB_SERVICE_BUILD_ROOT: undefined,
      AB_POSTGRES_URL: scoped.toString(),
      DATABASE_URL: undefined,
      BETTER_AUTH_URL: 'https://operator.example',
      BETTER_AUTH_SECRET: '0123456789abcdef0123456789abcdef0123456789',
      GITHUB_CLIENT_ID: 'packaging-client',
      GITHUB_CLIENT_SECRET: 'packaging-secret',
      AB_STORE_SECRET: 'packaging-store-secret',
      AB_BLOB_BACKEND: 's3',
      AB_S3_BUCKET: 'unused',
      AB_S3_REGION: 'us-east-1',
      AB_S3_ACCESS_KEY_ID: 'unused',
      AB_S3_SECRET_ACCESS_KEY: 'unused',
      AB_WEB_AUTH_PROVIDERS: 'github',
      AB_WEB_SUPER_USER_EMAILS: 'ada@example.com',
      AB_WEB_REPOSITORIES: 'https://github.com/owner/repo',
      NEXT_TELEMETRY_DISABLED: '1',
    }
    const archives: Record<string, string> = {}
    for (const directory of [
      '.',
      'packages/postgres-store',
      'packages/hosted-store-service',
      'packages/hosted-dispatcher',
      'packages/vercel-sandbox',
    ]) {
      const manifest = JSON.parse(await readFile(join(repoRoot, directory, 'package.json'), 'utf8'))
      const archive = join(root, `${manifest.name.replaceAll('/', '-').replace('@', '')}.tgz`)
      await command(
        ['bun', 'pm', 'pack', '--ignore-scripts', '--filename', archive],
        join(repoRoot, directory),
        env,
      )
      archives[manifest.name] = archive
    }
    const consumer = join(root, 'consumer')
    await mkdir(consumer)
    const manifest = JSON.parse(
      await readFile(join(repoRoot, deploymentTemplatePaths[0]!, 'package.json'), 'utf8'),
    )
    // Only test overrides differ from the documented consumer manifest.
    manifest.overrides = archives
    await writeFile(join(consumer, 'package.json'), JSON.stringify(manifest, null, 2))
    await writeFile(
      join(consumer, 'vercel.json'),
      await readFile(join(repoRoot, deploymentTemplatePaths[0]!, 'vercel.json')),
    )
    await installPackedDistribution([], consumer)
    const installed = join(consumer, 'node_modules/@defrex/autobuild-hosted-store-service')
    assert((await realpath(installed)).startsWith(root))
    const packedPaths = await paths(installed)
    for (const file of [
      'app/mcp/route.ts',
      'app/sign-in/page.tsx',
      'next.config.ts',
      'src/deploy-build.ts',
      'tsconfig.deploy.json',
    ])
      assert(packedPaths.includes(join(installed, file)), `Missing packed asset ${file}`)
    assert(
      !packedPaths.some(
        (path) => /\.(?:test|spec)\.tsx?$/.test(path) || path.includes('/.impeccable/'),
      ),
    )
    const missing = await command(
      ['bun', 'run', 'build'],
      consumer,
      { ...env, AB_POSTGRES_URL: undefined, DATABASE_URL: undefined },
      false,
    )
    assert(missing.includes('required and must be nonblank'), missing)
    const failure = await command(
      ['bun', 'run', 'build'],
      consumer,
      {
        ...env,
        AB_POSTGRES_URL: 'postgres://postgres:postgres@127.0.0.1:1/postgres?connect_timeout=1',
      },
      false,
    )
    assert(!failure.includes('Creating an optimized production build'))
    // Upgrade a genuine populated ticket-v1 database through the *packed*
    // deployment CLI, fetching config bytes through its production S3 adapter.
    await migratePostgres(scoped.toString())
    const blobs = new MemoryBlobStore()
    const backing = await openPostgresBuildStore(scoped.toString(), blobs)
    const legacyDb = new SQL(scoped.toString())
    try {
      const repo = 'https://github.com/owner/repo'
      await legacyDb`INSERT INTO project_journal (seq,repo,action,actor,ts) VALUES (nextval('project_journal_seq'), ${repo}, 'added', 'packaging', ${new Date().toISOString()})`
      await backing.ensureRepo(repo)
      const { verify, finalize, ...config } = parseConfig(
        '[tickets]\nsource = "hosted"\nteamKey = "PACK"\nreadyState = "Ready"\n[verify]\nsteps = []\n[finalize]\nsteps = []',
      )
      const artifact = await backing.putRepoArtifact(repo, {
        kind: 'dispatcher-effective-config',
        content: JSON.stringify({
          ...config,
          verify: { steps: verify.steps },
          finalize: { steps: finalize.steps },
        }),
      })
      await backing.appendRepo(repo, {
        actor: DISPATCHER,
        type: 'dispatcher.run-started',
        payload: {
          run: 'packaging',
          pid: 1,
          effectiveConfig: { kind: artifact.kind, rev: artifact.revision },
          roleWarnings: [],
        },
      })
      await legacyDb.unsafe(
        'DROP TABLE ab_ticket_counters, ab_ticket_blockers, ab_ticket_comments, ab_tickets, ab_ticket_schema_migrations',
      )
      await legacyDb.unsafe(TICKET_SCHEMA_V1_DDL)
      await legacyDb`INSERT INTO ab_ticket_schema_migrations VALUES (true, 1, ${TICKET_SCHEMA_V1_CHECKSUM}, ${new Date().toISOString()})`
      await legacyDb`INSERT INTO ab_tickets VALUES ('PACK', 'PACK-1', 'key', 'Preserved', 'Body', 'Historical', ARRAY[]::text[], ${new Date().toISOString()}, ${new Date().toISOString()})`
      // Released v0.11.0 used main schema v9: its registry did not exist yet.
      await legacyDb.unsafe(
        'DROP TABLE project_credentials, project_journal, project_registry_state; DROP SEQUENCE project_journal_seq',
      )
      await legacyDb`UPDATE ab_schema_migrations SET version = 9, checksum = ${SCHEMA_V9_CHECKSUM}`
    } finally {
      await backing.close()
      await legacyDb.close()
    }
    const blobRequests: string[] = []
    blobServer = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch: async (request) => {
        const path = new URL(request.url).pathname
        blobRequests.push(path)
        const prefix = '/unused/packaging/'
        const bytes = path.startsWith(prefix) ? await blobs.get(path.slice(prefix.length)) : null
        return bytes === null
          ? new Response('', { status: 404 })
          : new Response(new Uint8Array(bytes))
      },
    })
    env.AB_S3_ENDPOINT = `http://127.0.0.1:${blobServer.port}`
    env.AB_S3_FORCE_PATH_STYLE = 'true'
    env.AB_BLOB_PREFIX = 'packaging'
    const blocked = await command(
      ['bun', 'run', 'build'],
      consumer,
      { ...env, AB_BLOB_BACKEND: undefined },
      false,
    )
    assert(blocked.includes('blob'), blocked)
    assert(!blocked.includes('Creating an optimized production build'))
    const unchanged = new SQL(scoped.toString())
    try {
      assert.equal(
        Number((await unchanged`SELECT version FROM ab_schema_migrations`)[0].version),
        9,
      )
      assert.equal(
        (await unchanged`SELECT to_regclass('project_journal') AS table_name`)[0].table_name,
        null,
      )
      assert.equal(
        Number((await unchanged`SELECT version FROM ab_ticket_schema_migrations`)[0].version),
        1,
      )
    } finally {
      await unchanged.close()
    }
    await command(['bun', 'run', 'build'], consumer, env)
    assert(blobRequests.some((path) => path.startsWith('/unused/packaging/')))
    console.log('Packed service migrated populated ticket v1 and built')
    const db = new SQL(scoped.toString())
    try {
      const markers = await db`SELECT version FROM ab_schema_migrations`
      assert.equal(Number(markers[0]?.version), SCHEMA_VERSION)
      const importedProjects = await db`SELECT repo, actor FROM project_journal`
      assert.deepEqual(
        [...importedProjects],
        [{ repo: 'https://github.com/owner/repo', actor: 'system:AB_WEB_REPOSITORIES' }],
      )
      const ticketMarkers = await db`SELECT version FROM ab_ticket_schema_migrations`
      assert.equal(Number(ticketMarkers[0]?.version), TICKET_SCHEMA_VERSION)
      const ticket = (await db`SELECT repo, id, state FROM ab_tickets`)[0]
      assert.deepEqual(
        { ...ticket },
        { repo: 'https://github.com/owner/repo', id: 'PACK-1', state: 'Historical' },
      )
      const authMarkers = await db`SELECT version FROM ab_auth_schema_migrations`
      assert.equal(Number(authMarkers[0]?.version), AUTH_SCHEMA_VERSION)
      await command(
        [
          'bun',
          join(dirname(Bun.resolveSync('@defrex/autobuild-postgres-store', installed)), 'bin.ts'),
          'migrate',
        ],
        consumer,
        env,
      )
      // Reserve a free port, then release it immediately before starting Next.
      const reservation = Bun.serve({ port: 0, fetch: () => new Response() })
      const port = reservation.port!
      reservation.stop(true)
      server = Bun.spawn(['bun', 'node_modules/next/dist/bin/next', 'start', '-p', String(port)], {
        cwd: consumer,
        env,
        stdout: 'ignore',
        stderr: 'inherit',
      })
      const origin = `http://localhost:${port}`
      let ready = false
      for (let i = 0; i < 120; i++) {
        try {
          if ((await fetch(`${origin}/health`)).ok) {
            ready = true
            break
          }
        } catch {}
        await Bun.sleep(250)
      }
      assert(ready, 'Production server did not start')
      const get = (path: string) => fetch(`${origin}${path}`, { redirect: 'manual' })
      assert.equal((await get('/health')).status, 200)
      assert.equal((await get('/sign-in')).status, 200)
      assert([302, 303, 307].includes((await get('/')).status))
      const health = (await (await get('/health')).json()) as {
        autobuildVersion: string
        protocolVersion: string
      }
      assert.equal(
        (
          await fetch(`${origin}/builds`, {
            headers: {
              'x-autobuild-version': health.autobuildVersion,
              'x-autobuild-protocol-version': health.protocolVersion,
            },
          })
        ).status,
        401,
      )
      const challenge = await get('/mcp')
      assert.equal(challenge.status, 401)
      assert(challenge.headers.get('www-authenticate')?.includes('resource_metadata'))
      const dispatch = await get('/api/dispatch')
      assert.equal(dispatch.status, 503)
      assert.deepEqual(await dispatch.json(), {
        error: 'dispatch runs elsewhere for this deployment',
      })
      const resource = (await (
        await get('/.well-known/oauth-protected-resource')
      ).json()) as Record<string, unknown>
      assert.equal(resource.resource, `${env.BETTER_AUTH_URL}/mcp`)
      assert.deepEqual(resource.authorization_servers, [env.BETTER_AUTH_URL])
      const metadata = (await (
        await get('/.well-known/oauth-authorization-server')
      ).json()) as Record<string, string>
      assert.equal(metadata.issuer, env.BETTER_AUTH_URL)
      const local = (url: string) => `${origin}${new URL(url).pathname}`
      assert.equal((await fetch(local(metadata.jwks_uri!))).status, 200)
      const registration = await fetch(local(metadata.registration_endpoint!), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          client_name: 'Packed service check',
          redirect_uris: ['https://client.example/callback'],
          token_endpoint_auth_method: 'none',
        }),
      })
      assert.equal(registration.status, 201)
      const client = (await registration.json()) as {
        client_id: string
        token_endpoint_auth_method: string
      }
      assert.equal(typeof client.client_id, 'string')
      assert(client.client_id.length > 0)
      assert.equal(client.token_endpoint_auth_method, 'none')
      const persisted =
        await db`SELECT "authenticationScheme" FROM "oauthApplication" WHERE "clientId" = ${client.client_id}`
      assert.equal(persisted[0]?.authenticationScheme, 'none')
    } finally {
      await db.close()
    }
    server.kill()
    await server.exited
    server = undefined
    console.log('Production HTTP discovery and registration passed')
    await vercelBuild(consumer, env)
    const output = join(consumer, '.vercel/output')
    const config = await readFile(join(output, 'config.json'), 'utf8')
    assert(config.includes('oauth-protected-resource'))
    assert(config.includes('oauth-authorization-server'))
    const functions = await paths(join(output, 'functions'))
    for (const route of ['health', 'mcp', 'api/auth'])
      assert(
        functions.some((path) => path.includes(route)),
        `Missing Vercel function ${route}`,
      )
    assert(!functions.some((path) => path.includes('autobuild-hosted-dispatcher')))
    const generated = JSON.parse(config) as { crons?: unknown[] }
    assert.equal(generated.crons?.length ?? 0, 0)
    console.log('Packed Vercel service deployment passed')
    await checkDispatcherDeployments(root, manifest, archives, env)
  } finally {
    blobServer?.stop(true)
    if (server) {
      server.kill()
      await server.exited
    }
    await admin.unsafe(`DROP SCHEMA IF EXISTS ${schema} CASCADE`)
    await admin.close()
    await rm(root, { recursive: true, force: true })
  }
}

if (import.meta.main) await checkHostedServicePackaging()
