import { DashboardClient } from '../../../hosted-store-service/app/dashboard/DashboardClient'
import { mountClientPage } from '../client-harness'
import { OPERATOR_PAGE, OPERATOR_QUERY } from './fixtures'

mountClientPage({
  route: '/triage',
  pathname: '/triage',
  query: OPERATOR_QUERY,
  render: () => (
    <DashboardClient key={OPERATOR_PAGE.initialSelection} {...OPERATOR_PAGE} tab="triage" />
  ),
})
