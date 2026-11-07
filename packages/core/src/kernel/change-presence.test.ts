import { expect, test } from 'bun:test'
import {
  answers,
  compactProbe,
  presenceNeeds,
  presenceWitness,
  probeEvidence,
  projectPresence,
  projectProbe,
  type ChangeIdentity,
  type LandingEvidence,
  type PresenceWitness,
} from './change-presence'
import { changePresenceEventPayloadSchemas } from '../events/repository'
import {
  compactObservation,
  syntheticGit,
  syntheticHistory,
  syntheticPresenceObservation,
  syntheticSha,
  type SyntheticCommit,
} from '../testing/presence-history'

const CEILING = 2048
const bytes = (value: unknown) => JSON.stringify(value).length
const schema = changePresenceEventPayloadSchemas['change-presence.observed']
const unrelatedLandings = (count: number, sha: (i: number) => string) =>
  Array.from({ length: count }, (_, i) => ({ slug: `unrelated-${i}`, sha: sha(i) }))

function compact(
  witness: PresenceWitness,
  questions: ChangeIdentity[],
  landings: LandingEvidence[],
  aliases = new Map<string, string>(),
) {
  const probe = compactProbe(witness, questions, landings, aliases)
  const identities = projectProbe(probe, landings, aliases)
  return { probe, identities, evidence: probeEvidence(probe, identities) }
}

function expectEquivalent(
  witness: PresenceWitness,
  questions: ChangeIdentity[],
  landings: LandingEvidence[],
  aliases = new Map<string, string>(),
) {
  const full = new Set(projectPresence(witness, landings, aliases))
  const { identities } = compact(witness, questions, landings, aliases)
  for (const id of questions) expect([id, identities.includes(id)]).toEqual([id, full.has(id)])
  return identities
}

test('compact observations stay a fixed size while reachable history grows', async () => {
  const sizes: Record<number, { witness: number; payload: number }> = {}
  const payloads: string[] = []
  for (const count of [10, 10_000]) {
    const history = syntheticHistory(count)
    history[0]!.trailers = ['direct']
    const git = syntheticGit(history)
    const head = history.at(-1)!.sha
    const questions: ChangeIdentity[] = ['build:direct', 'build:blocker']
    const landings = [{ slug: 'blocker', sha: history[1]!.sha }]
    const witness = await presenceWitness(git, head)
    expect(witness.commits).toHaveLength(count)
    const payload = await compactObservation(git, head, questions, landings)
    expect(schema.parse(payload)).toEqual(payload)
    expect(payload.identities).toEqual(['build:blocker', 'build:direct'])
    sizes[count] = { witness: bytes(witness), payload: bytes(payload) }
    payloads.push(JSON.stringify(payload.probe))
    // Five head moves over trailerless, non-landing commits: matched fixtures.
    for (let move = 1; move <= 5; move++) {
      history.push(...syntheticHistory(100, count + move * 1000))
      const moved = await compactObservation(git, history.at(-1)!.sha, questions, landings)
      expect(moved.identities).toEqual(payload.identities)
      expect(bytes(moved)).toBe(bytes(payload))
    }
  }
  // The originating full-history witness grows linearly (about 43 bytes/SHA).
  expect(sizes[10_000]!.witness).toBeGreaterThan(10_000 * 42)
  expect(sizes[10]!.witness).toBeLessThan(10 * 42 + 100)
  expect(sizes[10_000]!.payload).toBe(sizes[10]!.payload)
  expect(sizes[10]!.payload).toBeLessThan(CEILING)
  expect(payloads[0]).toBe(payloads[1])
  console.log(`presence payload bytes: ${JSON.stringify(sizes)}`)
})

test('head moves that change answers stay correct under the shared ceiling', async () => {
  for (const count of [10, 10_000]) {
    const history = syntheticHistory(count)
    const blocker = syntheticSha(0xb10c)
    const landings = [
      { slug: 'blocker', sha: blocker },
      { slug: 'other', sha: syntheticSha(0x7e57e5) },
    ]
    const questions: ChangeIdentity[] = ['build:blocker', 'build:other']
    const git = syntheticGit([...history, { sha: blocker }, { sha: syntheticSha(0xfeed) }])
    const off = await compactObservation(git, history.at(-1)!.sha, questions, landings)
    const onto = await compactObservation(git, blocker, questions, landings)
    const after = await compactObservation(git, syntheticSha(0xfeed), questions, landings)
    expect(off.identities).toEqual([])
    expect(onto.identities).toEqual(['build:blocker'])
    expect(after.identities).toEqual(['build:blocker'])
    // A rewritten head without the landing loses it again.
    const rewritten = syntheticGit([...history, { sha: syntheticSha(0xdead) }])
    const back = await compactObservation(rewritten, syntheticSha(0xdead), questions, landings)
    expect(back.identities).toEqual([])
    for (const payload of [off, onto, after, back]) expect(bytes(payload)).toBeLessThan(CEILING)
  }
})

test('read-budget synthetic observations are bounded by the query', async () => {
  const small = await syntheticPresenceObservation(10)
  const large = await syntheticPresenceObservation(10_000)
  expect(JSON.stringify(large)).toBe(JSON.stringify({ ...small, head: large.head }))
  expect(large.identities).toEqual(['build:blocker'])
})

test('compact answers equal full-witness membership for every question', async () => {
  const c = (n: number) => syntheticSha(n)
  const unreachable = c(0x999)
  const original = c(0xf0)
  const middle = c(0xf1)
  const history: SyntheticCommit[] = [
    { sha: c(1) },
    { sha: c(2), trailers: ['direct'] },
    { sha: c(3) },
    { sha: c(4) },
    { sha: c(5) },
    { sha: c(6) },
    { sha: c(7) },
  ]
  const witness = await presenceWitness(syntheticGit(history), c(7))
  const aliases = new Map([
    [c(6), middle],
    [middle, original],
  ])
  const landings: LandingEvidence[] = [
    { slug: 'squash', sha: c(3) },
    { slug: 'sibling', sha: unreachable },
    { slug: 'node', sha: c(4), contribution: ['build:leaf', `foreign:${c(0xab)}`] },
    { slug: 'outer', sha: c(5), contribution: ['build:inner'] },
    { slug: 'inner', sha: unreachable, contribution: ['build:deep'] },
    { slug: 'rewritten', sha: original },
    { slug: 'empty', sha: c(2), contribution: [] },
  ]
  const expected: Partial<Record<ChangeIdentity, boolean>> = {
    'build:direct': true,
    'build:squash': true,
    'build:sibling': false,
    'build:leaf': true,
    [`foreign:${c(0xab)}`]: true,
    'build:inner': true,
    'build:deep': true,
    'build:rewritten': true,
    [`foreign:${original}`]: true,
    'build:withdrawn': false,
    'build:empty': false,
  }
  const questions = Object.keys(expected) as ChangeIdentity[]
  for (const id of questions) {
    const present = expectEquivalent(witness, [id], landings, aliases)
    expect([id, present.includes(id)]).toEqual([id, expected[id]!])
  }
  expectEquivalent(witness, questions, landings, aliases)
  // Withdrawing the transporting landing removes the answer in both forms.
  const withdrawn = landings.filter((landing) => landing.slug !== 'node')
  expect(expectEquivalent(witness, ['build:leaf'], withdrawn, aliases)).toEqual([])
  // Without the alias chain the rewritten landing is not proven.
  expect(expectEquivalent(witness, ['build:rewritten'], landings)).toEqual([])
})

test('unrelated landings, shared SHAs and sibling growth never change the payload', async () => {
  const history = syntheticHistory(20)
  const witness = await presenceWitness(syntheticGit(history), history.at(-1)!.sha)
  const x = history[5]!.sha
  const questions: ChangeIdentity[] = ['build:queried']
  const queried = { slug: 'queried', sha: x }
  const baseline = compact(witness, questions, [queried])
  expect(baseline.identities).toEqual(['build:queried'])
  for (const count of [1, 10, 1000]) {
    // Shared landing SHA.
    const shared = compact(witness, questions, [queried, ...unrelatedLandings(count, () => x)])
    expect(JSON.stringify(shared)).toBe(JSON.stringify(baseline))
    // Unrelated landings and aliases elsewhere in reachable history.
    const elsewhere = unrelatedLandings(count, (i) => history[(i % 10) + 10]!.sha)
    const aliases = new Map(elsewhere.map((landing, i) => [landing.sha, syntheticSha(0x5000 + i)]))
    const spread = compact(witness, questions, [queried, ...elsewhere], aliases)
    expect(JSON.stringify(spread)).toBe(JSON.stringify(baseline))
    expect(presenceNeeds(questions, [queried, ...elsewhere], aliases)).toEqual(
      presenceNeeds(questions, [queried], new Map()),
    )
  }
  // A large sibling contribution in a node that is relevant in both variants.
  const node = (siblings: number): LandingEvidence => ({
    slug: 'carrier',
    sha: x,
    contribution: [
      'build:carried',
      ...Array.from({ length: siblings }, (_, i) => `build:sibling-${i}` as const),
      ...Array.from({ length: siblings }, (_, i) => `foreign:${syntheticSha(0x9000 + i)}` as const),
    ],
  })
  const one = compact(witness, ['build:carried'], [node(1)])
  const many = compact(witness, ['build:carried'], [node(1000)])
  expect(one.identities).toEqual(['build:carried'])
  expect(JSON.stringify(many)).toBe(JSON.stringify(one))
  expect(bytes(many)).toBeLessThan(CEILING)
})

test('introducing a relevant node refreshes once by its own keys, then stays fixed', async () => {
  const history = syntheticHistory(20)
  const witness = await presenceWitness(syntheticGit(history), history.at(-1)!.sha)
  const questions: ChangeIdentity[] = ['build:leaf']
  const before = compact(witness, questions, [])
  expect(before.identities).toEqual([])
  const node = (extra: number): LandingEvidence => ({
    slug: 'node',
    sha: history[3]!.sha,
    contribution: [
      'build:leaf',
      ...Array.from({ length: extra }, (_, i) => `build:other-${i}` as const),
    ],
  })
  const introduced = compact(witness, questions, [node(2)])
  expect(introduced.identities).toEqual(['build:leaf'])
  expect(introduced.evidence).not.toBe(before.evidence)
  expect(introduced.probe.builds).toEqual(['build:leaf', 'build:node'])
  expect(introduced.probe.commits).toEqual([history[3]!.sha])
  expect(bytes(introduced.probe) - bytes(before.probe)).toBeLessThanOrEqual(
    bytes([history[3]!.sha, 'build:node', history[3]!.sha]) + 6,
  )
  expect(bytes(introduced)).toBeLessThan(CEILING)
  const grown = compact(witness, questions, [node(1000)])
  expect(JSON.stringify(grown)).toBe(JSON.stringify(introduced))
})

test('probe coverage tracks stored questions and relevant landings only', async () => {
  const history = syntheticHistory(10)
  const witness = await presenceWitness(syntheticGit(history), history.at(-1)!.sha)
  const landings = [
    { slug: 'one', sha: history[1]!.sha },
    { slug: 'two', sha: syntheticSha(0xdead) },
  ]
  const q1: ChangeIdentity[] = ['build:one']
  const q2: ChangeIdentity[] = ['build:two']
  const both = compact(witness, [...q1, ...q2], landings)
  expect(both.identities).toEqual(['build:one'])
  for (const query of [q1, q2, [...q1, ...q2]])
    expect(answers(both.probe, query, landings, new Map())).toBe(true)
  expect(answers(both.probe, ['build:three'], landings, new Map())).toBe(false)
  // Re-asking a subset does not change the payload once the union is stored.
  const reask = compact(witness, both.probe.questions, landings)
  expect(JSON.stringify(reask)).toBe(JSON.stringify(both))
  // 1,000 unrelated landings leave needs and answers unchanged.
  const unrelated = unrelatedLandings(1000, (i) => syntheticSha(0x7000 + i))
  expect(answers(both.probe, q1, [...landings, ...unrelated], new Map())).toBe(true)
  expect(compact(witness, both.probe.questions, [...landings, ...unrelated]).evidence).toBe(
    both.evidence,
  )
  // A newer relevant landing for a stored, currently unasked question is not
  // covered, so its stale restricted answer is never reused.
  const newer = [...landings, { slug: 'two', sha: history[2]!.sha }]
  expect(answers(both.probe, q1, newer, new Map())).toBe(false)
  expect(compact(witness, both.probe.questions, newer).identities).toEqual([
    'build:one',
    'build:two',
  ])
  // An alias whose original is queried adds its key.
  const aliases = new Map([[history[4]!.sha, syntheticSha(0xdead)]])
  expect(presenceNeeds(q2, landings, aliases).commits).toEqual(
    [history[4]!.sha, syntheticSha(0xdead)].sort(),
  )
  expect(answers(both.probe, q2, landings, aliases)).toBe(false)
})

test('probe evidence is order-insensitive and tracks answers', async () => {
  const history = syntheticHistory(5)
  const witness = await presenceWitness(syntheticGit(history), history.at(-1)!.sha)
  const landings = [
    { slug: 'a', sha: history[0]!.sha },
    { slug: 'b', sha: history[1]!.sha },
  ]
  const forward = compact(witness, ['build:a', 'build:b'], landings)
  expect(forward.evidence).toMatch(/^presence-v4:[a-f0-9]{64}$/)
  const reversed = {
    ...forward.probe,
    questions: [...forward.probe.questions].reverse(),
    commits: [...forward.probe.commits].reverse(),
  }
  expect(probeEvidence(reversed, [...forward.identities].reverse())).toBe(forward.evidence)
  expect(compact(witness, ['build:a', 'build:b'], [landings[0]!]).evidence).not.toBe(
    forward.evidence,
  )
})

test('observation schema accepts probes and legacy witnesses, rejects malformed probes', () => {
  const sha = (c: string) => c.repeat(40)
  const probe = {
    version: 1,
    questions: ['build:a', 'build:b'],
    commits: [sha('a'), sha('b')],
    reachable: [sha('a')],
    builds: ['build:a'],
    trailers: ['build:a'],
  }
  const payload = {
    branch: 'main',
    destination: 'root:main',
    head: sha('c'),
    evidence: 'presence-v4:x',
    identities: ['build:a'],
    probe,
  }
  expect(schema.safeParse(payload).success).toBe(true)
  const { probe: _probe, ...legacy } = payload
  expect(
    schema.safeParse({
      ...legacy,
      evidence: 'presence-v3:x',
      identities: ['build:z'],
      witness: { version: 1, commits: [sha('a')], identities: [] },
    }).success,
  ).toBe(true)
  for (const invalid of [
    { ...probe, questions: ['build:b', 'build:a'] },
    { ...probe, commits: [sha('a'), sha('a')] },
    { ...probe, reachable: [sha('d')] },
    { ...probe, trailers: ['build:b'] },
    { ...probe, version: 2 },
    { ...probe, extra: true },
  ])
    expect(schema.safeParse({ ...payload, probe: invalid }).success).toBe(false)
  expect(schema.safeParse({ ...payload, identities: ['build:c'] }).success).toBe(false)
})
