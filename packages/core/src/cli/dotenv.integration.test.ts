/**
 * Local .env loading tests: the missing-file no-op, and the
 * precedence rule — the real environment always wins over .env values, so a
 * checked-in .env can never shadow runner-set ambient auth (D8).
 */
import { describe, expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadDotEnv } from './dotenv'

describe('loadDotEnv', () => {
  test('loads the file into env; existing variables win', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ab-dotenv-'))
    try {
      const path = join(dir, '.env')
      await writeFile(path, 'LINEAR_API_KEY=from_dotenv\nNEW_VAR=hello\n')
      const env: Record<string, string | undefined> = {
        LINEAR_API_KEY: 'from_real_env',
      }
      loadDotEnv(path, env)
      expect(env).toEqual({
        LINEAR_API_KEY: 'from_real_env',
        NEW_VAR: 'hello',
      })
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test('a missing file is a silent no-op', () => {
    const env: Record<string, string | undefined> = { FOO: 'bar' }
    loadDotEnv('/nonexistent/path/.env', env)
    expect(env).toEqual({ FOO: 'bar' })
  })
})
