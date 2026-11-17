import { AccessFrame } from '../../../hosted-store-service/app/access/Frame'
import { OrganizationsClient } from '../../../hosted-store-service/app/organizations/OrganizationsClient'
import { mountClientPage } from '../client-harness'
import { OPERATOR_SESSION } from './fixtures'

// The page renders the client for a super user and the refusal frame for
// anyone else; mount both so each branch's client code loads.
mountClientPage({
  route: '/organizations',
  pathname: '/organizations',
  render: () => (
    <>
      <OrganizationsClient {...OPERATOR_SESSION} />
      <AccessFrame
        {...OPERATOR_SESSION}
        isSuperUser={false}
        title="Organizations"
        error="super user required"
      >
        <p>Only super users can manage organizations.</p>
      </AccessFrame>
    </>
  ),
})
