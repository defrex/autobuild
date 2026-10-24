import { accessSession } from '../access/session'
import { AccessFrame } from '../access/Frame'
import { ProjectsClient } from './ProjectsClient'
export const dynamic = 'force-dynamic'
export default async function ProjectsPage() {
  const session = await accessSession()
  if (!session.isSuperUser)
    return (
      <AccessFrame {...session} title="Projects" error="super user required">
        <p>Only super users can manage projects.</p>
      </AccessFrame>
    )
  return <ProjectsClient {...session} />
}
