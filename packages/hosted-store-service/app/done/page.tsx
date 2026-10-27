import { DashboardClient } from '../dashboard/DashboardClient'
import { type OperatorSearchParams, operatorPage } from '../dashboard/operator-page'
import { tabLink } from '../dashboard/project-selection'

export const dynamic = 'force-dynamic'

export default async function DonePage({ searchParams }: { searchParams: OperatorSearchParams }) {
  const props = await operatorPage(searchParams, (repo, query) => tabLink(repo, 'done', query))
  return <DashboardClient key={props.initialSelection} {...props} tab="done" />
}
