import { expect, test } from 'bun:test'
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { accountEnvironment, withAccountSettings } from './account-env'

const account = {
  name: 'test',
  descriptor: { kind: 'claude-subscription' as const, credentialEnv: 'TOKEN' },
}
const exists = (path: string) =>
  access(path).then(
    () => true,
    () => false,
  )

test('no account invokes directly without creating files', async () => {
  expect(
    await withAccountSettings(
      {},
      undefined,
      async (args) => {
        expect(args).toEqual([])
        return 'ok'
      },
      {
        mkdtemp: () => {
          throw new Error('unexpected file creation')
        },
        writeFile,
        rm,
      },
    ),
  ).toBe('ok')
})

test('concurrent invocations keep distinct account files alive until each callback settles', async () => {
  const paths: string[] = []
  let release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const launch = (token: string) =>
    withAccountSettings(accountEnvironment({ TOKEN: token }, account), account, async (args) => {
      paths.push(args[1]!)
      if (paths.length === 2) release()
      await gate
      const settings = JSON.parse(await readFile(args[1]!, 'utf8'))
      expect(settings.env.CLAUDE_CODE_OAUTH_TOKEN).toBe(token)
    })
  await Promise.all([launch('synthetic-first'), launch('synthetic-second')])
  expect(new Set(paths).size).toBe(2)
  for (const path of paths) expect(await exists(dirname(path))).toBe(false)
})

test('partial setup failure cleans the private directory and suppresses filesystem diagnostics', async () => {
  let path!: string
  await expect(
    withAccountSettings(
      {},
      account,
      async () => {
        throw new Error('must not launch')
      },
      {
        mkdtemp,
        writeFile: async (file, data, options) => {
          path = String(file)
          await writeFile(file, data, options)
          throw new Error('synthetic-secret in filesystem diagnostic')
        },
        rm,
      },
    ),
  ).rejects.toThrow('Account settings setup failed')
  expect(await exists(path)).toBe(false)
  expect(await exists(dirname(path))).toBe(false)
})

test('cleanup failure is not success and retains primary invocation failure context', async () => {
  let directory!: string
  const primary = new Error('offline invocation failure')
  try {
    await withAccountSettings(
      {},
      account,
      async () => {
        throw primary
      },
      {
        mkdtemp: async (prefix) => {
          directory = await mkdtemp(prefix)
          return directory
        },
        writeFile,
        rm: async () => {
          throw new Error('synthetic-secret in cleanup diagnostic')
        },
      },
    )
    throw new Error('expected failure')
  } catch (error) {
    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toBe('Account invocation failed and settings cleanup failed')
    expect((error as Error).cause).toBe(primary)
  } finally {
    if (directory) await rm(directory, { recursive: true, force: true })
  }
})
