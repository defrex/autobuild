import type { LogIndex, LoopIndex, RoundRecord } from './log-index'
type JsonLoop = Omit<LoopIndex, 'rounds'> & {
  rounds: [number, RoundRecord][]
}
export type JsonLogIndex = Omit<LogIndex, 'plan' | 'code' | 'finalizeStepsDone'> & {
  plan: JsonLoop
  code: JsonLoop
  finalizeStepsDone: string[]
}
export function encodeLog(log: LogIndex): JsonLogIndex {
  return {
    ...log,
    plan: { ...log.plan, rounds: [...log.plan.rounds] },
    code: { ...log.code, rounds: [...log.code.rounds] },
    finalizeStepsDone: [...log.finalizeStepsDone],
  }
}
export function decodeLog(log: JsonLogIndex): LogIndex {
  const loop = (value: JsonLoop): LoopIndex => {
    for (const entry of value.rounds) {
      if (
        entry.length !== 2 ||
        !Number.isSafeInteger(entry[0]) ||
        entry[1] === null ||
        typeof entry[1] !== 'object' ||
        Array.isArray(entry[1])
      )
        throw new Error('invalid persisted log-index round entry')
    }
    return { ...value, rounds: new Map(value.rounds) }
  }
  return {
    ...log,
    plan: loop(log.plan),
    code: loop(log.code),
    finalizeStepsDone: new Set(log.finalizeStepsDone),
  }
}
