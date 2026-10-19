import { expect, test } from 'bun:test'
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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
