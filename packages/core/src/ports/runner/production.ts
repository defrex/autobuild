/**
 * Production runtime registrations shared by every sessionless CLI path that
 * needs agent judgment. Keeping the shipped adapters and their model families
 * here prevents dispatch and other non-phase one-shots from drifting apart.
 */
import {
  CLAUDE_OWNED_ARGS,
  CLAUDE_PROMPT_BOUNDARY,
  ClaudeAgentRunner,
  isClaudeRuntimeUsable,
} from './claude'
import {
  CODEX_OWNED_ARGS,
  CODEX_PROMPT_BOUNDARY,
  CodexAgentRunner,
  isCodexRuntimeUsable,
} from './codex'
import {
  ANTIGRAVITY_OWNED_ARGS,
  AntigravityAgentRunner,
  isAntigravityRuntimeUsable,
} from './antigravity'
import { isPiRuntimeUsable, PI_OWNED_ARGS, PiAgentRunner } from './pi'
import type { SessionStreamInfo, RuntimeRegistry } from './runtime'
import type { SessionStreamSink } from '../types'

export interface ProductionRuntimes {
  runtimes: RuntimeRegistry
}

export function createProductionRuntimes(): ProductionRuntimes {
  // Each adapter carries the resumable AgentRunner contract; all but
  // Antigravity also carry the optional tool-free OneShotCompletion capability.
  const claude = new ClaudeAgentRunner()
  const codex = new CodexAgentRunner()
  const pi = new PiAgentRunner()
  const antigravity = new AntigravityAgentRunner()

  return {
    runtimes: {
      claude: {
        runner: claude,
        oneShot: claude,
        initUsable: isClaudeRuntimeUsable,
        servesModels: ['claude-'],
        ownedArgs: CLAUDE_OWNED_ARGS,
        promptBoundary: CLAUDE_PROMPT_BOUNDARY,
        openSessionStream: openSessionStreamLabel,
      },
      codex: {
        runner: codex,
        oneShot: codex,
        initUsable: isCodexRuntimeUsable,
        // Codex CLI model ids are unqualified; an omitted model delegates to
        // the operator's configured Codex default.
        servesModels: ['gpt-'],
        ownedArgs: CODEX_OWNED_ARGS,
        promptBoundary: CODEX_PROMPT_BOUNDARY,
        openSessionStream: openSessionStreamLabel,
      },
      pi: {
        runner: pi,
        oneShot: pi,
        initUsable: isPiRuntimeUsable,
        // The local Pi installation owns the provider catalog. Any
        // provider-qualified model it resolves is valid here.
        servesModels: ['*/*'],
        defaultModel: 'kimi-coding/k3',
        ownedArgs: PI_OWNED_ARGS,
        openSessionStream: openSessionStreamLabel,
      },
      antigravity: {
        runner: antigravity,
        // No oneShot: agy has no per-invocation way to guarantee tool-free
        // execution, so callers take their deterministic fallback.
        initUsable: isAntigravityRuntimeUsable,
        // Antigravity serves Gemini plus its Claude and GPT models under
        // unqualified slugs; an omitted model delegates to the agy default.
        servesModels: ['gemini-', 'claude-', 'gpt-'],
        ownedArgs: ANTIGRAVITY_OWNED_ARGS,
        openSessionStream: openSessionStreamLabel,
      },
    },
  }
}

/** The one shared opener: a session bracket's stream is labeled by its
 * Autobuild session id, never a harness-native session/thread id. */
function openSessionStreamLabel(sink: SessionStreamSink, info: SessionStreamInfo): Promise<string> {
  return sink.open(`session:${info.session}`)
}
