import { DashboardClient } from './dashboard/DashboardClient'
import { type OperatorSearchParams, operatorPage } from './dashboard/operator-page'
import { projectLink } from './dashboard/project-selection'

export const dynamic = 'force-dynamic'

export default async function DashboardPage({
  searchParams,
}: {
  searchParams: OperatorSearchParams
}) {
  const props = await operatorPage(searchParams, projectLink)
  return <DashboardClient key={props.initialSelection} {...props} />
}
