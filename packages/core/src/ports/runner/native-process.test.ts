import { expect, test } from 'bun:test'
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import type { AgentTurnResult, NativeSessionHandle, Transcript } from '../types'
import { ClaudeAgentRunner } from './claude'
import { CodexAgentRunner } from './codex'
import { runNativeAdapterChild } from './live-contract-fixture'

for (const provider of ['claude', 'codex', 'pi'])
  test(`${provider}: separate adapter processes retain native memory with fresh environment`, async () => {
    const root = await mkdtemp(join(tmpdir(), 'ab-native-process-'))
    try {
      const bin = join(root, 'bin')
      const cwd = join(root, 'workspace')
      const state = join(root, 'native')
      await Promise.all([mkdir(bin), mkdir(cwd), mkdir(state)])
      const executable = join(bin, provider)
      await writeFile(
        executable,
        `#!/bin/sh\nexec '${process.execPath}' '${new URL('./native-cli-fixture.ts', import.meta.url).pathname}' "$@"\n`,
      )
      await chmod(executable, 0o755)
      const env = {
        PATH: `${bin}:${process.env.PATH}`,
        AB_NATIVE_FIXTURE_PROVIDER: provider,
        AB_NATIVE_FIXTURE_STATE: state,
      }
      const secret = crypto.randomUUID()
      const opts = { skill: 'ab-probe', invocation: secret, workspacePath: cwd, env }
      const handle = (await runNativeAdapterChild({ provider, opts })) as NativeSessionHandle
      expect(JSON.stringify(handle)).not.toContain(secret)
      const result = (await runNativeAdapterChild({
        provider,
        handle,
        opts: { ...opts, invocation: 'resume', env: { ...env, NATIVE_CONTRACT_FRESH: 'fresh' } },
        message: 'recall',
      })) as { result: AgentTurnResult; handle: NativeSessionHandle; transcript: Transcript }
      expect(result.handle).toEqual(handle)
      expect(result.result.kind).toBe('completed')
      expect(result.result.text).toBe(`${secret} fresh`)
      expect(result.transcript.metadata.usage.turns).toBe(1)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

for (const provider of ['claude', 'codex'] as const)
  test(`${provider}: production subprocess reports identity before a blocked turn ends without a UI stream`, async () => {
    const root = await mkdtemp(join(tmpdir(), 'ab-native-latency-'))
    const release = join(root, 'release')
    try {
      const executable = join(root, provider)
      await writeFile(
        executable,
        `#!/bin/sh\nexec '${process.execPath}' '${new URL('./native-cli-fixture.ts', import.meta.url).pathname}' "$@"\n`,
      )
      await chmod(executable, 0o755)
      const runner = provider === 'claude' ? new ClaudeAgentRunner() : new CodexAgentRunner()
      let observed!: (handle: NativeSessionHandle) => void
      const observation = new Promise<NativeSessionHandle>((resolve) => {
        observed = resolve
      })
      const pending = runner.start({
        skill: 'probe',
        invocation: 'memory',
        workspacePath: root,
        env: {
          PATH: `${root}:${process.env.PATH}`,
          AB_NATIVE_FIXTURE_PROVIDER: provider,
          AB_NATIVE_FIXTURE_STATE: root,
          AB_NATIVE_FIXTURE_RELEASE: release,
        },
        onNativeSession: async (handle) => {
          observed(handle)
        },
      })
      try {
        expect((await observation).runner).toBe(provider)
      } finally {
        await writeFile(release, '')
      }
      const started = await pending
      expect(started.result.kind).toBe('completed')
      await runner.end(started.session)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

for (const kind of ['claude-subscription', 'kimi-code'] as const)
  test(`${kind}: actual local argv excludes credentials and cancellation cleans settings`, async () => {
    const root = await mkdtemp(join(tmpdir(), 'ab-protected-account-'))
    const controller = new AbortController()
    let pending: ReturnType<ClaudeAgentRunner['start']> | undefined
    let settingsPath: string | undefined
    let childPid: string | undefined
    try {
      const fixture = join(root, 'fixture.ts')
      await writeFile(
        fixture,
        `
        import { readFileSync } from 'node:fs'
        const args = process.argv.slice(2)
        const path = args[args.indexOf('--settings') + 1]
        const settings = JSON.parse(readFileSync(path, 'utf8'))
        const secret = process.env.SELECTED_SECRET
        const key = process.env.TEST_AUTH_KEY
        const ok = settings.env[key] === secret && process.env[key] === secret &&
          !args.join(' ').includes(secret) && settings.apiKeyHelper === ''
        console.log(JSON.stringify({type: 'system', session_id: 'protected-child', ok}))
        setInterval(() => {}, 1000)
      `,
      )
      await writeFile(
        join(root, 'claude'),
        `#!/bin/sh\nexec '${process.execPath}' '${fixture}' "$@"\n`,
        { mode: 0o755 },
      )
      let observed!: () => void
      const ready = new Promise<void>((resolve) => {
        observed = resolve
      })
      const { readFile, readdir, access } = await import('node:fs/promises')
      const runner = new ClaudeAgentRunner()
      pending = runner.start({
        skill: 'probe',
        invocation: 'offline',
        workspacePath: root,
        account: {
          name: 'offline',
          descriptor:
            kind === 'kimi-code'
              ? { kind, credentialEnv: 'SELECTED_SECRET', region: 'overseas' }
              : { kind, credentialEnv: 'SELECTED_SECRET' },
        },
        env: {
          PATH: `${root}:${process.env.PATH}`,
          SELECTED_SECRET: 'synthetic-child-token',
          TEST_AUTH_KEY: kind === 'kimi-code' ? 'ANTHROPIC_API_KEY' : 'CLAUDE_CODE_OAUTH_TOKEN',
          AB_ACCOUNT_PLACEHOLDERS: '0',
          AB_BUILD_RUNNER_OPTIONS: '',
          AB_HARVEST_RUNNER_OPTIONS: '',
        },
        signal: controller.signal,
        onNativeSession: async () => {
          observed()
        },
      })
      await Promise.race([
        ready,
        pending.then(() => {
          throw new Error('child exited before observation')
        }),
        Bun.sleep(5000).then(() => {
          throw new Error('child observation timed out')
        }),
      ])
      if (process.platform === 'linux') {
        const matches = await Promise.all(
          (await readdir('/proc'))
            .filter((id) => /^\d+$/.test(id))
            .map(async (id) => {
              const raw = await readFile(`/proc/${id}/cmdline`, 'utf8').catch(() => '')
              return raw.split('\0').includes(fixture) ? { id, raw } : undefined
            }),
        )
        const child = matches.find((value) => value !== undefined)!
        expect(child).toBeDefined()
        childPid = child.id
        const argv = child.raw
        expect(argv).not.toContain('synthetic-child-token')
        const args = argv.split('\0')
        settingsPath = args[args.indexOf('--settings') + 1]!
        expect(JSON.parse(await readFile(settingsPath, 'utf8')).apiKeyHelper).toBe('')
      }
      controller.abort(new Error('offline cancellation'))
      await pending
      const transcript = await runner.end((await pending).session)
      expect(JSON.stringify(transcript)).not.toContain('synthetic-child-token')
      expect(transcript.content).toContain('"ok": true')
      if (settingsPath) {
        expect(
          await access(settingsPath).then(
            () => true,
            () => false,
          ),
        ).toBe(false)
        expect(
          await access(dirname(settingsPath)).then(
            () => true,
            () => false,
          ),
        ).toBe(false)
      }
      if (childPid)
        expect(
          await access(`/proc/${childPid}`).then(
            () => true,
            () => false,
          ),
        ).toBe(false)
    } finally {
      controller.abort()
      await pending?.catch(() => {})
      await rm(root, { recursive: true, force: true })
    }
  })
