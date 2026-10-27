import { DashboardClient } from '../dashboard/DashboardClient'
import { type OperatorSearchParams, operatorPage } from '../dashboard/operator-page'
import { tabLink } from '../dashboard/project-selection'

export const dynamic = 'force-dynamic'

export default async function QueuePage({ searchParams }: { searchParams: OperatorSearchParams }) {
  const props = await operatorPage(searchParams, (repo, query) => tabLink(repo, 'queue', query))
  return <DashboardClient key={props.initialSelection} {...props} tab="queue" />
}
