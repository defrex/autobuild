import { expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { MembersView } from './MembersView'
import { OrganizationsView } from '../organizations/OrganizationsView'
import { ProjectsView } from '../projects/ProjectsView'
import type { Snapshot } from '../access/api'
const selected: Snapshot = {
  organization: {
    id: 'a',
    name: 'A',
    slug: 'a',
    ownerEmail: 'owner@example.com',
    membershipRole: 'owner',
  },
  projects: ['https://github.com/example/a'],
  members: [
    { email: 'owner@example.com', name: 'Owner', role: 'owner', status: 'joined' },
    { email: 'pending@example.com', name: null, role: 'member', status: 'pending' },
  ],
}
const base = {
  identity: 'owner@example.com',
  isSuperUser: false,
  organizations: [selected.organization],
  selected,
}
test('owner cannot remove own row; plain members have no mutation controls', () => {
  const owner = renderToStaticMarkup(<MembersView {...base} />)
  expect(owner.match(/>Remove</g)).toHaveLength(1)
  expect(owner).toContain('PENDING')
  expect(owner).toContain('JOINED')
  expect(owner).not.toContain('Organization owner')
  const member = renderToStaticMarkup(
    <MembersView
      {...base}
      selected={{
        ...selected,
        organization: { ...selected.organization, membershipRole: 'member' },
      }}
    />,
  )
  expect(member).not.toContain('>Remove<')
  expect(member).not.toContain('Add member')
  expect(member).toContain('An organization owner')
})
test('super user owner control and inline removal state name the revoked grant', () => {
  const html = renderToStaticMarkup(
    <MembersView {...base} isSuperUser confirmation="pending@example.com" />,
  )
  expect(html).toContain('Organization owner')
  expect(html).toContain('Other organization grants')
  expect(html).toContain('Cancel')
  expect(html).not.toContain('dialog')
})
test('empty organizations and projects offer bootstrap without invented counts', () => {
  const html = renderToStaticMarkup(
    <OrganizationsView identity="root@example.com" isSuperUser snapshots={[]} />,
  )
  expect(html).toContain('No organizations yet.')
  expect(html).toContain('Create')
  const projects = renderToStaticMarkup(
    <ProjectsView
      identity="root@example.com"
      isSuperUser
      snapshots={[]}
      unassigned={['example/waiting']}
    />,
  )
  expect(projects).toContain('disabled')
  expect(projects).toContain('Create an organization')
})

test('a failed roster load does not claim the operator has no membership', () => {
  const html = renderToStaticMarkup(
    <MembersView
      identity="owner@example.com"
      isSuperUser={false}
      organizations={[]}
      error="access service is unavailable"
    />,
  )
  expect(html).toContain('access service is unavailable')
  expect(html).not.toContain('do not belong')
})

test('the add form tells the owner to send the sign-in page themselves', () => {
  const html = renderToStaticMarkup(
    <MembersView {...base} signInUrl="https://autobuild.example.com/sign-in" />,
  )
  expect(html).toContain('ask them to sign up via')
  expect(html).toContain('https://autobuild.example.com/sign-in')
  expect(html).toContain('aria-label="Copy sign-up link"')
  const bare = renderToStaticMarkup(<MembersView {...base} />)
  expect(bare).toContain('the sign-in page')
  expect(bare).not.toContain('Copy sign-up link')
})
