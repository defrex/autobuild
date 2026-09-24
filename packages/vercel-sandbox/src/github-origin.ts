/**
 * Pure GitHub origin validation for the remote workspace provider. String
 * logic only — no SDK, no git, no provider module — so capability declarations
 * can reference it without pulling the provider implementation into import
 * graphs that must stay light.
 */
import { basename } from 'node:path'

export function validateVercelGithubOrigin(raw: string): {
  url: string
  host: string
  path: string
  directory: string
} {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new Error('vercel-sandbox requires an HTTPS GitHub origin')
  }
  if (url.protocol !== 'https:' || url.hostname.toLowerCase() !== 'github.com') {
    throw new Error('vercel-sandbox requires an HTTPS github.com origin')
  }
  url.username = ''
  url.password = ''
  url.search = ''
  url.hash = ''
  const path = url.pathname.replace(/\.git$/, '').replace(/^\//, '')
  if (!/^[^/]+\/[^/]+$/.test(path)) throw new Error('GitHub origin must name owner/repository')
  return {
    url: `https://github.com/${path}.git`,
    host: 'github.com',
    path: `/${path}.git`,
    directory: basename(path),
  }
}
