import { describe, expect, test } from 'bun:test'
import type { TicketAssetMeta } from '../store/ticket-assets'
import { ticketAssetNote } from './ticket-assets'

describe('ticketAssetNote', () => {
  const meta: TicketAssetMeta = {
    repo: 'r',
    ticketId: 'AUT-1',
    kind: 'design',
    name: 'home',
    revision: 2,
    layout: 'tree',
    size: 2048,
    createdAt: 'now',
    entries: [
      { type: 'file', path: 'a', size: 2048, blobRef: 'x' },
      { type: 'dir', path: 'd' },
    ],
  }

  test('names the asset, revision, size, the download command, and where the bytes live', () => {
    for (const event of ['attached', 'replaced', 'removed'] as const) {
      const note = ticketAssetNote(event, meta)
      expect(note).toContain('`design/home`')
      expect(note).toContain('ab ticket asset get AUT-1 design home <dest>')
      expect(note).toContain('--rev 2')
      expect(note).toContain('Autobuild store, not in this ticket')
      // Plain Markdown: backticks, never bold (Linear breaks bold before a word).
      expect(note).not.toContain('**')
    }
    expect(ticketAssetNote('attached', meta)).toContain('revision 2, 1 file, 2.0 KiB')
    expect(ticketAssetNote('replaced', meta)).toContain('is now revision 2')
    expect(ticketAssetNote('removed', meta)).toContain('no longer one of this ticket')
  })
})
