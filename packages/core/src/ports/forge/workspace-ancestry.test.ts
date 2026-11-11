import { describe, expect, test } from 'bun:test'
import { FakeForge } from './fake'
import { withWorkspaceAncestry } from './workspace-ancestry'
import type { Exec } from '../workspace/git-worktree'

const A = 'a'.repeat(40)
const D = 'd'.repeat(40)

function scripted(exitCodes: number[]): { exec: Exec; commands: string[][] } {
  const commands: string[][] = []
  const exec: Exec = async (cmd, opts) => {
    expect(opts.cwd).toBe('/workspace')
    commands.push(cmd)
    const exitCode = exitCodes.shift() ?? 0
    return { exitCode, stdout: '', stderr: exitCode > 1 ? `exit ${exitCode} detail` : '' }
  }
  return { exec, commands }
}

describe('withWorkspaceAncestry', () => {
  test('merge-base exit 0 and 1 answer directly, with no forge request', async () => {
    const raw = new FakeForge()
    let forgeCalls = 0
    raw.isCommitAncestor = async () => {
      forgeCalls++
      return true
    }
    const { exec, commands } = scripted([0, 1])
    const forge = withWorkspaceAncestry(raw, { exec, workspacePath: '/workspace' })
    expect(await forge.isCommitAncestor!(A, D)).toBe(true)
    expect(await forge.isCommitAncestor!(D, A)).toBe(false)
    expect(commands).toEqual([
      ['git', 'merge-base', '--is-ancestor', A, D],
      ['git', 'merge-base', '--is-ancestor', D, A],
    ])
    expect(forgeCalls).toBe(0)
  })

  test('a missing object fetches both commits by SHA once, then retries', async () => {
    const { exec, commands } = scripted([128, 0, 0])
    const forge = withWorkspaceAncestry(new FakeForge(), { exec, workspacePath: '/workspace' })
    expect(await forge.isCommitAncestor!(A, D)).toBe(true)
    expect(commands[1]).toEqual([
      'git',
      'fetch',
      '--no-tags',
      '--no-write-fetch-head',
      '--refmap=',
      'origin',
      A,
      D,
    ])
    expect(commands).toHaveLength(3)
  })

  test('a failed fetch or a still-missing object throws', async () => {
    const failedFetch = scripted([128, 128])
    await expect(
      withWorkspaceAncestry(new FakeForge(), {
        exec: failedFetch.exec,
        workspacePath: '/workspace',
      }).isCommitAncestor!(A, D),
    ).rejects.toThrow('workspace ancestry fetch failed (exit 128)')
    const stillMissing = scripted([128, 0, 128])
    await expect(
      withWorkspaceAncestry(new FakeForge(), {
        exec: stillMissing.exec,
        workspacePath: '/workspace',
      }).isCommitAncestor!(A, D),
    ).rejects.toThrow('workspace ancestry check failed (exit 128)')
  })

  test('invalid OIDs throw before running Git', async () => {
    const { exec, commands } = scripted([])
    const forge = withWorkspaceAncestry(new FakeForge(), { exec, workspacePath: '/workspace' })
    await expect(forge.isCommitAncestor!('main', D)).rejects.toThrow('invalid ancestry OID')
    expect(commands).toEqual([])
  })

  test('every other member passes through, and a forge without ancestry keeps none', async () => {
    const raw = new FakeForge()
    const { exec } = scripted([])
    const forge = withWorkspaceAncestry(raw, { exec, workspacePath: '/workspace' })
    expect(forge.name).toBe(raw.name)
    expect(forge.prAttachments).toBe(raw.prAttachments)
    raw.setPrState(1, { state: 'open', mergeable: true })
    expect(await forge.getPrState('/r', 1)).toMatchObject({ state: 'open' })
    const bare = Object.assign(Object.create(raw), { isCommitAncestor: undefined }) as FakeForge
    expect(
      withWorkspaceAncestry(bare, { exec, workspacePath: '/workspace' }).isCommitAncestor,
    ).toBeUndefined()
  })
})
