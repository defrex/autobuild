import { afterAll, beforeAll, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { bunExec } from '../ports/forge/github'
import {
  inspectIntegrationStack,
  IntegrationStackViolation,
  type IntegrationStackRule,
} from './integration-stack'

let cwd: string
let opened: string
const git = async (...args: string[]) => {
  const r = await bunExec(['git', ...args], { cwd })
  if (r.exitCode) throw new Error(r.stderr)
  return r.stdout.trim()
}
/** Commit on a fresh branch from `from`, returning the new head. */
const commit = async (from: string, message: string) => {
  await git('checkout', '-q', '--detach', from)
  await git('commit', '-q', '--allow-empty', '-m', message)
  return git('rev-parse', 'HEAD')
}
const inspect = (parent: string, head: string, contributionBase?: string) =>
  inspectIntegrationStack(bunExec, cwd, parent, head, { contributionBase })
async function violation(
  promise: Promise<unknown>,
  rule: IntegrationStackRule,
  sha?: string,
): Promise<IntegrationStackViolation> {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e,
  )
  expect(error).toBeInstanceOf(IntegrationStackViolation)
  const v = error as IntegrationStackViolation
  expect(v.rule).toBe(rule)
  expect(v.sha).toBe(sha)
  return v
}

beforeAll(async () => {
  cwd = await mkdtemp(join(tmpdir(), 'integration-stack-'))
  await git('init', '-q', '-b', 'main')
  await git('config', 'user.name', 'Test')
  await git('config', 'user.email', 'test@example.com')
  await git('commit', '-q', '--allow-empty', '-m', 'base')
  opened = await commit('HEAD', 'opened')
})
afterAll(async () => {
  await rm(cwd, { recursive: true, force: true })
})

test('verified hand-pushed commits land between and after child contributions', async () => {
  const first = await commit(opened, 'first\n\nAutobuild-Build: first-child')
  const tweak = await commit(first, 'maintainer tweak')
  const second = await commit(tweak, 'second\n\nAutobuild-Build: second-child')
  const tip = await commit(second, 'tip tweak')
  expect(await inspect(opened, tip, opened)).toEqual({
    builds: ['first-child', 'second-child'],
    handPushed: [tweak, tip],
  })
  expect(await inspect(opened, second, opened)).toEqual({
    builds: ['first-child', 'second-child'],
    handPushed: [tweak],
  })
})

test('a hand-pushed-only range lands without contributing identities', async () => {
  const tweak = await commit(opened, 'only tweak')
  expect(await inspect(opened, tweak, opened)).toEqual({ builds: [], handPushed: [tweak] })
})

test('a trailer-less commit outside node ownership is refused', async () => {
  const tweak = await commit(opened, 'unowned tweak')
  const child = await commit(tweak, 'child\n\nAutobuild-Build: owned-child')
  await violation(inspect(opened, child), 'unowned-commit', tweak)
  // The contribution boundary sits above the commit: it is in range but not node-owned.
  const v = await violation(inspect(opened, child, tweak), 'unowned-commit', tweak)
  expect(v.message).toContain(tweak)
  expect(v.parent).toBe(opened)
  expect(v.head).toBe(child)
})

test('several or repeated build identities are refused', async () => {
  const both = await commit(opened, 'both\n\nAutobuild-Build: a-child\nAutobuild-Build: b-child')
  await violation(inspect(opened, both, opened), 'ambiguous-identity', both)
  const first = await commit(opened, 'one\n\nAutobuild-Build: same-child')
  const again = await commit(first, 'two\n\nAutobuild-Build: same-child')
  await violation(inspect(opened, again, opened), 'duplicate-identity', again)
})

test('merge commits, non-ancestor parents and empty ranges are refused', async () => {
  const left = await commit(opened, 'left\n\nAutobuild-Build: left-child')
  const right = await commit(opened, 'right\n\nAutobuild-Build: right-child')
  await git('checkout', '-q', '--detach', left)
  await git('merge', '-q', '--no-ff', '-m', 'merge', right)
  const merge = await git('rev-parse', 'HEAD')
  await violation(inspect(opened, merge, opened), 'merge-commit', merge)
  await violation(inspect(left, right, opened), 'not-fast-forward')
  await violation(inspect(opened, opened, opened), 'empty-range')
})

test('git failures stay retryable rather than structural', async () => {
  const child = await commit(opened, 'child\n\nAutobuild-Build: retry-child')
  const error = await inspect(opened, child, 'f'.repeat(40)).then(
    () => undefined,
    (e: unknown) => e,
  )
  expect(error).toBeInstanceOf(Error)
  expect(error).not.toBeInstanceOf(IntegrationStackViolation)
  const missing = await inspect('e'.repeat(40), child, opened).then(
    () => undefined,
    (e: unknown) => e,
  )
  expect(missing).toBeInstanceOf(Error)
  expect(missing).not.toBeInstanceOf(IntegrationStackViolation)
})
