import { SignIn } from '../../../hosted-store-service/app/sign-in/SignIn'
import { mountClientPage } from '../client-harness'

mountClientPage({
  route: '/sign-in',
  pathname: '/sign-in',
  render: () => <SignIn providers={['github']} />,
})
