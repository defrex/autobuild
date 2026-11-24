import { temporaryDirectories as ownTempDirectories } from '@defrex/autobuild/testing'
import { afterEach, expect, test } from 'bun:test'
import {
  AUTOBUILD_VERSION,
  AUTOBUILD_VERSION_HEADER,
  REMOTE_STORE_PROTOCOL_VERSION,
  REMOTE_STORE_PROTOCOL_VERSION_HEADER,
} from '@defrex/autobuild/remote-store'
import { testCredentials } from './testing/credentials'
import { testProjects } from './testing/projects'
import { createStoreServer } from './remote-store-server'
import { MemoryBuildStore, sampleEventWrite } from '@defrex/autobuild/plugin-sdk'
import { createMachineAuth } from './machine-auth'
import { createDelegationHandler } from './delegated-authority'

// The in-memory machine-auth matrix lives in machine-auth.test.ts; this file
// keeps the case that needs a real git workspace.

const mkdtemp = ownTempDirectories(afterEach)

const A = 'https://github.com/acme/a'
const request = (path: string, token: string, body?: unknown) =>
  new Request(`http://store${path}`, {
    headers: {
      [AUTOBUILD_VERSION_HEADER]: AUTOBUILD_VERSION,
      [REMOTE_STORE_PROTOCOL_VERSION_HEADER]: REMOTE_STORE_PROTOCOL_VERSION,
      authorization: `Bearer ${token}`,
    },
    ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }),
  })

test('node verifier hydrates prepared inputs with a server-issued build token', async () => {
  const { RemoteBuildStore } = await import('@defrex/autobuild/remote-store')
  const { buildContext } = await import('@defrex/autobuild/testing')
  const { scopeLocalStoreToPhaseSession } = await import('@defrex/autobuild/testing')
  const { prepareNodeVerificationContext, NODE_VERIFICATION_CONTEXT } = await import(
    '@defrex/autobuild/testing'
  )
  const { spawnExec } = await import('@defrex/autobuild/testing')
  const { DISPATCHER, KERNEL } = await import('@defrex/autobuild/testing')
  const { rm, readFile } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const workspace = await mkdtemp(join(tmpdir(), 'node-remote-context-'))
  const git = async (...args: string[]) => {
    const result = await spawnExec(['git', ...args], { cwd: workspace })
    if (result.exitCode) throw new Error(result.stderr)
    return result.stdout.trim()
  }
  const projects = testProjects([A])
  const { store: credentials } = testCredentials(projects)
  const owner = await credentials.issue(A, 'owner')
  const backing = new MemoryBuildStore()
  const auth = createMachineAuth({ secret: 'secret', projects, credentials, store: backing })
  const server = createStoreServer({ store: backing, auth })
  const fetchFn = ((input: string | URL | Request, init?: RequestInit) =>
    server.fetch(new Request(input, init))) as typeof fetch
  const project = new RemoteBuildStore({ url: 'http://store', token: owner.token, fetchFn })
  try {
    await Bun.write(
      join(workspace, 'autobuild.toml'),
      '[tickets]\nsource = "file"\nreadyState = "ready"\n[verify]\nsteps = ["visual"]\n[verify.visual]\nkind = "agent"\nskill = "visual"\n',
    )
    await git('init')
    await git('config', 'user.email', 'test@example.com')
    await git('config', 'user.name', 'Test')
    await git('commit', '--allow-empty', '-m', 'base')
    const base = await git('rev-parse', 'HEAD')
    const records = []
    for (const kind of ['node', 'work'] as const) {
      const record = await project.createBuild({
        slug: kind,
        repo: A,
        ticket: { source: 'file', id: kind },
      })
      records.push(record)
      await project.append(record.slug, {
        actor: DISPATCHER,
        type: 'build.created',
        payload: { repo: A, kind, ticket: { source: 'file', id: kind }, baseBranch: 'main' },
      })
      await project.appendWithArtifacts(
        record.slug,
        [{ kind: 'spec', content: `spec for ${kind}` }],
        ([artifact]) => ({
          actor: DISPATCHER,
          type: 'spec.imported',
          payload: {
            ticket: { source: 'file', id: kind },
            artifact: { kind: 'spec', rev: artifact!.revision },
          },
        }),
      )
    }
    const node = records[0]!,
      child = records[1]!
    await git('commit', '--allow-empty', '-m', `child\n\nAutobuild-Build: ${child.slug}`)
    const head = await git('rev-parse', 'HEAD')
    await project.append(node.slug, {
      actor: DISPATCHER,
      type: 'node.opened',
      payload: { sha: base },
    })
    const cycle = { id: 'cycle', parent: base, head }
    const content = await prepareNodeVerificationContext(
      project,
      A,
      cycle,
      { nodeOpened: { sha: base } },
      { exec: spawnExec, workspacePath: workspace },
    )
    await project.appendWithArtifacts(
      node.slug,
      [{ kind: NODE_VERIFICATION_CONTEXT, content }],
      ([artifact]) => ({
        actor: KERNEL,
        type: 'integration.prepared',
        payload: {
          ...cycle,
          config: 'config',
          context: { kind: NODE_VERIFICATION_CONTEXT, rev: artifact!.revision },
        },
      }),
    )
    const delegate = createDelegationHandler({ secret: 'secret', auth, store: backing })
    const response = await delegate(
      request('/credentials/delegate', owner.token, { kind: 'build-runner', id: node.slug }),
    )
    expect(response.status).toBe(200)
    const token = (await response.json()).token
    const guest = new RemoteBuildStore({ url: 'http://store', token, fetchFn })
    const scoped = scopeLocalStoreToPhaseSession(guest.scopeBuild(node.slug), {
      kind: 'build',
      id: node.slug,
      session: 's_test',
    })
    const manifest = await buildContext({
      store: scoped,
      env: {
        store: 'http://store',
        build: node.slug,
        phase: 'verify:visual',
        round: 1,
        session: 's_test',
      },
      workspacePath: workspace,
      exec: spawnExec,
    })
    expect(
      await readFile(
        join(workspace, manifest.nodeVerification!.contributions[0]!.specPath),
        'utf8',
      ),
    ).toBe('spec for work')
    await expect(scoped.getBuild(child.slug)).rejects.toThrow()
    await expect(scoped.getArtifact(child.slug, 'spec', 0)).rejects.toThrow()
    await expect(scoped.getEvents(child.slug)).rejects.toThrow()
    await expect(
      guest.putArtifact(child.slug, { kind: 'spec', content: 'forbidden' }),
    ).rejects.toThrow()
    await expect(guest.append(child.slug, sampleEventWrite())).rejects.toThrow()
    expect(await backing.listArtifacts(child.slug, 'spec')).toHaveLength(1)
  } finally {
    await rm(workspace, { recursive: true, force: true })
  }
})
