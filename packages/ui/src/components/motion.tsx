import { type ReactNode, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { motion } from '../tokens'
import { type BlockGeometry, firstChange, planCommit, shrinkHold } from './flow-geometry'

/**
 * The Reserved Space rule as a primitive: the placeholder and the content
 * share one grid cell, so the box is sized before data arrives and nothing
 * below it moves when it does. The swap is a crossfade.
 */
export function Reserve({
  ready,
  placeholder,
  children,
  label = 'Loading',
}: {
  ready: boolean
  placeholder: ReactNode
  children: ReactNode
  label?: string
}) {
  return (
    <div data-ansi="reserve" data-ready={ready ? '' : undefined} aria-busy={!ready}>
      <div data-ansi="reserve-placeholder" aria-hidden="true" inert>
        {placeholder}
      </div>
      <div data-ansi="reserve-content" inert={!ready}>
        {ready ? children : null}
      </div>
      {!ready && (
        <span data-ansi="visually-hidden" role="status">
          {label}
        </span>
      )}
    </div>
  )
}

export type Presence = 'entering' | 'present' | 'exiting'

/** Keep a removed element mounted while its exit transition runs. */
export function usePresence(present: boolean, exitMs: number): Presence | null {
  const [state, setState] = useState<Presence | null>(present ? 'present' : null)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  useEffect(() => {
    clearTimeout(timer.current)
    if (present) {
      setState((s) => (s === null || s === 'exiting' ? 'entering' : s))
      timer.current = setTimeout(() => setState('present'), 16)
    } else {
      setState((s) => (s === null ? null : 'exiting'))
      timer.current = setTimeout(() => setState(null), exitMs)
    }
    return () => clearTimeout(timer.current)
  }, [present, exitMs])
  return state
}

/** Run a document-level change, such as a theme switch, as a crossfade where
 * the browser supports view transitions, and instantly where it doesn't. */
export function withTransition(change: () => void) {
  const start = (document as Document & { startViewTransition?: (cb: () => void) => unknown })
    .startViewTransition
  if (start === undefined || matchMedia('(prefers-reduced-motion: reduce)').matches) change()
  else start.call(document, change)
}

/**
 * A page rendered with every fact masked: the real page, painted as skeleton
 * bars that fill each text run's own line boxes. Only paint changes, never a
 * box metric, so the masked page has the loaded page's exact geometry.
 */
export function Masked({ children }: { children: ReactNode }) {
  return (
    <div data-ansi="masked" aria-hidden="true" inert>
      {children}
    </div>
  )
}

/** One keyed block of a `StableFlow`. Keys are stable per fact, so a block
 * that moves keeps its identity. */
export interface FlowBlock {
  key: string
  node: ReactNode
}

const ms = (value: string) => Number.parseFloat(value)
const LAYOUT_MS = ms(motion.layout)
const EXIT_MS = Math.round(LAYOUT_MS * motion.exitScale)

/** Every descendant's box relative to its block, skipping the inside of a
 * reserved slot, whose own box is still compared. */
function geometry(layer: HTMLElement): BlockGeometry[] {
  const origin = layer.getBoundingClientRect()
  const blocks: BlockGeometry[] = []
  for (const block of Array.from(layer.children)) {
    if (!(block instanceof HTMLElement) || block.dataset.ansi !== 'flow-block') continue
    const box = block.getBoundingClientRect()
    const rects: number[] = []
    const walk = (el: Element) => {
      for (const child of Array.from(el.children)) {
        const r = child.getBoundingClientRect()
        rects.push(
          Math.round(r.left - box.left),
          Math.round(r.top - box.top),
          Math.round(r.width),
          Math.round(r.height),
        )
        if (!child.hasAttribute('data-flow-slot')) walk(child)
      }
    }
    walk(block)
    blocks.push({
      key: block.dataset.key ?? '',
      top: Math.round(box.top - origin.top),
      height: Math.round(box.height),
      rects,
    })
  }
  return blocks
}

/** The bottom of the last block, relative to its layer's top. */
function contentHeight(blocks: readonly BlockGeometry[]): number {
  const last = blocks.at(-1)
  return last === undefined ? 0 : last.top + last.height
}

/** Each block's React key. A block inside a transaction's changed region is
 * remounted under a fresh key: it moves only while invisible, and a reused
 * node would carry its pre-transaction position into the browser's next
 * layout-shift comparison once it shows again. */
type Mounts = ReadonlyMap<string, string>

function mountsFor(
  blocks: readonly FlowBlock[],
  previous: Mounts,
  remountFrom?: { index: number; generation: number },
): Mounts {
  return new Map(
    blocks.map((block, index) => [
      block.key,
      remountFrom !== undefined && index >= remountFrom.index
        ? `${block.key}#${remountFrom.generation}`
        : (previous.get(block.key) ?? block.key),
    ]),
  )
}

interface Shown {
  blocks: readonly FlowBlock[]
  seq: number
  mounts: Mounts
}

type Transaction = {
  from: number
  stage: 'leaving' | 'hidden' | 'entering'
  blocks: readonly FlowBlock[]
  seq: number
}

/**
 * The Stable Layout rule for a live page. Each new input is rendered into a
 * hidden measuring layer first. Equal geometry commits in place, as does a
 * change that starts below the viewport. Any other change is a layout
 * transaction: the blocks from the first changed one fade out, the new blocks
 * commit while invisible, and they fade back in. Blocks above the change never
 * move, and nothing visible ever slides. Inputs that arrive during a
 * transaction wait for it, and the latest is compared when it ends.
 * `onSettled(seq)` reports when the committed blocks are input `seq`'s and no
 * transaction is running.
 */
export function StableFlow({
  blocks,
  seq,
  onSettled,
}: {
  blocks: readonly FlowBlock[]
  seq: number
  onSettled?: (seq: number) => void
}) {
  const [shown, setShown] = useState<Shown>(() => ({
    blocks,
    seq,
    mounts: mountsFor(blocks, new Map()),
  }))
  const generation = useRef(0)
  /** Commit `next`, remounting every block from `from` when it is a
   * transaction's invisible commit. */
  const commit = (next: readonly FlowBlock[], nextSeq: number, from?: number) =>
    setShown((current) => ({
      blocks: next,
      seq: nextSeq,
      mounts: mountsFor(
        next,
        current.mounts,
        from === undefined ? undefined : { index: from, generation: ++generation.current },
      ),
    }))
  const [tx, setTx] = useState<Transaction | undefined>(undefined)
  const [hold, setHold] = useState<number | undefined>(undefined)
  const flowRef = useRef<HTMLDivElement>(null)
  const measureRef = useRef<HTMLDivElement>(null)
  const settled = useRef<number | undefined>(undefined)
  const pending = tx === undefined && blocks !== shown.blocks

  useLayoutEffect(() => {
    if (!pending) return
    const flow = flowRef.current
    const layer = measureRef.current
    if (flow === null || layer === null) return
    const now = geometry(flow)
    const next = geometry(layer)
    const change = firstChange(now, next)
    const flowTop = flow.getBoundingClientRect().top
    const nextHeight = contentHeight(next)
    const changeTop =
      change === undefined
        ? 0
        : flowTop +
          Math.min(now[change]?.top ?? contentHeight(now), next[change]?.top ?? nextHeight)
    const plan = planCommit({
      firstChange: change,
      changeTop,
      viewportBottom: window.innerHeight,
      shownCount: now.length,
    })
    setHold(shrinkHold(flow.offsetHeight, nextHeight, flowTop + nextHeight, window.innerHeight))
    if (plan.kind !== 'transaction') commit(blocks, seq)
    else if (plan.exit) setTx({ from: plan.from, stage: 'leaving', blocks, seq })
    else {
      commit(blocks, seq, plan.from)
      setTx({ from: plan.from, stage: 'hidden', blocks, seq })
    }
  })

  // The transaction's stages: fade out, commit invisible, fade in.
  // biome-ignore lint/correctness/useExhaustiveDependencies: commit only sets state
  useEffect(() => {
    if (tx === undefined) return
    if (tx.stage === 'leaving') {
      const timer = setTimeout(() => {
        commit(tx.blocks, tx.seq, tx.from)
        setTx({ ...tx, stage: 'hidden' })
      }, EXIT_MS)
      return () => clearTimeout(timer)
    }
    if (tx.stage === 'hidden') {
      // The hidden state is computed before the fade-in starts.
      void flowRef.current?.offsetHeight
      const frame = requestAnimationFrame(() => setTx({ ...tx, stage: 'entering' }))
      return () => cancelAnimationFrame(frame)
    }
    const timer = setTimeout(() => setTx(undefined), LAYOUT_MS)
    return () => clearTimeout(timer)
  }, [tx])

  // A held height is released once the flow's own bottom is below the fold.
  useEffect(() => {
    if (hold === undefined) return
    const release = () => {
      const flow = flowRef.current
      if (flow === null) return
      const natural = contentHeight(geometry(flow))
      if (flow.getBoundingClientRect().top + natural > window.innerHeight) setHold(undefined)
    }
    window.addEventListener('scroll', release, { passive: true })
    return () => window.removeEventListener('scroll', release)
  }, [hold])

  useEffect(() => {
    if (tx !== undefined || pending || shown.seq !== seq || settled.current === seq) return
    settled.current = seq
    onSettled?.(seq)
  })

  const stage = (index: number) => (tx !== undefined && index >= tx.from ? tx.stage : undefined)
  return (
    <div
      data-ansi="flow"
      ref={flowRef}
      style={hold !== undefined ? { minHeight: `${hold}px` } : undefined}
    >
      {shown.blocks.map((block, index) => (
        <div
          key={shown.mounts.get(block.key) ?? block.key}
          data-ansi="flow-block"
          data-key={block.key}
          data-flow={stage(index)}
        >
          {block.node}
        </div>
      ))}
      {pending && (
        <div data-ansi="flow-measure" ref={measureRef} aria-hidden="true" inert>
          {blocks.map((block) => (
            <div key={block.key} data-ansi="flow-block" data-key={block.key}>
              {block.node}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
