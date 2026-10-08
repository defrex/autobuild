/**
 * Real-Bun evidence for the self-update mutation paths. A `Bun.serve` stub is
 * the npm registry (the only substituted seam: it serves two versions of a
 * tiny fixture package); `bun add` / `bun install` run for real in a temp
 * project. Scripted `command` fakes only the global-bin probe and the final
 * handoff child.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { inspectInstallation } from './installation'
import { selfUpdate, type SelfUpdateCommand } from './self-update'

const NAME = 'ab-fixture-selfupdate'
let scratch: string
let server: ReturnType<typeof Bun.serve>
let registry: string
const tarballs = new Map<string, Uint8Array>()

async function pack(version: string): Promise<Uint8Array> {
  const dir = join(scratch, `pack-${version}`)
  await mkdir(join(dir, 'package', 'bin'), { recursive: true })
  await writeFile(
    join(dir, 'package', 'package.json'),
    JSON.stringify({ name: NAME, version, bin: { ab: 'bin/ab.ts' } }),
  )
  await writeFile(join(dir, 'package', 'bin', 'ab.ts'), '')
  const file = join(dir, 'pkg.tgz')
  await Bun.$`tar czf ${file} -C ${dir} package`.quiet()
  return new Uint8Array(await Bun.file(file).arrayBuffer())
}

beforeAll(async () => {
  scratch = await mkdtemp(join(tmpdir(), 'ab-self-update-bun-'))
  for (const version of ['1.0.0', '1.1.0']) tarballs.set(version, await pack(version))
  server = Bun.serve({
    port: 0,
    fetch(request) {
      const { pathname } = new URL(request.url)
      const tarball = /\/-\/.*-(\d+\.\d+\.\d+)\.tgz$/.exec(pathname)
      if (tarball?.[1] !== undefined) {
        return new Response(Bun.file(join(scratch, `pack-${tarball[1]}`, 'pkg.tgz')))
      }
      if (pathname === `/${NAME}`) {
        const versions = Object.fromEntries(
          [...tarballs.keys()].map((v) => [
            v,
            {
              name: NAME,
              version: v,
              bin: { ab: 'bin/ab.ts' },
              dist: { tarball: `${registry}/${NAME}/-/${NAME}-${v}.tgz` },
            },
          ]),
        )
        return Response.json({ name: NAME, 'dist-tags': { latest: '1.1.0' }, versions })
      }
      return new Response('not found', { status: 404 })
    },
  })
  registry = `http://localhost:${server.port}`
})

afterAll(async () => {
  await server.stop(true)
  await rm(scratch, { recursive: true, force: true })
})

const env = () => ({
  ...process.env,
  BUN_CONFIG_REGISTRY: registry,
  BUN_INSTALL_CACHE_DIR: join(scratch, 'cache'),
})

async function bun(args: string[], cwd: string): Promise<void> {
  const proc = Bun.spawn(['bun', ...args], { cwd, env: env(), stdout: 'pipe', stderr: 'pipe' })
  const [err, code] = await Promise.all([new Response(proc.stderr).text(), proc.exited])
  if (code !== 0) throw new Error(`bun ${args.join(' ')} failed: ${err}`)
}

type Layout = 'dependencies' | 'devDependencies' | 'dual'

async function project(layout: Layout): Promise<string> {
  const owner = await mkdtemp(join(scratch, 'owner-'))
  if (layout === 'dual') {
    await writeFile(
      join(owner, 'package.json'),
      `${JSON.stringify(
        {
          name: 'consumer',
          dependencies: { [NAME]: '^1.0.0' },
          devDependencies: { [NAME]: '1.0.0' },
        },
        null,
        2,
      )}\n`,
    )
    await bun(['install'], owner)
  } else {
    await writeFile(
      join(owner, 'package.json'),
      `${JSON.stringify({ name: 'consumer' }, null, 2)}\n`,
    )
    await bun(['add', ...(layout === 'devDependencies' ? ['-d'] : []), `${NAME}@1.0.0`], owner)
  }
  return owner
}

/** Bun records the registry URL in the lock's package record when the registry
 * is not its default; the detector expects the default registry's empty
 * marker. Blank it so the stub registry classifies like the public one. */
async function blankRegistryMarker(owner: string): Promise<void> {
  const path = join(owner, 'bun.lock')
  const text = await readFile(path, 'utf8')
  await writeFile(path, text.replace(/("[^"]+@\d+\.\d+\.\d+", )"http[^"]*"/, '$1""'))
}

const json = async (path: string) => JSON.parse(await readFile(path, 'utf8'))

describe('real Bun self-update of a registry install', () => {
  for (const layout of ['dependencies', 'devDependencies', 'dual'] as const) {
    test(`updates a ${layout} install in place`, async () => {
      const owner = await project(layout)
      const dist = join(owner, 'node_modules', NAME)
      const globalBin = join(owner, 'no-global-bin')
      await blankRegistryMarker(owner)
      const before = await inspectInstallation({ distRoot: dist, globalBin })
      expect(before.kind === 'unknown' ? before.reason : before.kind).toBe('npm-registry')

      const real = (argv: string[]) =>
        Bun.spawn(argv, { env: env(), stdout: 'pipe', stderr: 'pipe' })
      const command: SelfUpdateCommand = async (argv) => {
        if (argv[1] === 'pm') return { stdout: `${globalBin}\n`, stderr: '', exitCode: 0 }
        if (argv[1] === 'add' || argv[1] === 'install') {
          const proc = real(argv)
          const [stdout, stderr, exitCode] = await Promise.all([
            new Response(proc.stdout).text(),
            new Response(proc.stderr).text(),
            proc.exited,
          ])
          return { stdout, stderr, exitCode }
        }
        return { stdout: '', stderr: '', exitCode: 0 }
      }
      const out: string[] = []
      const errs: string[] = []
      const result = await selfUpdate({
        targetRepo: owner,
        distRoot: dist,
        registry: async () => ({ status: 200, body: '{"version":"1.1.0"}' }),
        command,
        stdout: (line) => out.push(line),
        stderr: (line) => errs.push(line),
      })
      expect(errs).toEqual([])
      expect(result.kind).toBe('handoff')

      // (1) the installed package is the new version
      expect((await json(join(dist, 'package.json'))).version).toBe('1.1.0')
      // (2) package.json keeps the section(s) at the new specifier
      const manifest = await json(join(owner, 'package.json'))
      if (layout === 'dependencies') {
        expect(manifest.dependencies[NAME]).toBe('1.1.0')
        expect(manifest.devDependencies).toBeUndefined()
      } else if (layout === 'devDependencies') {
        expect(manifest.devDependencies[NAME]).toBe('1.1.0')
        expect(manifest.dependencies).toBeUndefined()
      } else {
        expect(manifest.dependencies[NAME]).toBe('1.1.0')
        expect(manifest.devDependencies[NAME]).toBe('1.1.0')
      }
      // (3) bun.lock workspace blocks match the manifest
      const lockText = await readFile(join(owner, 'bun.lock'), 'utf8')
      const workspace =
        (
          Bun.JSONC.parse(lockText) as {
            workspaces: Record<string, Record<string, Record<string, string> | undefined>>
          }
        ).workspaces[''] ?? {}
      for (const section of ['dependencies', 'devDependencies'] as const) {
        expect(workspace[section]?.[NAME]).toBe(manifest[section]?.[NAME])
      }
      // (4) the post-install identity check: the updated install is recognised
      await blankRegistryMarker(owner)
      const after = await inspectInstallation({ distRoot: dist, globalBin })
      expect(after.kind).toBe('npm-registry')
      if (after.kind === 'npm-registry') {
        expect(after.installation.version).toBe('1.1.0')
        expect(after.installation.section).toBe(layout === 'dual' ? 'dependencies' : layout)
      }
    }, 60_000)
  }
})
