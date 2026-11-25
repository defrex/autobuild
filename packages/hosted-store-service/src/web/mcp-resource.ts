/**
 * Per-repository MCP URLs (#1224). Every registered project on a hosted
 * deployment has its own MCP resource: the deployment resource plus the
 * repository identity with its scheme removed.
 *
 *   identity  https://github.com/defrex/autobuild
 *   MCP URL   <mcpResource>/github.com/defrex/autobuild
 *   PRM       <baseURL>/.well-known/oauth-protected-resource/mcp/github.com/defrex/autobuild
 *
 * The URL depends only on the identity and the deployment resource, so it is
 * stable across deploys and sign-ins. The inverse accepts a suffix only when
 * `https://<suffix>` is already the canonical identity, so each project has
 * exactly one URL: a trailing slash, `.git`, an encoded character or an empty
 * suffix maps to no repository.
 *
 * Pure apart from the identity normalizer; safe to import from a server
 * component.
 */
import { normalizeConnectionRepository } from '@defrex/autobuild/connection'

/** Verification-table identifier prefix for a token's resource binding. */
export const MCP_RESOURCE_BINDING_PREFIX = 'ab-mcp-resource:'

const PRM_PATH = '/.well-known/oauth-protected-resource'

/** The per-repository path suffix: the identity's host and path. */
export function repositoryMcpSuffix(repo: string): string {
  const url = new URL(repo)
  return `${url.host}${url.pathname}`
}

/** The per-repository MCP resource (the URL a connector is added with). */
export function repositoryMcpResource(mcpResource: string, repo: string): string {
  return `${mcpResource.replace(/\/$/, '')}/${repositoryMcpSuffix(repo)}`
}

/** The repository a per-repository suffix names, or undefined unless the
 * suffix is exactly the canonical form of a repository identity. */
export function repositoryFromMcpSuffix(suffix: string): string | undefined {
  if (suffix === '' || suffix.includes('%') || suffix.endsWith('/')) return undefined
  const candidate = `https://${suffix}`
  try {
    return normalizeConnectionRepository(candidate) === candidate ? candidate : undefined
  } catch {
    return undefined
  }
}

/** The repository a per-repository resource URL names, or undefined when the
 * URL is not a canonical per-repository resource under `mcpResource`. */
export function parseRepositoryMcpResource(mcpResource: string, url: string): string | undefined {
  const prefix = `${mcpResource.replace(/\/$/, '')}/`
  if (!url.startsWith(prefix)) return undefined
  return repositoryFromMcpSuffix(url.slice(prefix.length))
}

/** The RFC 9728 path-inserted protected-resource metadata URL for a
 * resource, served from the deployment origin. */
export function protectedResourceMetadataURL(baseURL: string, resource: string): string {
  const path = new URL(resource).pathname.replace(/\/$/, '')
  return `${baseURL}${PRM_PATH}${path}`
}

/** The per-repository protected-resource metadata URL. */
export function repositoryProtectedResourceMetadataURL(
  baseURL: string,
  mcpResource: string,
  repo: string,
): string {
  return protectedResourceMetadataURL(baseURL, repositoryMcpResource(mcpResource, repo))
}

/** The repository named by a protected-resource metadata sub-path
 * (`/.well-known/oauth-protected-resource<resource path>/<suffix>`), or
 * undefined. `pathname` may carry the `/api/auth` mount prefix. */
export function repositoryFromMetadataPath(
  mcpResource: string,
  pathname: string,
): string | undefined {
  const path = pathname.startsWith('/api/auth/') ? pathname.slice('/api/auth'.length) : pathname
  const resourcePath = new URL(mcpResource).pathname.replace(/\/$/, '')
  const prefix = `${PRM_PATH}${resourcePath}/`
  if (!path.startsWith(prefix)) return undefined
  return repositoryFromMcpSuffix(path.slice(prefix.length))
}

/** Whether `pathname` is a protected-resource metadata sub-path (anything
 * below the root document, with or without the `/api/auth` mount). */
export function isMetadataSubPath(pathname: string): boolean {
  const path = pathname.startsWith('/api/auth/') ? pathname.slice('/api/auth'.length) : pathname
  return path.startsWith(`${PRM_PATH}/`)
}
