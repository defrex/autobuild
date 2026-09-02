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
import { isPiRuntimeUsable, PI_OWNED_ARGS, PiAgentRunner } from './pi'
import type { RuntimeRegistry } from './runtime'

export interface ProductionRuntimes {
  runtimes: RuntimeRegistry
}

export function createProductionRuntimes(): ProductionRuntimes {
  // Each adapter carries both the resumable AgentRunner contract and its
  // optional tool-free OneShotCompletion capability.
  const claude = new ClaudeAgentRunner()
  const codex = new CodexAgentRunner()
  const pi = new PiAgentRunner()

  return {
    runtimes: {
      claude: {
        runner: claude,
        oneShot: claude,
        initUsable: isClaudeRuntimeUsable,
        servesModels: ['claude-'],
        ownedArgs: CLAUDE_OWNED_ARGS,
        promptBoundary: CLAUDE_PROMPT_BOUNDARY,
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
      },
    },
  }
}
