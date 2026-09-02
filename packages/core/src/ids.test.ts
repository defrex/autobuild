import { describe, expect, test } from 'bun:test'
import { z } from 'zod'
import { randomUuids } from './ids'

const uuidV4Schema = z.uuidv4()

describe('randomUuids', () => {
  test('allocates platform-generated UUID v4 values, not the rejected v5 form', () => {
    const uuid = randomUuids()()

    expect(uuidV4Schema.safeParse(uuid).success).toBe(true)
    expect(uuidV4Schema.safeParse(Bun.randomUUIDv5('harvest-proposal', 'dns')).success).toBe(false)
  })
})
