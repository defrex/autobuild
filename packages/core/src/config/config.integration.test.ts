import { describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadConfig } from './load'

const READY = '[tickets]\nsource = "file"\nreadyState = "ready"\n'

describe('loadConfig', () => {
  test('reads flattened values from disk and reports bad paths', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ab-config-test-'))
    try {
      const good = join(dir, 'autobuild.toml')
      await writeFile(good, `baseBranch = "trunk"\ncapacity = 2\n${READY}`)
      const config = await loadConfig(good)
      expect(config.baseBranch).toBe('trunk')
      expect(config.capacity).toBe(2)

      const bad = join(dir, 'bad.toml')
      await writeFile(bad, '[polcy]\n')
      await expect(loadConfig(bad)).rejects.toThrow('bad.toml')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test('layers the checkout local override file when it exists', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ab-config-local-'))
    try {
      const path = join(dir, 'autobuild.toml')
      const local = join(dir, '.autobuild', 'local.toml')
      await writeFile(path, `baseBranch = "trunk"\ncapacity = 2\n${READY}`)
      expect((await loadConfig(path)).capacity).toBe(2)

      await mkdir(join(dir, '.autobuild'))
      await writeFile(local, 'capacity = 5\n')
      const config = await loadConfig(path)
      expect(config.capacity).toBe(5)
      expect(config.baseBranch).toBe('trunk')

      await writeFile(local, 'baseBranch = "dev"\n')
      await expect(loadConfig(path)).rejects.toThrow(
        `${local}: baseBranch can only be set in autobuild.toml`,
      )

      await rm(local)
      await mkdir(local)
      await expect(loadConfig(path)).rejects.toThrow(`${local} could not be read`)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
