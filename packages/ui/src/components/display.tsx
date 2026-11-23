import {
  AlertDialog,
  AlertDialogBackdrop,
  AlertDialogClose,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@ui-sdk/react/alert-dialog'
import {
  Menu,
  MenuContent,
  MenuGroupLabel,
  MenuItemIndicator,
  MenuRadioGroup,
  MenuRadioItem,
  MenuTrigger,
} from '@ui-sdk/react/menu'
import type { ReactNode } from 'react'
import { formatDuration } from '../charts/model'
import { withTransition } from './motion'

/** A lifecycle word. Color carries state; the word carries it too. */
export type StateTone = 'live' | 'ok' | 'held' | 'alert' | 'pending'

export function StateWord({ tone, children }: { tone: StateTone; children: ReactNode }) {
  return (
    <span data-ansi="state-word" data-tone={tone} key={String(children)}>
      {children}
    </span>
  )
}

export type StepState = 'done' | 'current' | 'retrying' | 'pending'

const stepMark: Record<StepState, { mark: string; name: string }> = {
  done: { mark: '[x]', name: 'done' },
  current: { mark: '[>]', name: 'running' },
  retrying: { mark: '[~]', name: 'retrying' },
  pending: { mark: '[ ]', name: 'pending' },
}

export interface Step {
  name: string
  state: StepState
  elapsedMs?: number
}

export function StepList({ steps }: { steps: readonly Step[] }) {
  return (
    <ol data-ansi="steps">
      {steps.map((s) => (
        <li key={s.name} data-state={s.state}>
          <span aria-hidden="true" data-ansi="mark">
            {stepMark[s.state].mark}
          </span>
          <span data-ansi="visually-hidden">{stepMark[s.state].name}: </span>
          {s.name}
          {s.elapsedMs !== undefined && (
            <span data-ansi="elapsed"> {formatDuration(s.elapsedMs)}</span>
          )}
        </li>
      ))}
    </ol>
  )
}

/** The Sign-off rule: a bordered region reserved for a human decision. */
export function SignOff({
  kind,
  question,
  children,
}: {
  kind: 'escalation' | 'consent' | 'wait'
  question: ReactNode
  children?: ReactNode
}) {
  return (
    <section data-ansi="sign-off" data-kind={kind}>
      <p data-ansi="question">{question}</p>
      {children}
    </section>
  )
}

/** One or more skeleton lines. Each occupies a full line box of the text it
 * stands in for (sans by default, mono for machine values), so swapping in
 * the real text changes nothing around it. */
export function Placeholder({
  width,
  lines = 1,
  mono = false,
}: {
  width: string
  lines?: number
  mono?: boolean
}) {
  return (
    <span data-ansi="placeholder" data-mono={mono ? '' : undefined} aria-hidden="true">
      {Array.from({ length: lines }, (_, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: identical, static placeholder lines
        <span key={i} style={{ width }} />
      ))}
    </span>
  )
}

export function ConfirmDialog({
  trigger,
  title,
  description,
  confirm,
}: {
  trigger: ReactNode
  title: string
  description: ReactNode
  confirm: string
}) {
  return (
    <AlertDialog>
      <AlertDialogTrigger data-variant="ghost">{trigger}</AlertDialogTrigger>
      <AlertDialogBackdrop />
      <AlertDialogContent>
        <AlertDialogTitle>{title}</AlertDialogTitle>
        <AlertDialogDescription>{description}</AlertDialogDescription>
        <div data-ansi="actions">
          <AlertDialogClose data-variant="danger" value="confirm">
            {confirm}
          </AlertDialogClose>
          <AlertDialogClose data-variant="ghost">Cancel</AlertDialogClose>
        </div>
      </AlertDialogContent>
    </AlertDialog>
  )
}

export type ThemeChoice = 'system' | 'light' | 'dark'

export function ThemeMenu({
  value,
  onValueChange,
}: {
  value: ThemeChoice
  onValueChange: (value: ThemeChoice) => void
}) {
  return (
    <Menu>
      <MenuTrigger data-variant="ghost">Theme</MenuTrigger>
      <MenuContent>
        <MenuRadioGroup
          value={value}
          onValueChange={(v) => withTransition(() => onValueChange(v as ThemeChoice))}
        >
          <MenuGroupLabel>Theme</MenuGroupLabel>
          {(['system', 'light', 'dark'] as const).map((choice) => (
            <MenuRadioItem key={choice} value={choice}>
              <MenuItemIndicator>•</MenuItemIndicator>
              {choice[0]?.toUpperCase()}
              {choice.slice(1)}
            </MenuRadioItem>
          ))}
        </MenuRadioGroup>
      </MenuContent>
    </Menu>
  )
}
