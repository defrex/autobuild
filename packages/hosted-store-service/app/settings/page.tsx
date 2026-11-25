import { operatorPage, type OperatorSearchParams } from '../dashboard/operator-page'
import { tabLink } from '../dashboard/project-selection'
import { parseWebAuthEnv } from '@defrex/autobuild-hosted-store-service/web/config'
import { repositoryMcpResource } from '@defrex/autobuild-hosted-store-service/web/mcp-resource'
import { SettingsClient } from './SettingsClient'
export const dynamic = 'force-dynamic'
export default async function SettingsPage({
  searchParams,
}: {
  searchParams: OperatorSearchParams
}) {
  const props = await operatorPage(searchParams, (repo, query) => tabLink(repo, 'settings', query))
  // Derived from the identity and deployment env alone: no store read.
  const mcpUrl = props.initialSelection
    ? repositoryMcpResource(parseWebAuthEnv(process.env).mcpResource, props.initialSelection)
    : undefined
  return (
    <SettingsClient
      key={props.initialSelection}
      {...props}
      {...(mcpUrl === undefined ? {} : { mcpUrl })}
    />
  )
}
