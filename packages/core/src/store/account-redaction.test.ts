import { expect, test } from 'bun:test'
import { AccountRedactor, redactAccountStore } from './account-redaction'
import { MemoryBuildStore } from './memory'
import { KERNEL } from '../events/envelope'
import { createSessionStreamSink } from './streams/session-writer'

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
