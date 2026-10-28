import { afterEach, expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const wrapper = resolve(import.meta.dir, 'verify-bun.sh')
const version = (await readFile(wrapper, 'utf8')).match(/^required_version=(.+)$/m)![1]!
const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})
async function fixture(current = 'old', mode = 'ok') {
  const root = await mkdtemp(join(tmpdir(), 'verify-bun-'))
  roots.push(root)
  const bin = join(root, 'bin')
  await mkdir(bin)
  async function executable(path: string, content: string) {
    await writeFile(path, `#!/bin/bash\nset -eu\n${content}\n`)
    await chmod(path, 0o755)
  }
  await executable(join(bin, 'bun'), `echo '${current}'`)
  // Fail even on Linux if the wrapper accidentally regains a flock dependency.
  await executable(join(bin, 'flock'), 'echo unexpected-flock >&2; exit 99')
  await executable(
    join(bin, 'npm'),
    `
    printf '%s\\n' "$@" >> "$HOME/npm-args"
    ${mode === 'fail' ? 'exit 23' : ''}
    sleep 0.1
    mkdir -p "$3/node_modules/.bin"
    printf '#!/bin/sh\\necho ${mode === 'wrong' ? 'wrong' : version}\\n' > "$3/node_modules/.bin/bun"
    chmod +x "$3/node_modules/.bin/bun"
  `,
  )
  const env = { ...process.env, HOME: root, PATH: `${bin}:/usr/bin:/bin` }
  const run = async (args: string[]) => {
    const child = Bun.spawn([wrapper, ...args], { env, stdout: 'pipe', stderr: 'pipe' })
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ])
    return { stdout, stderr, code }
  }
  return { root, run }
}

test('matching Bun is a no-op, including PATH and cache', async () => {
  const { root, run } = await fixture(version)
  expect((await run(['bun', '--version'])).stdout.trim()).toBe(version)
  expect(await Bun.file(join(root, 'npm-args')).exists()).toBe(false)
  expect(existsSync(join(root, '.cache/autobuild-repository-verify-bun/install.lock.d'))).toBe(
    false,
  )
})

test('cold installation is serialized, cached, and selects descendant Bun', async () => {
  const { root, run } = await fixture()
  const cache = join(root, '.cache/autobuild-repository-verify-bun')
  await mkdir(cache, { recursive: true })
  // Caches created by the old flock wrapper have a persistent regular file.
  await writeFile(join(cache, 'install.lock'), '')
  const results = await Promise.all([
    run(['bash', '-c', 'bun --version']),
    run(['bun', '--version']),
  ])
  for (const result of results) {
    expect(result.code).toBe(0)
    expect(result.stdout.trim()).toBe(version)
  }
  const args = await readFile(join(root, 'npm-args'), 'utf8')
  expect(args.split('\n')).toEqual([
    'install',
    '--prefix',
    join(root, '.cache/autobuild-repository-verify-bun'),
    '--no-save',
    `bun@${version}`,
    '',
  ])
  expect(existsSync(join(root, '.cache/autobuild-repository-verify-bun/install.lock.d'))).toBe(
    false,
  )
  expect((await run(['bun', '--version'])).code).toBe(0)
  expect(await readFile(join(root, 'npm-args'), 'utf8')).toBe(args)
  const forwarded = await run([
    'bash',
    '-c',
    'printf "%s" "$1"; exit 17',
    'command',
    'spaces $ and *',
  ])
  expect(forwarded).toMatchObject({ code: 17, stdout: 'spaces $ and *' })
})

for (const mode of ['fail', 'wrong']) {
  test(`installation ${mode} never falls back`, async () => {
    const { root, run } = await fixture('old', mode)
    expect((await run(['echo', 'must not execute'])).code).not.toBe(0)
    expect((await run(['echo', 'must not execute'])).stdout).not.toContain('must not execute')
    expect(existsSync(join(root, '.cache/autobuild-repository-verify-bun/install.lock.d'))).toBe(
      false,
    )
  })
}
test('empty invocation is rejected', async () => {
  const { run } = await fixture(version)
  expect((await run([])).code).toBe(2)
})
