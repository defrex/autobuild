import { accessSession } from '../access/session'
import { AccessFrame } from '../access/Frame'
import { OrganizationsClient } from './OrganizationsClient'
export const dynamic = 'force-dynamic'
export default async function OrganizationsPage() {
  const session = await accessSession()
  if (!session.isSuperUser)
    return (
      <AccessFrame {...session} title="Organizations" error="super user required">
        <p>Only super users can manage organizations.</p>
      </AccessFrame>
    )
  return <OrganizationsClient {...session} />
}
