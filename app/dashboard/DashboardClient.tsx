'use client'

import type { OperatorAnswerRequest, OperatorDashboardSnapshot } from 'autobuild/operator-api'
import {
  buildActionAvailability,
  type DashboardBuild,
  parseTranscript,
  repositoryActionAvailability,
  type TranscriptPresentation,
} from 'autobuild/operator-presentation'
import { useCallback, useEffect, useRef, useState } from 'react'
import * as api from './api'
import {
  type BuildControlAction,
  BuildsView,
  type HarvestControl,
  sameSelection,
  type Selection,
} from './BuildsView'
import { answerRequest, classifyAnswerReply, classifyControlReply } from './control-reply'
import { clockText } from './frame'
import { dashboardImperative } from './imperative'
import { OperatorShell } from './Shell'
import { reconcileDashboard } from './view-model'

interface ClientProps {
  identity: string
  repositories: readonly string[]
}

interface RowControlHandlerDependencies {
  selection?: Selection
  setSelection: (selection: Selection) => void
  clearTranscript: () => void
  clearAnswerStep: () => void
  setConfirmingAbort: (slug: string | undefined) => void
  setDetailOpen: (value: boolean | ((open: boolean) => boolean)) => void
  control: (slug: string, action: BuildControlAction) => void
  harvest: (body: Extract<HarvestControl, { action: 'run' }>) => void
}

interface ClosestTarget {
  closest: (selectors: string) => unknown
}

/** Let native button keyboard activation run instead of dashboard-wide shortcuts. */
export function isButtonKeyboardActivation(key: string, target: ClosestTarget | null): boolean {
  return (key === 'Enter' || key === ' ') && target?.closest('button') != null
}

/** Target-aware row interactions, extracted so their state policy is directly testable. */
export function createRowControlHandlers(deps: RowControlHandlerDependencies) {
  const selectTarget = (next: Selection) => {
    const changed = !sameSelection(deps.selection, next)
    deps.setSelection(next)
    deps.clearTranscript()
    deps.setConfirmingAbort(undefined)
    deps.clearAnswerStep()
    if (changed) deps.setDetailOpen(false)
  }
  return {
    buildControl(slug: string, action: BuildControlAction) {
      selectTarget({ kind: 'build', slug })
      deps.control(slug, action)
    },
    requestAbort(slug: string) {
      selectTarget({ kind: 'build', slug })
      deps.setConfirmingAbort(slug)
    },
    toggleDetail(slug: string) {
      deps.clearTranscript()
      deps.setConfirmingAbort(undefined)
      deps.clearAnswerStep()
      if (deps.selection?.kind === 'build' && deps.selection.slug === slug) {
        deps.setDetailOpen((open) => !open)
      } else {
        deps.setSelection({ kind: 'build', slug })
        deps.setDetailOpen(true)
      }
    },
    runHarvest(body: Extract<HarvestControl, { action: 'run' }>) {
      selectTarget({ kind: 'harvest' })
      deps.harvest(body)
    },
  }
}

export function DashboardClient({ identity, repositories }: ClientProps) {
  const [repo, setRepo] = useState(repositories[0] ?? '')
  const [snapshot, setSnapshot] = useState<OperatorDashboardSnapshot>()
  const [selection, setSelection] = useState<Selection>()
  const [hoverPreview, setHoverPreview] = useState<Selection>()
  const [detailOpen, setDetailOpen] = useState(false)
  const [confirmingAbort, setConfirmingAbort] = useState<string>()
  const [answerStep, setAnswerStep] = useState<{
    slug: string
    escalationIds: string[]
    input: string
  }>()
  const [error, setError] = useState<string>()
  const [pending, setPending] = useState<string>()
  const [now, setNow] = useState(Date.now())
  const [transcript, setTranscript] = useState<TranscriptPresentation>()
  const sequence = useRef(0)
  const answerPending = useRef(false)

  const poll = useCallback(
    async (signal?: AbortSignal) => {
      if (!repo) return
      const current = ++sequence.current
      try {
        const next = await api.dashboard(repo, signal)
        if (current !== sequence.current) return
        setSnapshot((old) => ({ ...next, model: reconcileDashboard(old?.model, next.model) }))
        setAnswerStep((step) => {
          if (!step || answerPending.current) return step
          const build = next.model.builds.find((row) => row.slug === step.slug)
          return build && build.blockers.length > 0 ? step : undefined
        })
        setError(undefined)
      } catch (cause) {
        if (!signal?.aborted) setError(cause instanceof Error ? cause.message : String(cause))
      }
    },
    [repo],
  )

  useEffect(() => {
    setSnapshot(undefined)
    setTranscript(undefined)
    setHoverPreview(undefined)
    const controller = new AbortController()
    void poll(controller.signal)
    const timer = window.setInterval(() => void poll(controller.signal), 2000)
    return () => {
      controller.abort()
      window.clearInterval(timer)
    }
  }, [poll])
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [])

  const act = async (key: string, operation: () => Promise<unknown>) => {
    setPending(key)
    setError(undefined)
    try {
      await operation()
      await poll()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
      await poll()
    } finally {
      setPending(undefined)
    }
  }

  const model = snapshot?.model
  const imperative = model ? dashboardImperative(model) : undefined
  const selectedBuild =
    selection?.kind === 'build'
      ? model?.builds.find((row) => row.slug === selection.slug)
      : undefined

  const select = (next: Selection | undefined) => {
    setSelection(next)
    setTranscript(undefined)
    setConfirmingAbort(undefined)
    setAnswerStep(undefined)
  }
  const activate = (next: Selection) => {
    if (answerPending.current) return
    setConfirmingAbort(undefined)
    if (sameSelection(selection, next)) {
      setDetailOpen((open) => !open)
      return
    }
    select(next)
    setDetailOpen(true)
  }
  const deselect = () => {
    select(undefined)
    setDetailOpen(false)
  }
  const control = (slug: string, action: BuildControlAction) => {
    setConfirmingAbort(undefined)
    const key = `${slug}:${action}`
    setPending(key)
    setError(undefined)
    void (async () => {
      let actionError: string | undefined
      try {
        const result = classifyControlReply(slug, await api.buildControl(repo, slug, { action }))
        if (result.kind === 'answer') {
          setAnswerStep({ slug: result.slug, escalationIds: result.escalationIds, input: '' })
        } else if (result.kind === 'unexpected') {
          actionError = result.text
        }
        await poll()
      } catch (cause) {
        actionError = cause instanceof Error ? cause.message : String(cause)
        await poll()
      } finally {
        if (actionError !== undefined) setError(actionError)
        setPending(undefined)
      }
    })()
  }
  const setting = (name: 'intake' | 'auto-merge-default', enabled: boolean) =>
    void act(name, () => api.setting(repo, name, enabled))
  const bulk = (action: 'pause' | 'resume') =>
    void act(`bulk-${action}`, () => api.bulk(repo, action))
  const harvest = (body: HarvestControl) =>
    void act(`harvest-${body.action}`, () => api.harvest(repo, body))
  const rowControls = createRowControlHandlers({
    selection,
    setSelection,
    clearTranscript: () => setTranscript(undefined),
    clearAnswerStep: () => setAnswerStep(undefined),
    setConfirmingAbort,
    setDetailOpen,
    control,
    harvest,
  })
  const answer = (slug: string, body: OperatorAnswerRequest) => {
    const key = `${slug}:answer`
    setPending(key)
    setError(undefined)
    void (async () => {
      let actionError: string | undefined
      try {
        const result = classifyAnswerReply(slug, await api.answerBuild(repo, slug, body))
        if (result.kind === 'unexpected') actionError = result.text
        await poll()
      } catch (cause) {
        actionError = cause instanceof Error ? cause.message : String(cause)
        await poll()
      } finally {
        if (actionError !== undefined) setError(actionError)
        setPending(undefined)
      }
    })()
  }
  const cancelAnswerStep = () => {
    if (!answerPending.current) setAnswerStep(undefined)
  }
  const submitAnswerStep = () => {
    if (!answerStep || answerPending.current) return
    answerPending.current = true
    const { slug, input } = answerStep
    const key = `${slug}:answer`
    setPending(key)
    setError(undefined)
    void (async () => {
      let actionError: string | undefined
      try {
        const result = classifyAnswerReply(
          slug,
          await api.answerBuild(repo, slug, answerRequest(input)),
        )
        if (result.kind === 'answered') setAnswerStep(undefined)
        else actionError = result.text
        await poll()
      } catch (cause) {
        actionError = cause instanceof Error ? cause.message : String(cause)
        await poll()
      } finally {
        if (actionError !== undefined) setError(actionError)
        answerPending.current = false
        setPending(undefined)
      }
    })()
  }

  const loadTranscript = async (row: DashboardBuild, kind: string, rev: number) => {
    setPending(`transcript:${row.slug}`)
    try {
      const response = await fetch(
        `/api/web/repos/${encodeURIComponent(repo)}/builds/${encodeURIComponent(row.slug)}/artifacts/${encodeURIComponent(kind)}?rev=${rev}`,
        { cache: 'no-store' },
      )
      if (response.status === 401) return window.location.assign('/sign-in')
      if (!response.ok) throw new Error(`transcript unavailable (${response.status})`)
      setTranscript(parseTranscript(await response.text()))
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setPending(undefined)
    }
  }

  // Keyboard parity with the terminal legend. The handler reads the latest
  // render through a ref so the listener binds once.
  const keyHandler = useRef<(event: KeyboardEvent) => void>(() => {})
  keyHandler.current = (event) => {
    if (!model) return
    if (event.metaKey || event.ctrlKey || event.altKey) return
    const target = event.target instanceof HTMLElement ? event.target : null
    if (isButtonKeyboardActivation(event.key, target)) return
    if (answerStep) {
      if (event.key === 'Escape') {
        event.preventDefault()
        cancelAnswerStep()
      } else if (
        event.key === 'Enter' &&
        !target?.closest('input, textarea, select, [contenteditable="true"]')
      ) {
        event.preventDefault()
        submitAnswerStep()
      }
      return
    }
    if (target?.closest('input, textarea, select, [contenteditable="true"]')) return
    const entries: Selection[] = [
      ...(model.harvest ? [{ kind: 'harvest' } as Selection] : []),
      ...model.builds.map((row): Selection => ({ kind: 'build', slug: row.slug })),
    ]
    const index = selection ? entries.findIndex((entry) => sameSelection(entry, selection)) : -1
    const available = selectedBuild ? buildActionAvailability(selectedBuild) : undefined
    const repository = repositoryActionAvailability(model)
    const busy = pending !== undefined
    switch (event.key) {
      case 'ArrowDown': {
        event.preventDefault()
        const next = entries[Math.min(entries.length - 1, index + 1)]
        if (next) select(next)
        return
      }
      case 'ArrowUp': {
        event.preventDefault()
        const next = entries[Math.max(0, index - 1)]
        if (next) select(next)
        return
      }
      case 'Enter':
        if (busy) return
        if (confirmingAbort === selectedBuild?.slug && selectedBuild) {
          event.preventDefault()
          control(selectedBuild.slug, 'abort')
        } else if (selection?.kind === 'build') {
          event.preventDefault()
          setDetailOpen((open) => !open)
        }
        return
      case 'Escape':
        if (confirmingAbort) setConfirmingAbort(undefined)
        else if (detailOpen) setDetailOpen(false)
        else deselect()
        return
      case 'a':
        if (!busy && selectedBuild && available?.abort) setConfirmingAbort(selectedBuild.slug)
        return
      case 'p':
        if (busy) return
        if (selectedBuild) {
          if (available?.primary === 'pause' || available?.primary === 'cancel-pause')
            control(selectedBuild.slug, available.primary)
        } else if (selection?.kind === 'harvest') {
          if (model.harvest?.action) harvest({ action: 'run', run: model.harvest.run })
        } else if (repository.bulkPause) bulk('pause')
        return
      case 'r':
        if (busy) return
        if (selectedBuild) {
          if (available?.primary === 'resume') control(selectedBuild.slug, 'resume')
        } else if (!selection && repository.bulkResume) bulk('resume')
        return
      case 'm':
        if (busy) return
        if (selectedBuild) {
          if (available?.autoMerge)
            control(
              selectedBuild.slug,
              selectedBuild.autoMerge === 'off' ? 'auto-merge-on' : 'auto-merge-off',
            )
        } else if (!selection) setting('auto-merge-default', !model.defaultAutoMerge)
        return
      case 'd':
        if (!busy && selectedBuild && available?.discard) control(selectedBuild.slug, 'discard')
        return
      case 'i':
        if (!busy) setting('intake', model.drained)
        return
      case 'h':
        if (!busy) harvest({ action: 'toggle-gate' })
        return
    }
  }
  useEffect(() => {
    const listen = (event: KeyboardEvent) => keyHandler.current(event)
    window.addEventListener('keydown', listen)
    return () => window.removeEventListener('keydown', listen)
  }, [])

  return (
    <OperatorShell
      repo={repo}
      repositories={repositories}
      identity={identity}
      imperative={imperative}
      clock={snapshot ? clockText(snapshot.generatedAt, now) : undefined}
      pending={pending !== undefined}
      error={error}
      onRepo={(next) => {
        if (answerPending.current) return
        setHoverPreview(undefined)
        setRepo(next)
        deselect()
      }}
      onSignOut={async () => {
        await fetch('/api/auth/sign-out', { method: 'POST' })
        window.location.assign('/sign-in')
      }}
    >
      <BuildsView
        repo={repo}
        model={model}
        now={now}
        pending={pending}
        selection={selection}
        hoverPreview={hoverPreview}
        detailOpen={detailOpen}
        confirmingAbort={confirmingAbort}
        answerStep={answerStep}
        answerPending={answerPending.current}
        transcript={transcript}
        onActivate={activate}
        onHoverPreview={setHoverPreview}
        onRowBuildControl={rowControls.buildControl}
        onRowRequestAbort={rowControls.requestAbort}
        onCancelAbort={() => setConfirmingAbort(undefined)}
        onRowToggleDetail={rowControls.toggleDetail}
        onAnswerStepInput={(input) => setAnswerStep((step) => (step ? { ...step, input } : step))}
        onSubmitAnswerStep={submitAnswerStep}
        onCancelAnswerStep={cancelAnswerStep}
        onAnswer={answer}
        onTranscript={loadTranscript}
        onSetting={setting}
        onHarvest={harvest}
        onRowHarvest={rowControls.runHarvest}
      />
    </OperatorShell>
  )
}
