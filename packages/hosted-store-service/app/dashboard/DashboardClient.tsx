'use client'

import type {
  OperatorAnswerRequest,
  OperatorDashboardSnapshot,
} from '@defrex/autobuild-hosted-store-service/operator-api'
import {
  buildActionAvailability,
  type DashboardBuild,
  parseTranscript,
  repositoryActionAvailability,
  type TranscriptPresentation,
} from '@defrex/autobuild/operator-presentation'
import { useCallback, useEffect, useRef, useState } from 'react'
import * as api from './api'
import { useRouter, useSearchParams } from 'next/navigation'
import { buildLink, projectLink } from './project-selection'
import {
  type AnswerStep,
  type BuildControlAction,
  BuildPageView,
  BuildsView,
  DispatcherControls,
  type HarvestControl,
  sameSelection,
  type Selection,
} from './BuildsView'
import { answerRequest, classifyAnswerReply, classifyControlReply } from './control-reply'
import { clockText, LoadingControls } from './frame'
import { createDashboardRefresher, type DashboardRefresher } from './refresh'
import { OperatorShell } from './Shell'
import { createNowTicker } from './ticker'
import { reconcileDashboard } from './view-model'

interface ClientProps {
  identity: string
  isOwner?: boolean
  isSuperUser?: boolean
  initialSelection: string
  repositories: readonly string[]
  /** Set on a build's own page; absent on the builds list. */
  buildSlug?: string
}

/**
 * The last snapshot per project, kept across client navigations so moving
 * between the list and a build page renders at once while the next poll runs.
 */
const snapshotCache = new Map<string, OperatorDashboardSnapshot>()

export type AnswerModeKeyAction = 'cancel' | 'submit' | 'consume' | 'pass'

const DASHBOARD_ROW_SHORTCUTS = new Set(['a', 'p', 'r', 'm', 'd', 'i', 'h'])

/** Answer mode owns its row: only cancellation and non-editor submission may act. */
export function answerModeKeyAction(key: string, editorTarget: boolean): AnswerModeKeyAction {
  if (key === 'Escape') return 'cancel'
  if (key === 'Enter') return editorTarget ? 'pass' : 'submit'
  if (!editorTarget && DASHBOARD_ROW_SHORTCUTS.has(key)) return 'consume'
  return 'pass'
}

interface ClosestTarget {
  closest: (selectors: string) => unknown
}

/** Let native control activation run instead of dashboard-wide shortcuts. */
export function isNativeKeyboardActivation(key: string, target: ClosestTarget | null): boolean {
  if (key === 'Enter') return target?.closest('button, a[href]') != null
  return key === ' ' && target?.closest('button') != null
}

export function DashboardClient({
  identity,
  isOwner,
  isSuperUser,
  repositories,
  initialSelection,
  buildSlug,
}: ClientProps) {
  const router = useRouter()
  const searchParams = useSearchParams()
  const repo = initialSelection
  const routerRef = useRef(router)
  routerRef.current = router
  const lastRegistryRefresh = useRef(0)
  const refreshRegistry = useCallback(() => {
    if (Date.now() - lastRegistryRefresh.current < 5000) return
    lastRegistryRefresh.current = Date.now()
    routerRef.current.refresh()
  }, [])
  const [snapshot, setSnapshot] = useState(() => snapshotCache.get(repo))
  const [selection, setSelection] = useState<Selection>()
  const [hoverPreview, setHoverPreview] = useState<Selection>()
  const [confirmingAbort, setConfirmingAbort] = useState<string>()
  const [answerStep, setAnswerStep] = useState<AnswerStep>()
  const [error, setError] = useState<string>()
  const [pending, setPending] = useState<string>()
  const [now, setNow] = useState(Date.now())
  const [transcript, setTranscript] = useState<TranscriptPresentation>()
  const [pollPending, setPollPending] = useState(false)
  const answerPending = useRef(false)
  const refresherRef = useRef<DashboardRefresher | undefined>(undefined)
  const repoRef = useRef(repo)
  repoRef.current = repo

  // The refresher owns the poll loop and lives for the component's lifetime, so
  // it must be created before the repository effect below hands it a repo.
  useEffect(() => {
    const refresher = createDashboardRefresher({
      fetch: async (repository, signal) => {
        try {
          return await api.dashboard(repository, signal)
        } catch (cause) {
          if (!signal.aborted && cause instanceof api.WebOperatorError && cause.status === 404) {
            snapshotCache.delete(repository)
            setSnapshot(undefined)
            setTranscript(undefined)
            setSelection(undefined)
            setHoverPreview(undefined)
            setAnswerStep(undefined)
            refreshRegistry()
          }
          throw cause
        }
      },
      visible: () => !document.hidden,
      onSnapshot: (next) => {
        setSnapshot((old) => {
          const reconciled = { ...next, model: reconcileDashboard(old?.model, next.model) }
          snapshotCache.set(repoRef.current, reconciled)
          return reconciled
        })
        setAnswerStep((step) => {
          if (!step || answerPending.current) return step
          const build = next.model.builds.find((row) => row.slug === step.slug)
          return build && build.blockers.length > 0 ? step : undefined
        })
        setError(undefined)
      },
      onError: setError,
      onPendingChange: setPollPending,
    })
    refresherRef.current = refresher
    const onVisibility = () => {
      refresher.onVisibilityChange()
      if (!document.hidden) refreshRegistry()
    }
    window.addEventListener('focus', refreshRegistry)
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      document.removeEventListener('visibilitychange', onVisibility)
      window.removeEventListener('focus', refreshRegistry)
      refresher.dispose()
      refresherRef.current = undefined
    }
  }, [refreshRegistry])

  const requestRefresh = useCallback(() => refresherRef.current?.request() ?? Promise.resolve(), [])

  // Pages are keyed by project, so the repo is fixed for this instance; hand it
  // to the refresher once it exists.
  useEffect(() => {
    refresherRef.current?.setRepo(repo)
  }, [repo])
  // The now-ticker pauses with the document like the refresher above: no
  // interval is scheduled while hidden, and the hidden → visible transition
  // ticks once immediately so the rendered clock is never stale on return.
  useEffect(() => {
    const ticker = createNowTicker({
      visible: () => !document.hidden,
      onTick: () => setNow(Date.now()),
    })
    const onVisibility = () => ticker.onVisibilityChange()
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      document.removeEventListener('visibilitychange', onVisibility)
      ticker.dispose()
    }
  }, [])

  /** After an action, the harvest selection and any abort confirmation return to rest. */
  const releaseSelection = () => {
    setSelection(undefined)
    setConfirmingAbort(undefined)
  }
  const act = async (key: string, operation: () => Promise<unknown>) => {
    setPending(key)
    setError(undefined)
    try {
      await operation()
      await requestRefresh()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
      await requestRefresh()
    } finally {
      setPending(undefined)
      releaseSelection()
    }
  }

  const model = snapshot?.model
  const pageBuild = buildSlug ? model?.builds.find((row) => row.slug === buildSlug) : undefined
  const listHref = projectLink(repo, '')

  const activate = (next: Selection) => {
    setSelection(sameSelection(selection, next) ? undefined : next)
  }
  const openBuild = (slug: string) => router.push(buildLink(repo, slug))
  const control = (slug: string, action: BuildControlAction) => {
    setConfirmingAbort(undefined)
    const key = `${slug}:${action}`
    setPending(key)
    setError(undefined)
    void (async () => {
      let actionError: string | undefined
      let answering = false
      try {
        const result = classifyControlReply(slug, await api.buildControl(repo, slug, { action }))
        if (result.kind === 'answer') {
          answering = true
          setAnswerStep({ slug: result.slug, escalationIds: result.escalationIds, input: '' })
        } else if (result.kind === 'unexpected') {
          actionError = result.text
        }
        await requestRefresh()
      } catch (cause) {
        actionError = cause instanceof Error ? cause.message : String(cause)
        await requestRefresh()
      } finally {
        if (actionError !== undefined) setError(actionError)
        setPending(undefined)
        if (!answering) releaseSelection()
      }
    })()
  }
  const setting = (name: 'intake', enabled: boolean) =>
    void act(name, () => api.setting(repo, name, enabled))
  const bulk = (action: 'pause' | 'resume') =>
    void act(`bulk-${action}`, () => api.bulk(repo, action))
  const harvest = (body: HarvestControl) =>
    void act(`harvest-${body.action}`, () => api.harvest(repo, body))
  const answer = (slug: string, body: OperatorAnswerRequest) => {
    const key = `${slug}:answer`
    setPending(key)
    setError(undefined)
    void (async () => {
      let actionError: string | undefined
      try {
        const result = classifyAnswerReply(slug, await api.answerBuild(repo, slug, body))
        if (result.kind === 'unexpected') actionError = result.text
        await requestRefresh()
      } catch (cause) {
        actionError = cause instanceof Error ? cause.message : String(cause)
        await requestRefresh()
      } finally {
        if (actionError !== undefined) setError(actionError)
        setPending(undefined)
      }
    })()
  }
  const cancelAnswerStep = () => {
    if (answerPending.current) return
    setAnswerStep(undefined)
    releaseSelection()
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
        if (result.kind === 'answered') {
          setAnswerStep(undefined)
          releaseSelection()
        } else actionError = result.text
        await requestRefresh()
      } catch (cause) {
        actionError = cause instanceof Error ? cause.message : String(cause)
        await requestRefresh()
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
    if (isNativeKeyboardActivation(event.key, target)) return
    const editorTarget = Boolean(
      target?.closest('input, textarea, select, [contenteditable="true"]'),
    )
    if (answerStep) {
      const action = answerModeKeyAction(event.key, editorTarget)
      if (action === 'cancel') {
        event.preventDefault()
        cancelAnswerStep()
      } else if (action === 'submit') {
        event.preventDefault()
        submitAnswerStep()
      } else if (action === 'consume') {
        event.preventDefault()
      }
      return
    }
    if (editorTarget) return
    const available = pageBuild ? buildActionAvailability(pageBuild) : undefined
    const repository = repositoryActionAvailability(model)
    const busy = pending !== undefined
    switch (event.key) {
      case 'Enter':
        if (!busy && pageBuild && confirmingAbort === pageBuild.slug) {
          event.preventDefault()
          control(pageBuild.slug, 'abort')
        }
        return
      case 'Escape':
        if (confirmingAbort) setConfirmingAbort(undefined)
        else if (buildSlug) router.push(listHref)
        else setSelection(undefined)
        return
      case 'a':
        if (!busy && pageBuild && available?.abort) setConfirmingAbort(pageBuild.slug)
        return
      case 'p':
        if (busy) return
        if (buildSlug) {
          if (
            pageBuild &&
            (available?.primary === 'pause' || available?.primary === 'cancel-pause')
          )
            control(pageBuild.slug, available.primary)
        } else if (selection?.kind === 'harvest') {
          if (model.harvest?.action) harvest({ action: 'run', run: model.harvest.run })
        } else if (repository.bulkPause) bulk('pause')
        return
      case 'r':
        if (busy) return
        if (buildSlug) {
          if (pageBuild && available?.primary === 'resume') control(pageBuild.slug, 'resume')
        } else if (!selection && repository.bulkResume) bulk('resume')
        return
      case 'd':
        if (!busy && pageBuild && available?.discard) control(pageBuild.slug, 'discard')
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
      isOwner={isOwner}
      isSuperUser={isSuperUser}
      clock={snapshot ? clockText(snapshot.generatedAt, now) : undefined}
      pending={pending !== undefined || pollPending}
      error={repo ? error : 'no repository configured'}
      onRepo={(next) => {
        if (answerPending.current) return
        // A build belongs to one project, so switching from its page lands on the list.
        router.push(projectLink(next, buildSlug ? '' : searchParams.toString()))
      }}
      onSignOut={async () => {
        await fetch('/api/auth/sign-out', { method: 'POST' })
        window.location.assign('/sign-in')
      }}
      controls={
        model ? (
          <DispatcherControls
            model={model}
            pending={pending}
            onSetting={setting}
            onHarvest={harvest}
            onBulk={bulk}
          />
        ) : repo ? (
          <LoadingControls />
        ) : null
      }
    >
      {repo &&
        (buildSlug ? (
          <BuildPageView
            repo={repo}
            slug={buildSlug}
            model={model}
            now={now}
            pending={pending}
            confirmingAbort={confirmingAbort === buildSlug}
            answerStep={answerStep}
            answerPending={answerPending.current}
            transcript={transcript}
            onRowBuildControl={control}
            onRowRequestAbort={setConfirmingAbort}
            onCancelAbort={() => setConfirmingAbort(undefined)}
            onAnswerStepInput={(input) =>
              setAnswerStep((step) => (step ? { ...step, input } : step))
            }
            onSubmitAnswerStep={submitAnswerStep}
            onCancelAnswerStep={cancelAnswerStep}
            onAnswer={answer}
            onTranscript={loadTranscript}
          />
        ) : (
          <BuildsView
            repo={repo}
            model={model}
            now={now}
            pending={pending}
            selection={selection}
            hoverPreview={hoverPreview}
            onActivate={activate}
            onHoverPreview={setHoverPreview}
            onOpenBuild={openBuild}
            onRowBuildControl={control}
            onRowHarvest={(body) => {
              setSelection({ kind: 'harvest' })
              harvest(body)
            }}
          />
        ))}
    </OperatorShell>
  )
}
