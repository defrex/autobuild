/** `ab build status` and `builds.get` show the build's role profile (SPEC §9). */
import { expect, test } from 'bun:test'
import { DISPATCHER, KERNEL } from '../events/envelope'
import { MemoryBuildStore } from '../store/memory'
import { detail, renderDetail } from './status'

async function profiled(profile?: string, configured?: boolean) {
  const store = new MemoryBuildStore()
  const record = await store.createBuild({ slug: 'profiled', repo: '/repo' })
  await store.append(record.slug, {
    actor: DISPATCHER,
    type: 'build.created',
    payload: {
      ticket: { source: 'file', id: 'T-1' },
      repo: '/repo',
      baseBranch: 'main',
      ...(profile !== undefined ? { profile } : {}),
    },
  })
  if (profile !== undefined && configured !== undefined)
    await store.append(record.slug, {
      actor: KERNEL,
      type: 'session.started',
      payload: {
        session: 's_plan',
        role: 'plan',
        runner: 'claude',
        phase: 'plan',
        round: 1,
        profile: { name: profile, configured },
      },
    })
  const now = new Date('2026-11-12T00:00:00Z')
  const shown = detail(record, await store.getEvents(record.slug), now)
  return { shown, lines: renderDetail(shown, now) }
}

test('a build without a profile shows none in text or JSON', async () => {
  const { shown, lines } = await profiled()
  expect(shown).not.toHaveProperty('profile')
  expect(lines.some((line) => line.startsWith('  profile:'))).toBe(false)
})

test('a build with a profile shows its name', async () => {
  const { shown, lines } = await profiled('deep')
  expect(shown.profile).toEqual({ name: 'deep', configured: true })
  expect(lines).toContain('  profile:  deep')
})

test('a removed profile says the build now uses the repository roles', async () => {
  const { shown, lines } = await profiled('deep', false)
  expect(shown.profile).toEqual({ name: 'deep', configured: false })
  expect(lines).toContain(
    "  profile:  deep (no longer configured — sessions use the repository's roles)",
  )
})
