import { operatorPage, type OperatorSearchParams } from '../dashboard/operator-page'
import { tabLink } from '../dashboard/project-selection'
import { SettingsClient } from './SettingsClient'
export const dynamic = 'force-dynamic'
export default async function SettingsPage({
  searchParams,
}: {
  searchParams: OperatorSearchParams
}) {
  const props = await operatorPage(searchParams, (repo, query) => tabLink(repo, 'settings', query))
  return <SettingsClient key={props.initialSelection} {...props} />
}
