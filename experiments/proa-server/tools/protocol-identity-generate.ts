import { identityFixtureBytes, identityFixturePath } from './protocol-identity-fixtures'
await Bun.write(identityFixturePath, identityFixtureBytes())
console.log(`Generated ${identityFixturePath}`)
