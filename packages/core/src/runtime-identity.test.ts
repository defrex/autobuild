import { expect, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { captureRuntimeIdentity } from './runtime-identity'

test('source identity is captured once and missing metadata is harmless', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ab-identity-'))
  const git = (...args: string[]) =>
    execFileSync('git', ['-C', root, ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
  try {
    expect(captureRuntimeIdentity(root).commit).toBe('unknown')
    git('init')
    git(
      '-c',
      'user.name=test',
      '-c',
      'user.email=test@example.com',
      'commit',
      '--allow-empty',
      '-m',
      'first',
    )
    const nested = join(root, 'installed-package')
    await mkdir(nested)
    expect(captureRuntimeIdentity(nested).commit).toBe('unknown')
    const captured = captureRuntimeIdentity(root)
    expect(captured.commit).toBe(git('rev-parse', 'HEAD'))
    git(
      '-c',
      'user.name=test',
      '-c',
      'user.email=test@example.com',
      'commit',
      '--allow-empty',
      '-m',
      'second',
    )
    expect(captured.commit).not.toBe(git('rev-parse', 'HEAD'))
    await rm(join(root, '.git'), { recursive: true, force: true })
    await writeFile(join(root, 'package.json'), JSON.stringify({ gitHead: 'a'.repeat(40) }))
    expect(captureRuntimeIdentity(root).commit).toBe('a'.repeat(40))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
