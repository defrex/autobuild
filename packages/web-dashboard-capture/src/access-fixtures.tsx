import { MembersView } from '../../hosted-store-service/app/members/MembersView'
import { OrganizationsView } from '../../hosted-store-service/app/organizations/OrganizationsView'
import { ProjectsView } from '../../hosted-store-service/app/projects/ProjectsView'
import { ConnectionView } from '../../hosted-store-service/app/connect/Connection'
import type { Snapshot } from '../../hosted-store-service/app/access/api'
export const ACCESS_SCENARIOS = [
  'members-owner',
  'members-member',
  'members-super',
  'members-confirm',
  'members-zero',
  'members-loading',
  'members-refused',
  'members-pending',
  'orgs',
  'orgs-empty',
  'projects',
  'projects-confirm',
  'projects-delete-super',
  'projects-delete-owner',
  'projects-delete-pending',
  'projects-delete-failed',
  'projects-cleanup-owner',
  'projects-cleanup-super',
  'projects-cleanup-confirm',
  'projects-member',
  'connect-multiple',
  'connect-single',
  'connect-fixed',
  'connect-zero',
]
export function accessFixture(id: string) {
  const state = ACCESS_SCENARIOS.find(
    (name) => id === `access-${name}-wide` || id === `access-${name}-narrow`,
  )
  if (!state) return undefined
  const a: Snapshot = {
    organization: {
      id: 'acme',
      name: 'Acme Product',
      slug: 'acme',
      ownerEmail: 'priya@acme.dev',
      membershipRole: 'owner',
    },
    projects: [
      'https://github.com/acme/web',
      'https://github.com/acme/api',
      'https://github.com/acme/design-system',
    ],
    members: [
      { name: 'Priya Raman', email: 'priya@acme.dev', role: 'owner', status: 'joined' },
      { name: 'Dana Okafor', email: 'dana@acme.dev', role: 'member', status: 'joined' },
      { name: 'Sam Lee', email: 'sam@acme.dev', role: 'member', status: 'joined' },
      {
        name: null,
        email: 'ines-with-a-long-email-address@acme.example.com',
        role: 'member',
        status: 'pending',
      },
    ],
  }
  const b: Snapshot = {
    organization: {
      id: 'northwind',
      name: 'Northwind Labs',
      slug: 'northwind',
      ownerEmail: null,
      membershipRole: null,
    },
    projects: ['https://github.com/northwind/ledger'],
    members: [],
  }
  const base = { identity: 'priya@acme.dev', isSuperUser: false }
  if (state.startsWith('members'))
    return (
      <MembersView
        {...base}
        signInUrl="https://autobuild.example.com/sign-in"
        isSuperUser={state === 'members-super'}
        menuOpen={
          state === 'members-super' || state === 'members-owner' || state === 'members-member'
        }
        organizations={[a.organization, b.organization]}
        selected={
          state === 'members-loading'
            ? undefined
            : {
                ...a,
                projects: state === 'members-zero' ? [] : a.projects,
                organization: {
                  ...a.organization,
                  membershipRole: state === 'members-member' ? 'member' : 'owner',
                },
              }
        }
        pending={state === 'members-loading' || state === 'members-pending'}
        error={state === 'members-refused' ? 'organization owner required' : undefined}
        forbidden={state === 'members-refused'}
        confirmation={state === 'members-confirm' ? 'sam@acme.dev' : undefined}
      />
    )
  if (state.startsWith('orgs'))
    return (
      <OrganizationsView
        identity="root@example.com"
        isSuperUser
        snapshots={state === 'orgs-empty' ? [] : [a, b]}
      />
    )
  if (state.startsWith('projects'))
    return (
      <ProjectsView
        identity="root@example.com"
        isSuperUser={
          !['projects-delete-owner', 'projects-cleanup-owner', 'projects-member'].includes(state)
        }
        isOwner={state === 'projects-delete-owner' || state === 'projects-cleanup-owner'}
        snapshots={
          state === 'projects-member'
            ? [{ ...a, organization: { ...a.organization, membershipRole: 'member' } }]
            : state === 'projects-delete-owner' || state === 'projects-cleanup-owner'
              ? [a]
              : [a, b]
        }
        pendingDeletions={
          state.startsWith('projects-cleanup') ? ['https://github.com/acme/retired'] : undefined
        }
        deleting={
          state === 'projects-cleanup-confirm'
            ? 'https://github.com/acme/retired'
            : state.startsWith('projects-delete')
              ? a.projects[1]
              : undefined
        }
        deletionPreview={{
          repo:
            state === 'projects-cleanup-confirm'
              ? 'https://github.com/acme/retired'
              : a.projects[1]!,
          token: '"generation"',
          builds: 24,
          tickets: 38,
          secrets: 3,
          subscriptionAccounts: 2,
        }}
        pending={state === 'projects-delete-pending'}
        deletionError={
          state === 'projects-delete-failed'
            ? 'Cleanup is unavailable. Retry to finish deleting this project.'
            : undefined
        }
        unassigned={
          state === 'projects-delete-owner' ||
          state === 'projects-cleanup-owner' ||
          state === 'projects-member'
            ? undefined
            : ['https://github.com/acme/mobile-with-a-long-repository-name']
        }
        confirmation={state === 'projects-confirm' ? a.projects[1] : undefined}
      />
    )
  return (
    <ConnectionView
      code="123456789A"
      connection={{
        code: '123456789A',
        repo: 'https://github.com/acme/mobile',
        credentialId: 'a'.repeat(32),
        status: 'pending',
      }}
      context={{
        assignment: state === 'connect-fixed' ? 'fixed' : 'new',
        organizations:
          state === 'connect-zero' || state === 'connect-fixed'
            ? []
            : state === 'connect-single'
              ? [a.organization]
              : [a.organization, b.organization],
      }}
      selectedOrganization={state === 'connect-multiple' ? 'acme' : undefined}
    />
  )
}
