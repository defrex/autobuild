import { ConsentForm } from '../../../hosted-store-service/app/oauth/consent/ConsentForm'
import { mountClientPage } from '../client-harness'
import { FIXTURE_CONSENT_CODE } from './fixtures'

// The consent page is a server component; its only client code is the form it
// renders when the request carries a consent code.
mountClientPage({
  route: '/oauth/consent',
  pathname: '/oauth/consent',
  query: `consent_code=${FIXTURE_CONSENT_CODE}`,
  render: () => <ConsentForm consentCode={FIXTURE_CONSENT_CODE} />,
})
