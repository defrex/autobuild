import { describe, expect, test } from 'bun:test'
import { readOperateSkill } from './prompt'

describe('operate skill as the hosted system prompt', () => {
  test('keeps the registry tool surface, approval and budget suspension, and wake turns', async () => {
    const skill = await readOperateSkill()
    for (const text of [
      'builds.control',
      'builds.answer',
      'tickets.create',
      'cause: approval',
      'cause: budget',
      'A wake turn',
      'escalation.raised',
    ]) {
      expect(skill).toContain(text)
    }
  })
})
