/**
 * Agent context over hosted MCP (#1225), in memory: initialize instructions
 * list each repository's skills and agent instructions, the context tools
 * and prompts serve the same text, prompt names stay unique when repository
 * labels collide, and context is read only on initialize and prompt
 * requests — never on tools/list or tools/call.
 */
import { testAccess } from '../testing/access'
import { testProjects } from '../testing/projects'
import { describe, expect, test } from 'bun:test'
import type { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { ErrorCode, type McpError } from '@modelcontextprotocol/sdk/types.js'
import {
  AGENT_CONTEXT_ARTIFACT,
  encodeAgentContext,
  type AgentContextRecord,
} from '@defrex/autobuild/testing'
import {
  authorizeFlow,
  authorizeWithDiscovery,
  baseEnv,
  buildApp,
  buildAuth,
  connectClient,
  discoverMetadata,
  dynamicRegister,
  perRepositoryURL,
  seedUser,
} from '../testing/mcp-oauth'

const DOTTED = 'https://github.com/acme/a.b'
const UNDERSCORED = 'https://github.com/acme/a_b'
const FRESH = 'https://github.com/acme/fresh'
const PROJECTS = [DOTTED, UNDERSCORED, FRESH]

function record(operate: string): AgentContextRecord {
  const text = (value: string) => ({ oid: `o-${value}`, bytes: value.length, text: value })
  return {
    version: 1,
    commit: 'a'.repeat(40),
    baseBranch: 'main',
    skills: [
      {
        name: 'ab-operate',
        paths: ['.agents/skills/ab-operate'],
        files: [
          {
            path: 'SKILL.md',
            ...text(`---\ndescription: ${operate}\n---\nRun ab pause my-build.`),
          },
        ],
      },
      {
        name: 'ab-spec',
        paths: ['.agents/skills/ab-spec'],
        files: [{ path: 'SKILL.md', ...text('---\ndescription: Write specs.\n---\nspec') }],
      },
    ],
    instructions: [
      { paths: ['AGENTS.md'], directory: '', ...text('Repository rules.'), imports: [] },
    ],
    imports: [],
    links: [],
    omitted: [],
  }
}

async function harness() {
  const env: Record<string, string> = { ...baseEnv, AB_WEB_REPOSITORIES: PROJECTS.join(',') }
  const auth = buildAuth(env)
  const delegated: string[] = []
  const { app, backing } = buildApp(env, auth, testAccess(env, testProjects(PROJECTS)), {
    projects: PROJECTS,
    onDelegate: (request) => delegated.push(decodeURIComponent(new URL(request.url).pathname)),
  })
  for (const repo of PROJECTS) await backing.ensureRepo(repo)
  for (const [repo, operate] of [
    [DOTTED, 'Operate the dotted repository.'],
    [UNDERSCORED, 'Operate the underscored repository.'],
  ] as const) {
    const encoded = encodeAgentContext(record(operate))
    await backing.putRepoArtifact(repo, {
      kind: AGENT_CONTEXT_ARTIFACT,
      content: encoded.content,
      metadata: { digest: encoded.digest },
    })
  }
  const { cookie } = await seedUser(auth, 'ada@example.com')
  const client = await dynamicRegister(app, await discoverMetadata(app))
  const tokens = await authorizeFlow(app, cookie, client)
  const contextReads = () => delegated.filter((path) => path.endsWith('/tools/context.list'))
  return {
    app,
    cookie,
    contextReads,
    deployment: () => connectClient(app, tokens, client),
    scoped: async (repo: string) => {
      const flow = await authorizeWithDiscovery(app, cookie, perRepositoryURL(repo))
      return connectClient(app, flow.tokens, flow.client, perRepositoryURL(repo))
    },
  }
}

async function callText(client: Client, name: string, args: Record<string, unknown>) {
  const result = await client.callTool({ name, arguments: args })
  expect(result.isError).toBeUndefined()
  return JSON.parse((result.content as { text: string }[])[0]!.text) as { text: string }
}

describe('agent context over hosted MCP', () => {
  test('instructions list each repository’s context; initialize alone reads it', async () => {
    const h = await harness()
    const deployment = await h.deployment()
    try {
      // One context.list per accessible repository, at initialize.
      expect(h.contextReads().length).toBe(PROJECTS.length)
      const instructions = deployment.getInstructions()!
      for (const repo of PROJECTS) expect(instructions).toContain(`### ${repo}`)
      expect(instructions).toContain('- ab-operate — Operate the dotted repository.')
      expect(instructions).toContain('Agent instructions: `AGENTS.md` (repository root).')
      expect(instructions).toContain('Before operating, load `ab-operate`')
      expect(instructions).toContain('Before filing or revising tickets, load `ab-spec`')
      expect(instructions).toContain(
        `${FRESH} has no captured agent context: serving the canonical skills bundled with Autobuild 0.0.0-test`,
      )
      expect(instructions).toContain('Agent instructions: absent (no captured record).')

      // tools/list and tools/call read no context.
      const before = h.contextReads().length
      await deployment.listTools()
      await deployment.callTool({ name: 'builds.list', arguments: { repo: DOTTED } })
      expect(h.contextReads().length).toBe(before)
    } finally {
      await deployment.close()
    }
  })

  test('a per-repository endpoint serves its own context, tools and prompts', async () => {
    const h = await harness()
    const scoped = await h.scoped(DOTTED)
    try {
      const instructions = scoped.getInstructions()!
      expect(instructions).toContain('Operate the dotted repository.')
      expect(instructions).not.toContain(UNDERSCORED)
      const tools = (await scoped.listTools()).tools
      for (const name of ['context.list', 'context.read']) {
        const tool = tools.find((candidate) => candidate.name === name)!
        expect(tool.inputSchema.properties?.repo, name).toBeUndefined()
      }
      const index = (await callText(scoped, 'context.list', {})) as unknown as {
        instructions: { path: string }[]
      }
      expect(index.instructions.map((entry) => entry.path)).toEqual(['AGENTS.md'])

      const { prompts } = await scoped.listPrompts()
      expect(prompts.map((prompt) => prompt.name)).toEqual(['ab-operate', 'ab-spec'])
      const prompt = await scoped.getPrompt({ name: 'ab-operate' })
      const read = await callText(scoped, 'context.read', {
        path: '.agents/skills/ab-operate/SKILL.md',
      })
      expect(read.text).toContain('`ab pause` → `builds.control`')
      expect(prompt.messages).toEqual([
        { role: 'user', content: { type: 'text', text: read.text } },
      ])
    } finally {
      await scoped.close()
    }
  })

  test('colliding repository labels get distinct prompts that read their own skill', async () => {
    const h = await harness()
    const deployment = await h.deployment()
    try {
      const { prompts } = await deployment.listPrompts()
      const operate = prompts.filter((prompt) => prompt.name.includes('.ab-operate'))
      expect(operate.map((prompt) => prompt.name)).toEqual([
        expect.stringMatching(/^github_com_acme_a_b\.ab-operate~[0-9a-f]{12}$/),
        expect.stringMatching(/^github_com_acme_a_b\.ab-operate~[0-9a-f]{12}$/),
        'github_com_acme_fresh.ab-operate',
      ])
      for (const repo of [DOTTED, UNDERSCORED]) {
        const prompt = operate.find((candidate) => candidate.description?.startsWith(repo))!
        const got = await deployment.getPrompt({ name: prompt.name })
        const read = await callText(deployment, 'context.read', {
          repo,
          path: '.agents/skills/ab-operate/SKILL.md',
        })
        expect(got.messages[0]!.content).toEqual({ type: 'text', text: read.text })
      }
      for (const name of ['github_com_acme_a_b.ab-operate', 'github_com_acme_a_b.ab-operate~0'])
        expect(await deployment.getPrompt({ name }).catch((error) => error)).toMatchObject({
          code: ErrorCode.InvalidParams,
        } satisfies Partial<McpError>)
    } finally {
      await deployment.close()
    }
  })
})
