import { describe, expect, test } from 'bun:test'
import { creationLabels } from './labels'

describe('creationLabels', () => {
  test('absent config and absent explicit labels send none', () => {
    expect(creationLabels({})).toBeUndefined()
  })

  test('an empty createLabels acts like an absent one', () => {
    expect(creationLabels({ createLabels: [] })).toBeUndefined()
    expect(creationLabels({ createLabels: [] }, ['bug'])).toEqual(['bug'])
  })

  test('an explicit [] with nothing configured stays []', () => {
    expect(creationLabels({}, [])).toEqual([])
  })

  test('configured labels alone are returned when the create names none', () => {
    expect(creationLabels({ createLabels: ['autobuild'] })).toEqual(['autobuild'])
    expect(creationLabels({ createLabels: ['autobuild'] }, [])).toEqual(['autobuild'])
  })

  test('the union lists explicit labels first, then configured ones', () => {
    expect(creationLabels({ createLabels: ['autobuild', 'team'] }, ['bug'])).toEqual([
      'bug',
      'autobuild',
      'team',
    ])
  })

  test('exact duplicates collapse', () => {
    expect(
      creationLabels({ createLabels: ['autobuild', 'autobuild'] }, ['autobuild', 'bug']),
    ).toEqual(['autobuild', 'bug'])
  })

  test('the explicit list is never mutated', () => {
    const explicit = ['bug']
    creationLabels({ createLabels: ['autobuild'] }, explicit)
    expect(explicit).toEqual(['bug'])
  })
})
