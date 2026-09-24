/**
 * Re-export: the operator-session reducer lives in core (`store/session-
 * reducer.ts`) beside `reduceBuild`, because the orchestrator turn runner
 * (packages/core/src/orchestrator/) reduces session state without a
 * cross-package back-edge. The hosted package keeps its import path.
 */
export * from '@defrex/autobuild/plugin-sdk'
