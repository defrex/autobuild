import { expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { ProjectsView } from './ProjectsView'
import type { Snapshot } from '../access/api'
const repo = 'https://github.com/acme/project'
const snapshot: Snapshot = {
  organization: {
    id: 'org',
    name: 'Acme',
    slug: 'acme',
    ownerEmail: 'owner@example.com',
    membershipRole: 'owner',
  },
  projects: [repo],
  members: [],
}
const base = { identity: 'owner@example.com', isSuperUser: false, snapshots: [snapshot] }
test('owners see deletion and Projects navigation without Move or Assign', () => {
  const html = renderToStaticMarkup(<ProjectsView {...base} isOwner menuOpen />)
  expect(html).toContain('Delete…')
  expect(html).toContain('href="/projects"')
  expect(html).not.toContain('Move…')
  expect(html).not.toContain('>Assign<')
  const member = renderToStaticMarkup(
    <ProjectsView
      {...base}
      snapshots={[
        { ...snapshot, organization: { ...snapshot.organization, membershipRole: 'member' } },
      ]}
      menuOpen
    />,
  )
  expect(member).not.toContain('Delete…')
  expect(member).not.toContain('href="/projects"')
})
test('shared confirmation dialog includes four counts, local boundary, irreversibility and credential cutoff', () => {
  const html = renderToStaticMarkup(
    <ProjectsView
      {...base}
      deleting={repo}
      deletionPreview={{
        repo,
        token: '"generation"',
        builds: 8,
        tickets: 13,
        secrets: 2,
        subscriptionAccounts: 1,
      }}
      pending
    />,
  )
  for (const text of [
    'Permanently delete',
    'cannot be undone',
    'Local repository files',
    'configuration',
    'Connected clients lose access immediately',
    'every project credential',
    '8 builds',
    '13 hosted tickets',
    '2 project secrets',
    '1 subscription accounts',
    'Delete project',
    'Cancel',
  ])
    expect(html).toContain(text)
  expect(html).toContain('<dialog class="confirm-dialog" open=""')
  expect(html).not.toContain('access-confirm')
  expect(html).toMatch(/disabled=""[^>]*>Delete project/)
  expect(html).toMatch(/disabled=""[^>]*>Cancel/)
})
test('loading never invents counts and cleanup error retains confirmation', () => {
  const html = renderToStaticMarkup(
    <ProjectsView {...base} deleting={repo} deletionError="Cleanup unavailable. Retry." />,
  )
  expect(html).toContain('Loading deletion preview')
  expect(html).not.toContain('0 builds')
  expect(html).toContain('Cleanup unavailable. Retry.')
  expect(html).toContain(repo)
})

test('unfinished deletion survives fresh page rendering with only a finish action', () => {
  const html = renderToStaticMarkup(
    <ProjectsView {...base} snapshots={[]} pendingDeletions={[repo]} />,
  )
  expect(html).toContain(repo)
  expect(html).toContain('Deletion unfinished')
  expect(html).toContain('Finish deletion…')
  expect(html).not.toContain('Move…')
  expect(html).not.toContain('>Assign<')
  const confirmation = renderToStaticMarkup(
    <ProjectsView
      {...base}
      snapshots={[]}
      pendingDeletions={[repo]}
      deleting={repo}
      deletionPreview={{
        repo,
        token: '"generation"',
        builds: 0,
        tickets: 0,
        secrets: 0,
        subscriptionAccounts: 0,
      }}
    />,
  )
  expect(confirmation).toContain('Finish deletion</button>')
  expect(confirmation).toContain('Cancel')
})
