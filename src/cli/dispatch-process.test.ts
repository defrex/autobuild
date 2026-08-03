import { expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { abDispatch } from './dispatch'
import { resolveRepoState } from './repo-state'
import { openStoreForRepoState } from './store-opening'
import { createTerminalModeController } from './terminal-restore'
import { spawnExec } from '../ports/workspace/git-worktree'
import { GIT_ID, git } from '../integration/harness'

test('interactive production dispatch runs the kernel in a distinct supervised process', async () => {
  const repo = await mkdtemp(join(tmpdir(), 'ab-dispatch-process-'))
  try {
    await git(['init', '-q', '-b', 'main'], repo)
    await mkdir(join(repo, 'tickets', 'ready'), { recursive: true })
    await writeFile(
      join(repo, 'autobuild.toml'),
      `baseBranch = "main"
capacity = 2

[roles.default]
runtime = "claude"

[tickets]
source = "file"
dir = "tickets"
readyState = "ready"
`,
    )
    await writeFile(join(repo, 'README.md'), 'fixture\n')
    await git(['add', '-A'], repo)
    await git([...GIT_ID, 'commit', '-q', '-m', 'fixture'], repo)

    let output = ''
    const write = (chunk: string): void => {
      output += chunk
    }
    await abDispatch({
      targetRepo: repo,
      env: {},
      exec: spawnExec,
      stdout: () => {},
      stderr: () => {},
      once: true,
      terminal: {
        write,
        modes: createTerminalModeController(write, write),
        columns: 80,
        rows: 24,
        interactive: true,
      },
      input: { start: () => () => {} },
    })

    const state = await resolveRepoState({ targetRepo: repo, exec: spawnExec })
    const opened = openStoreForRepoState(state, { env: {} })
    try {
      const events = await opened.store.getRepoEvents(state.repo)
      const started = events.find((event) => event.type === 'dispatcher.run-started')
      expect(started?.type).toBe('dispatcher.run-started')
      if (started?.type !== 'dispatcher.run-started') throw new Error('missing run start')
      expect(started.payload.pid).not.toBe(process.pid)
      expect(events.some((event) => event.type === 'dispatcher.tick-completed')).toBe(true)
      expect(
        events.some(
          (event) => event.type === 'dispatcher.run-stopped' && event.payload.outcome === 'normal',
        ),
      ).toBe(true)
      const artifact = await opened.store.getRepoArtifact(
        state.repo,
        started.payload.effectiveConfig.kind,
        started.payload.effectiveConfig.rev,
      )
      expect(artifact).not.toBeNull()
      expect(output).toContain('active 0/2')
    } finally {
      await opened.store.close()
    }
  } finally {
    await rm(repo, { recursive: true, force: true })
  }
}, 20_000)
