import { expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MemoryBuildStore } from '../store/memory'
import { sampleBuildInput } from '../store/contract'
import { DISPATCHER, KERNEL } from '../events/envelope'
import { bunExec } from '../ports/forge/github'
import { gitRewrite } from '../ports/forge/git-rewrite'
import { FakeForge } from '../ports/forge/fake'
import { landIntoNode, settleClosedNode } from './node-landing'

for (const closed of [false, true])
  for (const receipt of [false, true]) {
    test(`${closed ? 'closed' : 'normal'} node recovery requires exact head or durable receipt, never candidate ancestry (receipt=${receipt})`, async () => {
      const cwd = await mkdtemp(join(tmpdir(), 'node-landing-readback-'))
      const git = async (...args: string[]) => {
        const r = await bunExec(['git', ...args], { cwd })
        if (r.exitCode) throw new Error(r.stderr)
        return r.stdout.trim()
      }
      try {
        await git('init', '-b', 'main')
        await git('config', 'user.name', 'Test')
        await git('config', 'user.email', 'test@example.com')
        await git('commit', '--allow-empty', '-m', 'parent')
        const expected = await git('rev-parse', 'HEAD')
        await git('commit', '--allow-empty', '-m', 'leaf\n\nAutobuild-Build: leaf')
        const candidate = await git('rev-parse', 'HEAD')
        await git('commit', '--allow-empty', '-m', 'external descendant')
        const actual = await git('rev-parse', 'HEAD')
        await git('branch', 'ab-node/node', actual)
        const store = new MemoryBuildStore()
        await store.createBuild(sampleBuildInput('node'))
        await store.createBuild(sampleBuildInput('leaf'))
        await store.append('node', {
          actor: DISPATCHER,
          type: 'node.opened',
          payload: { sha: expected },
        })
        await store.append('node', {
          actor: KERNEL,
          type: 'node.writer-reserved',
          payload: {
            id: 'landing',
            operation: 'landing',
            source: 'leaf',
            expected,
            parent: candidate,
            oldBase: expected,
            archive: `refs/autobuild/archive/node/${expected}`,
            changes: [],
            merges: [],
            upstreamBuilds: [],
          },
        })
        await store.append('node', {
          actor: KERNEL,
          type: 'node.publish-intended',
          payload: { id: 'landing', head: candidate },
        })
        if (receipt)
          await store.append('node', {
            actor: KERNEL,
            type: 'node.rewritten',
            payload: { id: 'landing', previous: expected, head: candidate },
          })
        const forge = new FakeForge()
        forge.rewrite = gitRewrite(bunExec, true)
        if (closed)
          await settleClosedNode({
            store,
            forge,
            exec: bunExec,
            workspacePath: cwd,
            slug: 'node',
            branch: 'ab-node/node',
            holder: 'holder',
          })
        else
          await landIntoNode({
            store,
            forge,
            exec: bunExec,
            workspacePath: cwd,
            slug: 'leaf',
            node: 'node',
            branch: 'ab/leaf',
            destination: 'ab-node/node',
            pr: 1,
            holder: 'holder',
            id: 'landing',
            eligible: async () => false,
          })
        expect((await store.getEvents('leaf')).some((e) => e.type === 'pr.merged')).toBe(receipt)
        expect(
          (await store.getEvents('node')).filter((e) => e.type === 'node.rewritten'),
        ).toHaveLength(receipt ? 1 : 0)
        expect(await git('rev-parse', 'ab-node/node')).toBe(actual)
      } finally {
        await rm(cwd, { recursive: true, force: true })
      }
    })
  }
