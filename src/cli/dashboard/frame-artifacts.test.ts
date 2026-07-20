import { describe, expect, test } from 'bun:test'
import {
  dashboardFrameArtifactKind,
  dashboardFrameManifestSchema,
  dashboardVerifyReport,
  extractDashboardFrameManifest,
  type DashboardFrameManifest,
} from './frame-artifacts'

function manifest(): DashboardFrameManifest {
  return {
    version: 1,
    renderer: 'dashboard-ansi-png-v1',
    frames: [
      {
        id: 'mixed-wide',
        terminal: { columns: 140, rows: 40 },
        text: { kind: 'dashboard-frame:mixed-wide:text', rev: 0 },
        png: { kind: 'dashboard-frame:mixed-wide:png', rev: 0 },
      },
      {
        id: 'mixed-narrow',
        terminal: { columns: 64, rows: 50 },
        text: { kind: 'dashboard-frame:mixed-narrow:text', rev: 2 },
        png: { kind: 'dashboard-frame:mixed-narrow:png', rev: 3 },
      },
    ],
  }
}

describe('dashboard frame artifact manifest', () => {
  test('round-trips through a report even after visual observations are appended', () => {
    const expected = manifest()
    const report = `${dashboardVerifyReport(expected)}\n- mixed-wide: columns align.\n`
    expect(extractDashboardFrameManifest(report)).toEqual(expected)
    expect(report).toContain('Inspect every PNG')
    expect(report).toContain('## Visual checklist')
  })

  test('enforces stable kinds, strict fields, unique ids, and nonnegative revisions', () => {
    const wrong = manifest()
    wrong.frames[0]!.text.kind = 'other'
    wrong.frames[1]!.id = 'mixed-wide'
    wrong.frames[1]!.png.rev = -1
    const result = dashboardFrameManifestSchema.safeParse(wrong)
    expect(result.success).toBe(false)
    if (!result.success) {
      const issues = result.error.issues.map((issue) => issue.message).join('\n')
      expect(issues).toContain('expected stable kind')
      expect(issues).toContain('duplicate frame id')
      expect(issues).toContain('Too small')
    }
  })

  test('rejects missing, duplicated, malformed, and invalid manifest blocks', () => {
    expect(() => extractDashboardFrameManifest('# no manifest\n')).toThrow(
      'exactly one manifest block',
    )
    const valid = dashboardVerifyReport(manifest())
    expect(() => extractDashboardFrameManifest(`${valid}\n${valid}`)).toThrow(
      'exactly one manifest block',
    )
    expect(() =>
      extractDashboardFrameManifest(
        valid.replace('"version": 1', '"version": 9'),
      ),
    ).toThrow('manifest is invalid')
    expect(() =>
      extractDashboardFrameManifest(valid.replace('"frames": [', '"frames": [ nope')),
    ).toThrow('not valid JSON')
  })

  test('builds stable text and PNG kinds', () => {
    expect(dashboardFrameArtifactKind('mixed-wide', 'text')).toBe(
      'dashboard-frame:mixed-wide:text',
    )
    expect(dashboardFrameArtifactKind('mixed-wide', 'png')).toBe(
      'dashboard-frame:mixed-wide:png',
    )
  })
})
