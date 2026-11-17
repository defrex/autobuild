import { DashboardClient } from '../../../hosted-store-service/app/dashboard/DashboardClient'
import { mountClientPage } from '../client-harness'
import { OPERATOR_PAGE, OPERATOR_QUERY } from './fixtures'

mountClientPage({
  route: '/',
  pathname: '/',
  query: OPERATOR_QUERY,
  render: () => <DashboardClient key={OPERATOR_PAGE.initialSelection} {...OPERATOR_PAGE} />,
})
