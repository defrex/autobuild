import { expect, test } from 'bun:test'
import { TOOLS } from '../../../packages/core/src/operator/registry'
import { checkMcpCorpus, generateMcpCorpus } from './mcp-fixtures'

test('MCP corpus pins the actual SDK descriptors and every advertised tool', async () => {
  const corpus = await generateMcpCorpus()
  expect(corpus.tools.map((t) => t.name).sort()).toEqual(
    [...TOOLS.map((t) => t.name), 'repositories.list'].sort(),
  )
  expect(corpus.coverage.missing).toEqual([])
  await checkMcpCorpus()
})
test('MCP drift checks retain transport errors, descriptions and annotations', async () => {
  const corpus = await generateMcpCorpus()
  corpus.tools[0]!.name = 'changed'
  await expect(checkMcpCorpus(corpus)).rejects.toThrow('MCP corpus drifted')
})
