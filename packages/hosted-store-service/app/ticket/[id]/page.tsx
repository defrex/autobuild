import { DashboardClient } from '../../dashboard/DashboardClient'
import { type OperatorSearchParams, operatorPage } from '../../dashboard/operator-page'
import { ticketLink } from '../../dashboard/project-selection'

export const dynamic = 'force-dynamic'

export default async function TicketPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>
  searchParams: OperatorSearchParams
}) {
  const { id: encoded } = await params
  const id = decodeURIComponent(encoded)
  const props = await operatorPage(searchParams, (repo, query) => ticketLink(repo, id, query))
  return <DashboardClient key={`${props.initialSelection}:${id}`} {...props} ticketId={id} />
}
