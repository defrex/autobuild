import { AccessFrame } from '../../../hosted-store-service/app/access/Frame'
import { ProjectsClient } from '../../../hosted-store-service/app/projects/ProjectsClient'
import { mountClientPage } from '../client-harness'
import { OPERATOR_SESSION } from './fixtures'

// The page renders the client for owners and super users and the refusal
// frame for anyone else; mount both so each branch's client code loads.
mountClientPage({
  route: '/projects',
  pathname: '/projects',
  render: () => (
    <>
      <ProjectsClient {...OPERATOR_SESSION} />
      <AccessFrame
        {...OPERATOR_SESSION}
        isOwner={false}
        isSuperUser={false}
        title="Projects"
        error="organization owner required"
      >
        <p>Organization owners and super users can manage projects.</p>
      </AccessFrame>
    </>
  ),
})
