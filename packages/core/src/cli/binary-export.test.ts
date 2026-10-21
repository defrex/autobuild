import { expect, test } from 'bun:test'
import { mkdtemp, mkdir, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

for (const existing of [false, true]) {
  test(`single SIGINT cancels a waiting Linear export (${existing ? 'empty' : 'absent'} destination)`, async () => {
    const root = await mkdtemp(join(tmpdir(), 'binary-export-'))
    const destination = join(root, 'export')
    let child: ReturnType<typeof Bun.spawn> | undefined
    try {
      if (existing) await mkdir(destination)
      await writeFile(
        join(root, 'autobuild.toml'),
        '[tickets]\nsource = "linear"\nteamKey = "ENG"\nreadyState = "Ready"\n',
      )
      await Bun.$`git init ${root}`.quiet()
      const preload = join(root, 'fetch.ts')
      await writeFile(
        preload,
        `
        globalThis.fetch = async (url) => {
          if (String(url) !== 'https://api.linear.app/graphql') throw new Error('unexpected URL ' + url)
          return new Response(JSON.stringify({ errors: [{ message: 'limit', extensions: { code: 'RATELIMITED' } }] }), {
            status: 400, headers: { 'x-ratelimit-requests-reset': String(Date.now() + 60000) }
          })
        }
      `,
      )
      const env: Record<string, string | undefined> = {
        ...process.env,
        LINEAR_API_KEY: 'fixture',
        AB_STORE: join(root, 'store'),
        XDG_CONFIG_HOME: join(root, 'config'),
      }
      for (const key of Object.keys(env))
        if (key.startsWith('AB_') && key !== 'AB_STORE') delete env[key]
      child = Bun.spawn(
        [
          process.execPath,
          '--preload',
          preload,
          resolve('bin/ab.ts'),
          'ticket',
          'export',
          destination,
        ],
        { cwd: root, env, stdout: 'pipe', stderr: 'pipe' },
      )
      const reader = (child.stdout as ReadableStream<Uint8Array>).getReader()
      let output = ''
      const guard = setTimeout(() => child?.kill('SIGKILL'), 15_000)
      try {
        for (;;) {
          const chunk = await reader.read()
          if (chunk.done)
            throw new Error(
              `exited before wait: ${output}\n${await new Response(child.stderr as ReadableStream<Uint8Array>).text()}`,
            )
          output += new TextDecoder().decode(chunk.value)
          if (output.includes('waiting until')) break
        }
        expect(await readdir(destination).catch(() => [])).toEqual([])
        child.kill('SIGINT')
        const code = await child.exited
        for (;;) {
          const chunk = await reader.read()
          if (chunk.done) break
          output += new TextDecoder().decode(chunk.value)
        }
        expect(code).not.toBe(0)
        expect(output).not.toContain('exported')
        expect(await readdir(destination).catch(() => [])).toEqual([])
        expect((await readdir(root)).filter((name) => name.endsWith('.tmp'))).toEqual([])
      } finally {
        clearTimeout(guard)
      }
    } finally {
      child?.kill()
      await rm(root, { recursive: true, force: true })
    }
  }, 20_000)
}
