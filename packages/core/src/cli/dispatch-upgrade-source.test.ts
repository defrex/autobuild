import { expect, test } from 'bun:test'
import { productionLockClosure } from './dispatch-upgrade-source'

test('production identity ignores hoist paths while retaining the selected nested version and peer graph', () => {
  const manifest = { dependencies: { parent: '1.0.0' } }
  const parent = ['parent@1.0.0', '', { dependencies: { child: '^1.0.0' } }, 'sha512-parent']
  const child = ['child@1.0.0', '', {}, 'sha512-child']
  const lock = { lockfileVersion: 1, workspaces: { '': manifest }, packages: { parent, child } }
  const nested = {
    ...lock,
    packages: { parent, 'parent/child': child, child: ['child@2.0.0', '', {}, 'sha512-unrelated'] },
  }
  expect(productionLockClosure(manifest, nested).graph).toEqual(
    productionLockClosure(manifest, lock).graph,
  )
  const changed = {
    ...nested,
    packages: { ...nested.packages, 'parent/child': ['child@1.0.1', '', {}, 'sha512-changed'] },
  }
  expect(productionLockClosure(manifest, changed).graph).not.toEqual(
    productionLockClosure(manifest, lock).graph,
  )
})
