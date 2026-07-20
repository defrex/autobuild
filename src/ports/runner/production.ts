/**
 * Production runtime registrations shared by every sessionless CLI path that
 * needs agent judgment. Keeping the shipped adapters and their model families
 * here prevents dispatch and other non-phase one-shots from drifting apart.
 */
import { ClaudeAgentRunner } from './claude'
import { PiAgentRunner } from './pi'
import type { RuntimeRegistry } from './runtime'

export interface ProductionRuntimes {
  runtimes: RuntimeRegistry
  /** Wiring fallback when neither a role nor [roles.default] names a runtime. */
  defaultRuntime: string
}

export function createProductionRuntimes(): ProductionRuntimes {
  // Each adapter carries both the resumable AgentRunner contract and its
  // optional tool-free OneShotCompletion capability.
  const claude = new ClaudeAgentRunner()
  const pi = new PiAgentRunner()

  return {
    runtimes: {
      claude: {
        runner: claude,
        oneShot: claude,
        servesModels: ['claude-'],
      },
      pi: {
        runner: pi,
        oneShot: pi,
        servesModels: [
          // OAuth coding providers (what `pi login` writes to auth.json).
          'openai-codex/',
          'kimi-coding/',
          // API-key providers, for keys supplied via env/auth.json.
          'openai/',
          'moonshotai/',
          'cloudflare-workers-ai/',
          'anthropic/',
          'openrouter/',
        ],
        defaultModel: 'kimi-coding/k3',
      },
    },
    defaultRuntime: 'claude',
  }
}
