import { SettingsClient } from '../../../hosted-store-service/app/settings/SettingsClient'
import { mountClientPage } from '../client-harness'
import { OPERATOR_PAGE, OPERATOR_QUERY } from './fixtures'

mountClientPage({
  route: '/settings',
  pathname: '/settings',
  query: OPERATOR_QUERY,
  render: () => <SettingsClient key={OPERATOR_PAGE.initialSelection} {...OPERATOR_PAGE} />,
})
