import { assertProtocolIdentityFixtures, identityFixturePath } from './protocol-identity-fixtures'
assertProtocolIdentityFixtures(await Bun.file(identityFixturePath).text())
console.log(
  'Protocol identity fixtures match current TypeScript identity/catalog and source hashes',
)
