import { expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { ACCESS_SCENARIOS, accessFixture } from './access-fixtures'
for (const scenario of ACCESS_SCENARIOS)
  test(`production access fixture ${scenario}`, () => {
    const html = renderToStaticMarkup(accessFixture(`access-${scenario}-narrow`))
    expect(html).toContain('Autobuild')
    expect(html).not.toContain('connected by')
    if (scenario === 'members-member' || scenario === 'members-refused') {
      expect(html).not.toContain('>Remove<')
      expect(html).not.toContain('Add member')
    }
    if (scenario === 'members-confirm' || scenario === 'projects-confirm') {
      expect(html).toContain('access-confirm')
      expect(html).toContain('Cancel')
      expect(html).not.toContain('dialog')
    }
    if (scenario === 'orgs-empty') expect(html).toContain('No organizations yet.')
    if (scenario === 'connect-multiple') expect(html).toContain('type="radio"')
    if (scenario === 'connect-single') {
      expect(html).toContain('type="radio"')
      expect(html).toContain('checked=""')
      expect(html).toContain('Acme Product')
      expect(html).not.toContain('disabled=""')
    }
    if (scenario === 'connect-fixed') expect(html).not.toContain('type="radio"')
    if (scenario.startsWith('connect-')) {
      for (const text of [
        '123456789A',
        'https://github.com/acme/mobile',
        'Approve project',
        'Deny',
      ])
        expect(html).toContain(text)
      expect(html).not.toContain('Review project')
    }
    if (scenario === 'connect-fixed') expect(html).toContain('Organization: <strong>Acme Product')
    if (scenario === 'connect-multiple') expect(html).toContain('disabled=""')
    if (scenario === 'connect-zero') {
      expect(html).toContain('No organization is available')
      expect(html).toContain('disabled')
    }
  })
