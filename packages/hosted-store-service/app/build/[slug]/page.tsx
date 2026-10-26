import { DashboardClient } from '../../dashboard/DashboardClient'
import { type OperatorSearchParams, operatorPage } from '../../dashboard/operator-page'
import { buildLink } from '../../dashboard/project-selection'

export const dynamic = 'force-dynamic'

export default async function BuildPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>
  searchParams: OperatorSearchParams
}) {
  const { slug: encoded } = await params
  const slug = decodeURIComponent(encoded)
  const props = await operatorPage(searchParams, (repo, query) => buildLink(repo, slug, query))
  return <DashboardClient key={`${props.initialSelection}:${slug}`} {...props} buildSlug={slug} />
}
