import { Connection } from '../../../hosted-store-service/app/connect/Connection'
import { mountClientPage } from '../client-harness'

mountClientPage({
  route: '/connect',
  pathname: '/connect',
  render: () => <Connection initialCode="" />,
})
