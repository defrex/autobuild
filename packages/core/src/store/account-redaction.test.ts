import { expect, test } from 'bun:test'
import { AccountRedactor, redactAccountStore } from './account-redaction'
import { MemoryBuildStore } from './memory'
import { KERNEL } from '../events/envelope'
import { createSessionStreamSink } from './streams/session-writer'
import { toolInputPart, toolOutputPart } from '../ports/runner/stream-parts'

test('real write interfaces redact events, atomic artifacts, binary content and split stream deltas across rotation', async () => {
  let current = 'sentinel-account-old-credential'
  const raw = new MemoryBuildStore()
  await raw.createBuild({ slug: 'b', repo: 'repo' })
  const store = redactAccountStore(raw, new AccountRedactor(() => [current]))
  await store.appendWithArtifacts('b', [{ kind: 'evidence', content: current }], () => ({
    actor: KERNEL,
    type: 'phase.failed',
    payload: { phase: 'implement', error: current, attempt: 1, willRetry: false },
  }))
  const old = current
  current = 'sentinel-account-new-credential'
  await store.putArtifact('b', {
    kind: 'binary',
    content: new TextEncoder().encode(`before ${old} ${current} after`),
  })
  const sink = createSessionStreamSink({
    store,
    scope: { kind: 'build', build: 'b' },
    flushMs: 100_000,
  })
  const stream = await sink.open('test')
  sink.append([
    { type: 'text-start', id: 't' },
    { type: 'text-delta', id: 't', delta: current.slice(0, 11) },
  ])
  await sink.flush()
  sink.append([
    { type: 'text-delta', id: 't', delta: current.slice(11) },
    { type: 'text-end', id: 't' },
  ])
  sink.append([toolInputPart('call', 'echo', {}), toolOutputPart('call', { [current]: old })])
  await sink.close('completed')
  const events = JSON.stringify(await raw.getEvents('b'))
  const artifacts = await raw.listArtifacts('b')
  const blobs = await Promise.all(
    artifacts.map(async (meta) => {
      const artifact = await raw.getArtifact('b', meta.kind)
      return artifact ? new TextDecoder().decode(artifact.content) : ''
    }),
  )
  const parts = await raw.readStream(stream)
  const evidence = events + blobs.join('') + JSON.stringify(parts)
  expect(evidence).not.toContain(old)
  expect(evidence).not.toContain(current)
  expect(evidence).toContain('[REDACTED]')
})

test('redacting a byte artifact does not mutate the source buffer', async () => {
  const secret = 'sentinel-buffer-credential'
  const raw = new MemoryBuildStore()
  await raw.createBuild({ slug: 'b', repo: 'repo' })
  const store = redactAccountStore(raw, new AccountRedactor(() => [secret]))
  const content = Buffer.from(secret)
  await store.putArtifact('b', { kind: 'bytes', content })
  expect(content.toString()).toBe(secret)
  expect(new TextDecoder().decode((await raw.getArtifact('b', 'bytes'))!.content)).not.toContain(
    secret,
  )
})

import { sensitiveAccountValues } from '../accounts/sensitive'
import { accountRedactor } from './account-redaction'
test('host token registry excludes old/new access, rotating refresh, ID tokens and capabilities from actual persistence and logs', async () => {
  const tokens = [
    'sentinel-access-before',
    'sentinel-access-after',
    'sentinel-refresh-before',
    'sentinel-refresh-after',
    'sentinel-retained-id',
    'sentinel-local-capability',
  ]
  const raw = new MemoryBuildStore()
  await raw.createBuild({ slug: 'chatgpt-redaction', repo: 'repo' })
  const redactor = accountRedactor(() => ({}), {})
  const store = redactAccountStore(raw, redactor)
  for (const token of tokens) sensitiveAccountValues.add(token)
  const diagnostic = JSON.stringify({ error: { description: tokens.join(' ') } })
  await store.appendWithArtifacts(
    'chatgpt-redaction',
    [{ kind: 'transcript', content: diagnostic }],
    () => ({
      actor: KERNEL,
      type: 'phase.failed',
      payload: { phase: 'implement', error: diagnostic, attempt: 1, willRetry: false },
    }),
  )
  const sink = createSessionStreamSink({
    store,
    scope: { kind: 'build', build: 'chatgpt-redaction' },
    flushMs: 100000,
  })
  const stream = await sink.open('test')
  sink.append([
    { type: 'text-start', id: 't' },
    { type: 'text-delta', id: 't', delta: tokens[0]!.slice(0, 8) },
  ])
  await sink.flush()
  sink.append([
    { type: 'text-delta', id: 't', delta: tokens[0]!.slice(8) },
    { type: 'text-end', id: 't' },
  ])
  await sink.close('completed')
  const evidence =
    JSON.stringify(await raw.getEvents('chatgpt-redaction')) +
    new TextDecoder().decode((await raw.getArtifact('chatgpt-redaction', 'transcript'))!.content) +
    JSON.stringify(await raw.readStream(stream)) +
    redactor.text(diagnostic)
  for (const token of tokens) expect(evidence).not.toContain(token)
})
