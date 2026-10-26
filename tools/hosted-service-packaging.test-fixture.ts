import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { deploymentTemplatePaths } from './hosted-service-packaging'

export async function addDeploymentFixture(root: string, pin: string, servicePin = pin) {
  const manifest = `${JSON.stringify(
    {
      dependencies: {
        '@defrex/autobuild': pin,
        '@defrex/autobuild-hosted-store-service': servicePin,
      },
    },
    null,
    2,
  )}\n`
  const vercel = '{ "framework": "nextjs" }\n'
  for (const path of deploymentTemplatePaths) {
    await mkdir(join(root, path), { recursive: true })
    await writeFile(join(root, path, 'package.json'), manifest)
    await writeFile(join(root, path, 'vercel.json'), vercel)
  }
}
