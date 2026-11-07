import type { NodeGit } from '../kernel/node-restack'
import {
  compactProbe,
  presenceWitness,
  probeEvidence,
  projectProbe,
  type ChangeIdentity,
  type LandingEvidence,
} from '../kernel/change-presence'

export const syntheticSha = (n: number) => n.toString(16).padStart(40, '0')

export interface SyntheticCommit {
  sha: string
  /** Build slugs recorded as `Autobuild-Build:` trailers. */
  trailers?: string[]
}

/** A linear history of `count` trailerless commits starting at `from`. */
export function syntheticHistory(count: number, from = 1): SyntheticCommit[] {
  return Array.from({ length: count }, (_, i) => ({ sha: syntheticSha(from + i) }))
}

/** An in-memory NodeGit whose `git log <head>` returns `commits` (oldest
 * first) up to and including `head`, in the history reader's format. */
export function syntheticGit(commits: SyntheticCommit[]): NodeGit {
  return {
    workspacePath: '/synthetic',
    exec: async (cmd) => {
      const head = cmd.at(-2)!
      const end = commits.findIndex((commit) => commit.sha === head)
      if (cmd[1] !== 'log' || end < 0) return { exitCode: 128, stdout: '', stderr: 'unknown' }
      const stdout = commits
        .slice(0, end + 1)
        .reverse()
        .map((commit, i, all) => {
          const parent = all[i + 1]?.sha ?? ''
          const trailers = (commit.trailers ?? []).map((slug) => `Autobuild-Build: ${slug}`)
          const body = trailers.length ? `work\n\n${trailers.join('\n')}\n` : 'work\n'
          return `${commit.sha}\0${parent}\0${body}\0`
        })
        .join('')
      return { exitCode: 0, stdout, stderr: '' }
    },
  }
}

/** The durable payload a dispatcher appends for `questions` at `head`. */
export async function compactObservation(
  git: NodeGit,
  head: string,
  questions: ChangeIdentity[],
  landings: LandingEvidence[],
  aliases = new Map<string, string>(),
) {
  const witness = await presenceWitness(git, head)
  const probe = compactProbe(witness, questions, landings, aliases)
  const identities = projectProbe(probe, landings, aliases)
  return {
    branch: 'main',
    destination: 'root:main',
    head,
    evidence: probeEvidence(probe, identities),
    identities,
    probe,
  }
}

/** A real compact observation over a synthetic `commits`-long history whose
 * single queried blocker landed (trailerless) at the first commit. */
export async function syntheticPresenceObservation(commits: number) {
  const history = syntheticHistory(commits)
  return compactObservation(
    syntheticGit(history),
    history.at(-1)!.sha,
    ['build:blocker', 'build:absent'],
    [{ slug: 'blocker', sha: history[0]!.sha }],
  )
}
