import type { AbEvent } from '../packages/core/src/events/catalog'
import { projectSessions } from '../packages/core/src/cli/dashboard/detail'

/** Both rendered frontends consume the same session vocabulary and pairing. */
export function nativeSessionCapture() {
  const handle = {
    version: 1,
    runner: 'pi',
    nativeId: 'capture-native',
    host: 'capture',
    workspacePath: '/capture',
  }
  const payloads = [
    [
      'session.started',
      { session: 's_interrupted', role: 'implement', runner: 'pi', phase: 'implement', round: 1 },
    ],
    [
      'session.suspended',
      {
        session: 's_interrupted',
        phase: 'implement',
        round: 1,
        handle,
        cause: 'pause',
        activeMs: 1000,
        transcript: { kind: 'transcript', rev: 0 },
        usage: { inputTokens: 100, outputTokens: 20, turns: 1 },
      },
    ],
    [
      'session.started',
      {
        session: 's_continued',
        role: 'implement',
        runner: 'pi',
        phase: 'implement',
        round: 1,
        continuation: {
          predecessor: 's_interrupted',
          root: 's_interrupted',
          handle,
          cause: 'pause',
          activeMs: 1000,
          budgetMs: 3600000,
        },
      },
    ],
    [
      'session.resumed',
      {
        session: 's_continued',
        predecessor: 's_interrupted',
        root: 's_interrupted',
        handle,
        cause: 'pause',
        stale: false,
      },
    ],
    [
      'session.started',
      { session: 's_remote', role: 'plan', runner: 'pi', phase: 'plan', round: 1 },
    ],
    [
      'session.suspended',
      {
        session: 's_remote',
        phase: 'plan',
        round: 1,
        cause: 'pause',
        activeMs: 500,
        transcript: { kind: 'transcript', rev: 1 },
      },
    ],
    [
      'session.resume-fallback',
      { session: 's_remote', reason: 'workspace-not-local-git-worktree' },
    ],
  ] as const
  return projectSessions(
    payloads.map(
      ([type, payload], index) =>
        ({
          build: 'capture',
          seq: index + 1,
          ts: '2026-10-19T00:00:00.000Z',
          actor: { kind: 'kernel' },
          type,
          payload,
        }) as AbEvent,
    ),
  )
}
