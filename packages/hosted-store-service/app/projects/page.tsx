import { accessSession } from '../access/session'
import { AccessFrame } from '../access/Frame'
import { ProjectsClient } from './ProjectsClient'
export const dynamic = 'force-dynamic'
export default async function ProjectsPage() {
  const session = await accessSession()
  if (!session.isSuperUser && !session.isOwner)
    return (
      <AccessFrame {...session} title="Projects" error="organization owner required">
        <p>Organization owners and super users can manage projects.</p>
      </AccessFrame>
    )
  return <ProjectsClient {...session} />
}
