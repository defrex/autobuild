import { MembersClient } from '../../../hosted-store-service/app/members/MembersClient'
import { mountClientPage } from '../client-harness'
import { FIXTURE_ORGANIZATION, OPERATOR_SESSION } from './fixtures'

mountClientPage({
  route: '/members',
  pathname: '/members',
  query: `org=${FIXTURE_ORGANIZATION}`,
  render: () => (
    <MembersClient
      {...OPERATOR_SESSION}
      initialOrg={FIXTURE_ORGANIZATION}
      signInUrl="https://operator.example.com/sign-in"
    />
  ),
})
