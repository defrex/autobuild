import { DashboardClient } from '../../../hosted-store-service/app/dashboard/DashboardClient'
import { mountClientPage } from '../client-harness'
import { FIXTURE_BUILD_SLUG, OPERATOR_PAGE, OPERATOR_QUERY } from './fixtures'

mountClientPage({
  route: '/build/[slug]',
  pathname: `/build/${encodeURIComponent(FIXTURE_BUILD_SLUG)}`,
  query: OPERATOR_QUERY,
  params: { slug: FIXTURE_BUILD_SLUG },
  render: () => (
    <DashboardClient
      key={`${OPERATOR_PAGE.initialSelection}:${FIXTURE_BUILD_SLUG}`}
      {...OPERATOR_PAGE}
      buildSlug={FIXTURE_BUILD_SLUG}
    />
  ),
})
