import { DashboardClient } from '../../../hosted-store-service/app/dashboard/DashboardClient'
import { mountClientPage } from '../client-harness'
import { FIXTURE_TICKET_ID, OPERATOR_PAGE, OPERATOR_QUERY } from './fixtures'

mountClientPage({
  route: '/ticket/[id]',
  pathname: `/ticket/${encodeURIComponent(FIXTURE_TICKET_ID)}`,
  query: OPERATOR_QUERY,
  params: { id: FIXTURE_TICKET_ID },
  render: () => (
    <DashboardClient
      key={`${OPERATOR_PAGE.initialSelection}:${FIXTURE_TICKET_ID}`}
      {...OPERATOR_PAGE}
      ticketId={FIXTURE_TICKET_ID}
    />
  ),
})
