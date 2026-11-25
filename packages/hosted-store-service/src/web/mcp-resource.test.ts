import { expect, test } from 'bun:test'
import {
  parseRepositoryMcpResource,
  repositoryFromMcpSuffix,
  repositoryFromMetadataPath,
  repositoryMcpResource,
  repositoryProtectedResourceMetadataURL,
} from './mcp-resource'

const ORIGIN = 'https://operator.example'
const REPO = 'https://github.com/owner/repo'

test('each repository has one stable, readable MCP URL that round-trips', () => {
  expect(repositoryMcpResource(`${ORIGIN}/mcp`, REPO)).toBe(`${ORIGIN}/mcp/github.com/owner/repo`)
  expect(repositoryProtectedResourceMetadataURL(ORIGIN, `${ORIGIN}/mcp`, REPO)).toBe(
    `${ORIGIN}/.well-known/oauth-protected-resource/mcp/github.com/owner/repo`,
  )
  // An AB_WEB_MCP_RESOURCE override moves the base, not the shape.
  expect(repositoryMcpResource('https://mcp.example/agents/', REPO)).toBe(
    'https://mcp.example/agents/github.com/owner/repo',
  )
  for (const repo of [REPO, 'https://git.example:8443/group/sub/repo']) {
    const url = repositoryMcpResource(`${ORIGIN}/mcp`, repo)
    expect(parseRepositoryMcpResource(`${ORIGIN}/mcp`, url)).toBe(repo)
    expect(
      repositoryFromMetadataPath(
        `${ORIGIN}/mcp`,
        new URL(repositoryProtectedResourceMetadataURL(ORIGIN, `${ORIGIN}/mcp`, repo)).pathname,
      ),
    ).toBe(repo)
  }
  expect(
    repositoryFromMetadataPath(
      `${ORIGIN}/mcp`,
      '/api/auth/.well-known/oauth-protected-resource/mcp/github.com/owner/repo',
    ),
  ).toBe(REPO)
})

test('non-canonical suffixes name no repository', () => {
  for (const suffix of [
    '',
    'github.com/owner/repo/',
    'github.com/owner/repo.git',
    'github.com/owner%2Frepo',
    'GitHub.com/owner/repo',
    'github.com',
    'git.example:443/owner/repo',
    'https://github.com/owner/repo',
    'github.com/owner/repo?x=1',
  ]) {
    expect(repositoryFromMcpSuffix(suffix), suffix).toBeUndefined()
  }
  expect(parseRepositoryMcpResource(`${ORIGIN}/mcp`, `${ORIGIN}/mcp`)).toBeUndefined()
  expect(
    parseRepositoryMcpResource(`${ORIGIN}/mcp`, 'https://elsewhere.example/mcp/github.com/o/r'),
  ).toBeUndefined()
  expect(
    repositoryFromMetadataPath(`${ORIGIN}/mcp`, '/.well-known/oauth-protected-resource/extra'),
  ).toBeUndefined()
})
