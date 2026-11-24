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

export type StepState = 'done' | 'current' | 'provisional' | 'pending'

const stepMark: Record<StepState, { mark: string; name: string }> = {
  done: { mark: '[x]', name: 'done' },
  current: { mark: '[>]', name: 'running' },
  provisional: { mark: '[~]', name: 'provisional' },
  pending: { mark: '[ ]', name: 'pending' },
}

export interface Step {
  name: string
  state: StepState
  /** The step's glyph; defaults to the state's own mark. */
  mark?: string
  /** The parenthesised note, already formatted: `(review, 4m12s/2)`. */
  note?: string
  /** The widest text the note can reach. It sizes the note's reserved slot
   * and is never shown, so a ticking or starting step never rewraps the list. */
  noteSizer?: string
  reason?: string
}

export function StepList({ steps }: { steps: readonly Step[] }) {
  return (
    <ol data-ansi="steps">
      {steps.map((s) => (
        <li key={s.name} data-state={s.state}>
          <span aria-hidden="true" data-ansi="mark">
            {s.mark ?? stepMark[s.state].mark}
          </span>
          <span data-ansi="visually-hidden">{stepMark[s.state].name}: </span>
          <span data-ansi="step-name">{s.name}</span>
          {(s.note !== undefined || s.noteSizer !== undefined) && (
            // The sizer comes first: the slot's baseline is its first item's,
            // so an empty note never changes the line's height.
            <span data-ansi="note-slot" data-flow-slot="">
              {s.noteSizer !== undefined && (
                <span data-ansi="note-sizer" aria-hidden="true">
                  {s.noteSizer}
                </span>
              )}
              <span data-ansi="elapsed">{s.note ?? ''}</span>
            </span>
          )}
          {s.reason !== undefined && <span data-ansi="step-reason"> — {s.reason}</span>}
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
      <p data-ansi="question">
        <span>{question}</span>
      </p>
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
