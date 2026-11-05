import { afterEach, describe, expect, test } from 'bun:test'
import { randomBytes } from 'node:crypto'
import { copyFile, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readElf } from './elf'
import {
  parseLdDebug,
  parseLdd,
  stageGitForDeployment,
  validateStagedTree,
  type StageGitHost,
} from './ship-git'
import { dispatchTracePath } from './ship-packed-distribution'
import type { ShippedGitManifest } from './shipped-git'
import { elf } from './testing/elf'

const cleanup: string[] = []
afterEach(async () => {
  for (const path of cleanup.splice(0)) await rm(path, { recursive: true, force: true })
})

async function scratch(prefix: string): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), prefix))
  cleanup.push(path)
  return path
}

const LOADER = '/lib64/ld-linux-x86-64.so.2'

/** A project with a stub dispatch trace, and a fake build host whose Git,
 * libraries and `ldd` are synthetic files under a temp directory. */
async function fixture(
  options: {
    remoteHttps?: boolean
    interpreterSize?: number
    lddExtra?: string
    neededByHelper?: string[]
  } = {},
) {
  const project = await scratch('ab-ship-git-project-')
  const trace = dispatchTracePath(project)
  await mkdir(join(trace, '..'), { recursive: true })
  await writeFile(trace, JSON.stringify({ version: 1, files: ['../../page.js'] }))
  const hostRoot = await scratch('ab-ship-git-host-')
  const bin = join(hostRoot, 'bin')
  const execPath = join(hostRoot, 'libexec')
  const lib = join(hostRoot, 'lib')
  for (const dir of [
    bin,
    execPath,
    lib,
    join(execPath, 'mergetools'),
    join(hostRoot, 'templates', 'hooks'),
  ])
    await mkdir(dir, { recursive: true })
  const interpreter =
    options.interpreterSize === undefined
      ? { path: LOADER, size: 28 }
      : { path: '/lib/ld.so', size: options.interpreterSize }
  const git = join(bin, 'git')
  await writeFile(git, elf({ interpreter, needed: ['libc.so.6'] }))
  // Builtins: a symlink to git, and a byte-identical copy of it.
  await symlink(git, join(execPath, 'git-add'))
  await copyFile(git, join(execPath, 'git-commit'))
  if (options.remoteHttps !== false) {
    await writeFile(
      join(execPath, 'git-remote-https'),
      elf({ interpreter, needed: options.neededByHelper ?? ['libcurl.so.4', 'libc.so.6'] }),
    )
    // A helper link that is not git is copied as a file of its own.
    await symlink(join(execPath, 'git-remote-https'), join(execPath, 'git-remote-http'))
  }
  await writeFile(join(execPath, 'git-sh-setup'), '#!/bin/sh\n')
  await writeFile(join(execPath, 'mergetools', 'vimdiff'), '#!/bin/sh\n')
  await writeFile(
    join(lib, 'libc.so.6'),
    elf({ interpreter, needed: ['ld-linux-x86-64.so.2'], abiTag: [3, 2, 0] }),
  )
  await writeFile(join(lib, 'libcurl.so.4'), elf({ needed: ['libc.so.6'] }))
  await writeFile(join(lib, 'libnss_files.so.2'), elf({ needed: ['libc.so.6'] }))
  await writeFile(join(lib, 'ld-linux-x86-64.so.2'), elf({}))
  await writeFile(join(hostRoot, 'ca.pem'), 'certificates')
  await writeFile(join(hostRoot, 'templates', 'hooks', 'pre-commit.sample'), '#!/bin/sh\n')
  const lddOutput = (file: string) => {
    const lines = [`\tlinux-vdso.so.1 (0x00007fff00000000)`]
    if (file.endsWith('git-remote-https') || file.endsWith('git-remote-http'))
      lines.push(`\tlibcurl.so.4 => ${join(lib, 'libcurl.so.4')} (0x00007f0000001000)`)
    lines.push(`\tlibc.so.6 => ${join(lib, 'libc.so.6')} (0x00007f0000002000)`)
    lines.push(`\t${join(lib, 'ld-linux-x86-64.so.2')} (0x00007f0000003000)`)
    if (options.lddExtra) lines.push(options.lddExtra)
    return `${lines.join('\n')}\n`
  }
  const commands: string[][] = []
  const host: StageGitHost = {
    platform: 'linux',
    arch: 'x64',
    which: (name) => (name === 'git' ? git : name === 'ldd' ? '/usr/bin/ldd' : null),
    exec: async (cmd) => {
      commands.push(cmd)
      if (cmd[0] === git && cmd[1] === '--version')
        return { stdout: 'git version 2.99.0\n', stderr: '', exitCode: 0 }
      if (cmd[0] === git && cmd[1] === '--exec-path')
        return { stdout: `${execPath}\n`, stderr: '', exitCode: 0 }
      if (cmd[0] === '/usr/bin/ldd' && cmd[1] === '--version')
        return { stdout: 'ldd (GNU libc) 2.34\nCopyright\n', stderr: '', exitCode: 0 }
      if (cmd[0] === '/usr/bin/ldd') return { stdout: lddOutput(cmd[1]!), stderr: '', exitCode: 0 }
      throw new Error(`unexpected command ${cmd.join(' ')}`)
    },
    caCandidates: [join(hostRoot, 'missing.pem'), join(hostRoot, 'ca.pem')],
    templateCandidates: [join(hostRoot, 'templates')],
    materializeBase: '/tmp/abgf',
    prove: async () => ({ programs: [] }),
  }
  return { project, trace, host, hostRoot, execPath, commands }
}

async function stageError(host: StageGitHost, project: string): Promise<string> {
  try {
    await stageGitForDeployment({ root: project, host, log: () => {} })
  } catch (error) {
    return (error as Error).message
  }
  throw new Error('staging unexpectedly succeeded')
}

describe('stageGitForDeployment with a fake build host', () => {
  test('stages helpers, the library closure, the loader and a rewritten interpreter', async () => {
    const { project, trace, host } = await fixture()
    const lines: string[] = []
    const staged = await stageGitForDeployment({ root: project, host, log: (l) => lines.push(l) })
    const tree = join(project, '.autobuild-git')
    const manifest = JSON.parse(
      await readFile(join(tree, 'manifest.json'), 'utf8'),
    ) as ShippedGitManifest
    expect(manifest.root).toMatch(/^\/tmp\/abgf[0-9a-f]{8}$/)
    expect(manifest).toMatchObject({
      schema: 1,
      platform: 'linux-x64',
      gitVersion: '2.99.0',
      glibcVersion: '2.34',
      minimumKernel: '3.2.0',
      git: 'bin/git',
      execPath: 'libexec/git-core',
      lib: 'lib',
      caBundle: 'ssl/ca-bundle.crt',
      templates: 'share/git-core/templates',
    })
    expect([...manifest.files].sort()).toEqual([
      'bin/git',
      'ld',
      'lib/libc.so.6',
      'lib/libcurl.so.4',
      'lib/libnss_files.so.2',
      'libexec/git-core/git',
      'libexec/git-core/git-receive-pack',
      'libexec/git-core/git-remote-http',
      'libexec/git-core/git-remote-https',
      'libexec/git-core/git-sh-setup',
      'libexec/git-core/git-upload-archive',
      'libexec/git-core/git-upload-pack',
      'share/git-core/templates/hooks/pre-commit.sample',
      'ssl/ca-bundle.crt',
    ])
    expect(manifest.executables).toContain('ld')
    expect(manifest.executables).not.toContain('lib/libc.so.6')
    for (const file of ['bin/git', 'libexec/git-core/git-remote-https', 'lib/libc.so.6'])
      expect(readElf(new Uint8Array(await readFile(join(tree, file)))).interpreter?.path).toBe(
        `${manifest.root}/ld`,
      )
    // Every entry is a regular file.
    for (const file of manifest.files) expect((await stat(join(tree, file))).isFile()).toBe(true)
    expect(staged.appended).toBe(manifest.files.length + 1)
    expect(lines.at(-2)).toMatch(
      new RegExp(
        `^git 2\\.99\\.0 \\(glibc 2\\.34\\) for linux-x64 staged at ${tree}: 15 files, \\d+\\.\\d MB added to ${trace}$`,
      ),
    )
    expect(lines.at(-1)).toMatch(/^dispatch function trace now totals \d+\.\d MB$/)
    const files = JSON.parse(await readFile(trace, 'utf8')).files as string[]
    expect(files).toContain('../../../../../.autobuild-git/bin/git')
    expect(files).toContain('../../../../../.autobuild-git/manifest.json')
    expect(files[0]).toBe('../../page.js')

    // Restaging rebuilds the tree and leaves the trace unchanged.
    const again = await stageGitForDeployment({ root: project, host, log: () => {} })
    expect(again.appended).toBe(0)
    expect(JSON.parse(await readFile(trace, 'utf8')).files).toEqual(files)
    expect(again.manifest.root).toBe(manifest.root)
  })

  test('a wrong build host names both platforms', async () => {
    const { project, host } = await fixture()
    expect(await stageError({ ...host, platform: 'darwin', arch: 'arm64' }, project)).toBe(
      'cannot stage Git for the hosted dispatcher: this build host is darwin-arm64, but the ' +
        '/api/dispatch function runs on linux-x64 — run ship-deployment on a linux-x64 host ' +
        '(Vercel builds stage it automatically)',
    )
  })

  test('each missing piece is named', async () => {
    const { project, host } = await fixture()
    expect(
      await stageError({ ...host, which: (n) => (n === 'git' ? null : '/x') }, project),
    ).toContain('no `git` on the build host PATH')
    expect(
      await stageError({ ...host, which: (n) => (n === 'ldd' ? null : host.which(n)) }, project),
    ).toContain('no `ldd` on the build host PATH')
    expect(await stageError({ ...host, caCandidates: ['/nonexistent.pem'] }, project)).toContain(
      'no CA bundle found (looked in /nonexistent.pem)',
    )
    const noHelper = await fixture({ remoteHttps: false })
    expect(await stageError(noHelper.host, noHelper.project)).toContain(
      `no git-remote-https in ${noHelper.execPath}`,
    )
    const notFound = await fixture({ lddExtra: '\tlibpcre2-8.so.0 => not found' })
    expect(await stageError(notFound.host, notFound.project)).toContain(
      'ldd reports libpcre2-8.so.0 not found for',
    )
    const unlisted = await fixture({ neededByHelper: ['libmissing.so.1', 'libc.so.6'] })
    expect(await stageError(unlisted.host, unlisted.project)).toMatch(
      /libexec\/git-core\/git-remote-https? needs libmissing\.so\.1, which is not in lib\/$/,
    )
    const small = await fixture({ interpreterSize: 12 })
    expect(await stageError(small.host, small.project)).toMatch(
      /: bin\/git \(from .*\): interpreter "\/tmp\/abgf[0-9a-f]{8}\/ld" needs 21 bytes but the segment holds 12$/,
    )
  })

  test('a staged object that still names a foreign loader fails validation', async () => {
    const tree = await scratch('ab-ship-git-tree-')
    await mkdir(join(tree, 'lib'))
    await writeFile(join(tree, 'lib', 'libc.so.6'), elf({ abiTag: [3, 2, 0] }))
    await mkdir(join(tree, 'bin'))
    await writeFile(
      join(tree, 'bin', 'git'),
      elf({ interpreter: { path: LOADER, size: 28 }, needed: ['libc.so.6'] }),
    )
    await expect(
      validateStagedTree(tree, '/tmp/abg01234567/ld', 'ld-linux-x86-64.so.2'),
    ).rejects.toThrow(`bin/git still names the program loader ${LOADER}, not /tmp/abg01234567/ld`)
    await writeFile(
      join(tree, 'bin', 'git'),
      elf({ interpreter: { path: '/tmp/abg01234567/ld', size: 28 }, runpath: '/usr/lib64' }),
    )
    await expect(
      validateStagedTree(tree, '/tmp/abg01234567/ld', 'ld-linux-x86-64.so.2'),
    ).rejects.toThrow('bin/git searches /usr/lib64 outside the shipped tree')
    await writeFile(join(tree, 'bin', 'git'), elf({ machine: 183 }))
    await expect(
      validateStagedTree(tree, '/tmp/abg01234567/ld', 'ld-linux-x86-64.so.2'),
    ).rejects.toThrow('bin/git: ELF machine 183 is not x86_64')
  })
})

describe('build-host tool output', () => {
  test('ldd output yields libraries, the loader and missing names', () => {
    expect(
      parseLdd(
        [
          '\tlinux-vdso.so.1 (0x00007ffd)',
          '\tlibz.so.1 => /usr/lib64/libz.so.1 (0x00007f01)',
          '\tlibfoo.so.2 => not found',
          '\t/lib64/ld-linux-x86-64.so.2 (0x00007f02)',
        ].join('\n'),
      ),
    ).toEqual({
      libraries: [{ soname: 'libz.so.1', path: '/usr/lib64/libz.so.1' }],
      loader: '/lib64/ld-linux-x86-64.so.2',
      missing: ['libfoo.so.2'],
    })
  })

  test('LD_DEBUG traces flag a host shell and host libraries', () => {
    const root = '/tmp/abg01234567'
    const parsed = parseLdDebug(
      [
        `     101:\tinitialize program: ${root}/bin/git`,
        `     101:\t trying file=${root}/lib/libz.so.1`,
        `     101:\tcalling init: ${root}/lib/libc.so.6`,
        '     102:\tinitialize program: /bin/sh',
        '     102:\t trying file=/usr/lib64/libc.so.6',
        '     102:\tcalling init: /usr/lib64/libc.so.6',
      ].join('\n'),
      root,
    )
    expect(parsed.programs).toEqual([`${root}/bin/git`, '/bin/sh'])
    expect(parsed.foreign).toEqual(['/bin/sh', '/usr/lib64/libc.so.6'])
  })
})

const realHost =
  process.platform === 'linux' &&
  process.arch === 'x64' &&
  Bun.which('git') !== null &&
  Bun.which('ldd') !== null

test.skipIf(!realHost)(
  'stages and proves the build host Git: a loopback HTTP clone loads nothing from the host',
  async () => {
    const project = await scratch('ab-ship-git-real-')
    const trace = dispatchTracePath(project)
    await mkdir(join(trace, '..'), { recursive: true })
    await writeFile(trace, JSON.stringify({ version: 1, files: [] }))
    // Short, so `<base><8 hex>/ld` fits the stock loader's interpreter segment.
    const materializeBase = `/tmp/abgt${randomBytes(2).toString('hex')}`
    const lines: string[] = []
    const { defaultStageGitHost } = await import('./ship-git')
    const staged = await stageGitForDeployment({
      root: project,
      host: { ...defaultStageGitHost(), materializeBase },
      log: (line) => lines.push(line),
    })
    try {
      const proof = lines.find((line) => line.startsWith('shipped Git proof: '))!
      expect(proof).toContain('bin/git')
      expect(proof).toContain('libexec/git-core/git-remote-http')
      expect(proof).not.toContain('/bin/sh')
      const tree = join(project, '.autobuild-git')
      expect(staged.manifest.files).toContain('libexec/git-core/git')
      expect(staged.manifest.files).toContain('libexec/git-core/git-remote-https')
      expect(staged.manifest.files).toContain('lib/libc.so.6')
      for (const file of staged.manifest.files)
        expect((await stat(join(tree, file))).isFile()).toBe(true)
      // The proof cleans its runtime root up.
      await expect(stat(staged.manifest.root)).rejects.toThrow()
    } finally {
      await rm(staged.manifest.root, { recursive: true, force: true })
    }
  },
  60_000,
)
